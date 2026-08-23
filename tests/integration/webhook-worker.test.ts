/**
 * The D6 exit test, checked directly against real PGlite: a signed event is
 * ingested, the worker drains it, and exactly one audit row exists — including
 * under concurrent duplicate posts (BUILD_PLAN.md §5's idempotency guarantee) and
 * across a simulated crash-and-reclaim between T3 and T4 (§5.6's crash matrix).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createMemoryKv } from '@/adapters/kv/memory'
import { createPaymentsSimulator } from '@/adapters/payments/simulator'
import { runMigrations } from '@/db/migrate'
import { loadEnv } from '@/config/env'
import { buildContainer, type Deps } from '@/config/container'
import { ingestRazorpayEvent } from '@/app/webhook/ingest-razorpay-event'
import { drainOnce } from '@/app/worker/drain'
import { processEvent } from '@/app/worker/process-event'
import * as jobQueueRepo from '@/repositories/job-queue.repo'
import { fixedClock } from '@/domain/clock'
import type { Transactional } from '@/ports/sql'

const WEBHOOK_SECRET = 'test_webhook_secret'

async function countWhere(deps: Deps, table: 'action_attempts' | 'recovery_audit', eventId: string): Promise<number> {
  const { rows } = await deps.sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE event_id = $1`,
    [eventId],
  )
  return Number(rows[0]?.count ?? 0)
}

function makeEvent(id: string, nowSec: number, overrides: Record<string, unknown> = {}) {
  return {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id,
          amount: 150_00,
          currency: 'INR',
          status: 'failed',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'test event',
          customer_id: `cust_${id}`,
          ...overrides,
        },
      },
    },
    created_at: nowSec,
  }
}

describe('webhook ingestion and the worker', () => {
  let dir: string
  let sql: Transactional
  let deps: Deps
  const simulator = createPaymentsSimulator(WEBHOOK_SECRET)
  const nowMs = 1_756_000_000_000
  const nowSec = Math.floor(nowMs / 1000)

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-webhook-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)

    deps = await buildContainer(loadEnv({}), {
      sql,
      kv: createMemoryKv(),
      clock: fixedClock(nowMs),
      payments: simulator,
      webhookSecret: WEBHOOK_SECRET,
    })
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an unsigned request', async () => {
    const event = makeEvent('pay_unsigned', nowSec)
    const rawBody = JSON.stringify(event)
    const result = await ingestRazorpayEvent(deps, {
      rawBody,
      signatureHeader: 'not-the-real-signature',
      eventIdHeader: 'evt_unsigned',
    })
    expect(result.kind).toBe('invalid_signature')
  })

  it('rejects a stale replay', async () => {
    const event = makeEvent('pay_stale', nowSec - 1000)
    const signed = simulator.signEvent(event)
    const result = await ingestRazorpayEvent(deps, {
      rawBody: signed.rawBody,
      signatureHeader: signed.signature,
      eventIdHeader: 'evt_stale',
    })
    expect(result).toEqual({ kind: 'replay_rejected', reason: 'stale' })
  })

  it('accepts a genuine event, enqueues it, and the worker drains it into exactly one audit row', async () => {
    const event = makeEvent('pay_happy_path', nowSec)
    const signed = simulator.signEvent(event)
    const result = await ingestRazorpayEvent(deps, {
      rawBody: signed.rawBody,
      signatureHeader: signed.signature,
      eventIdHeader: 'evt_happy_path',
    })
    expect(result.kind).toBe('accepted')

    const drain = await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })
    expect(drain.done).toBe(1)
    expect(drain.failed).toBe(0)

    const { rows } = await deps.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = $1`,
      ['evt_happy_path'],
    )
    expect(Number(rows[0]?.count)).toBe(1)
  })

  it('the same event delivered concurrently, duplicated, produces exactly one audit row', async () => {
    const event = makeEvent('pay_concurrent_dup', nowSec)
    const signed = simulator.signEvent(event)
    const post = () =>
      ingestRazorpayEvent(deps, {
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        eventIdHeader: 'evt_concurrent_dup',
      })

    // Twenty identical concurrent deliveries — modelling Razorpay's own retry
    // behaviour racing a slow first response, all hitting T1 at once.
    const results = await Promise.all(Array.from({ length: 20 }, () => post()))
    const accepted = results.filter((r) => r.kind === 'accepted')
    const duplicates = results.filter((r) => r.kind === 'duplicate')
    expect(accepted).toHaveLength(1)
    expect(duplicates).toHaveLength(19)

    await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })

    const { rows } = await deps.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = $1`,
      ['evt_concurrent_dup'],
    )
    expect(Number(rows[0]?.count)).toBe(1)
  })

  it('re-draining an already-settled job is a safe no-op (idempotent reclaim)', async () => {
    const event = makeEvent('pay_redrain', nowSec)
    const signed = simulator.signEvent(event)
    await ingestRazorpayEvent(deps, {
      rawBody: signed.rawBody,
      signatureHeader: signed.signature,
      eventIdHeader: 'evt_redrain',
    })
    await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })

    // Nothing left to claim — draining again must not error or duplicate anything.
    const second = await drainOnce(deps, { maxJobs: 10, budgetMs: 1000, workerId: 'test' })
    expect(second.claimed).toBe(0)

    const { rows } = await deps.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = $1`,
      ['evt_redrain'],
    )
    expect(Number(rows[0]?.count)).toBe(1)
  })

  it(
    'reclaiming after a crash between T3 (intent committed) and T4 (settle) never ' +
      'double-executes, and produces exactly one audit row',
    async () => {
      const event = makeEvent('pay_crash_recovery', nowSec)
      const signed = simulator.signEvent(event)
      const ingestResult = await ingestRazorpayEvent(deps, {
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        eventIdHeader: 'evt_crash_recovery',
      })
      expect(ingestResult.kind).toBe('accepted')

      const crashDeps: Deps = { ...deps, env: { ...deps.env, RECLAIM_CRASH_AFTER: 'intent' } }

      // leaseSeconds: -1 makes the lease already-expired the instant it is
      // claimed, so the "restart" below can reclaim it immediately rather than
      // waiting out a real lease window — the same trick D2's own
      // repositories.test.ts uses for "reclaims a job whose lease has expired".
      const job = await deps.sql.transaction((tx) =>
        jobQueueRepo.claimNext(tx, { workerId: 'crash-test', leaseSeconds: -1 }),
      )
      expect(job).not.toBeNull()

      // Simulate the real crash: RECLAIM_CRASH_AFTER=intent calls process.exit(1)
      // immediately after T3 commits. Stubbed to throw instead of actually killing
      // the test runner, which is what lets this exercise the *real* code path
      // (T1 through T3, then the exact injection point) rather than a hand-rolled
      // approximation of it.
      const originalExit = process.exit
      let crashed = false
      process.exit = ((_code?: number) => {
        crashed = true
        throw new Error('__simulated_crash__')
      }) as never
      try {
        await expect(processEvent(crashDeps, job!)).rejects.toThrow('__simulated_crash__')
      } finally {
        process.exit = originalExit
      }
      expect(crashed).toBe(true)

      // T3 committed (one intent row, still pending); T4 never ran (no audit row yet).
      const attemptsAfterCrash = await countWhere(deps, 'action_attempts', 'evt_crash_recovery')
      expect(attemptsAfterCrash).toBe(1)
      expect(await countWhere(deps, 'recovery_audit', 'evt_crash_recovery')).toBe(0)

      // "Restart": a fresh drainOnce (or, here, a direct reclaim) picks the same
      // job back up, sees the existing intent by idempotency key, and — being
      // dry_run — discards and redoes rather than blindly re-executing.
      const reclaimed = await deps.sql.transaction((tx) =>
        jobQueueRepo.claimNext(tx, { workerId: 'crash-test-restart', leaseSeconds: 30 }),
      )
      expect(reclaimed).not.toBeNull()
      expect(reclaimed?.id).toBe(job?.id)
      expect(reclaimed?.attempts).toBe(2)

      await processEvent(deps, reclaimed!) // no crash flag this time — runs to completion

      // Still exactly one intent — reclaimed and reused, never duplicated — and
      // now exactly one audit row.
      expect(await countWhere(deps, 'action_attempts', 'evt_crash_recovery')).toBe(1)
      expect(await countWhere(deps, 'recovery_audit', 'evt_crash_recovery')).toBe(1)
    },
  )

  it('reports p95 latency scaffolding sanely: ingest is well under the 800ms hard budget', async () => {
    const timings: number[] = []
    for (let i = 0; i < 10; i++) {
      const event = makeEvent(`pay_latency_${i}`, nowSec)
      const signed = simulator.signEvent(event)
      const start = performance.now()
      await ingestRazorpayEvent(deps, {
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        eventIdHeader: `evt_latency_${i}`,
      })
      timings.push(performance.now() - start)
    }
    for (const t of timings) expect(t).toBeLessThan(800)
  })
})
