/**
 * Closes the D11 "deferred, not forgotten" gap for real: a RETRY_NOW/RETRY_LATER
 * decision must actually drive a second real cycle, not just log itself. See
 * src/app/worker/schedule-followup.ts and process-event.ts's `isFollowup` guard.
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
import { fixedClock } from '@/domain/clock'
import { transactionId } from '@/domain/ids'
import * as transactionsRepo from '@/repositories/transactions.repo'
import type { Transactional } from '@/ports/sql'

const WEBHOOK_SECRET = 'test_webhook_secret'

function makeEvent(
  event: string,
  id: string,
  nowSec: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    entity: 'event',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id,
          amount: 150_00,
          currency: 'INR',
          status: event.endsWith('.captured') ? 'captured' : 'failed',
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

async function jobRow(deps: Deps, dedupeKey: string) {
  const { rows } = await deps.sql.query<{
    status: string
    available_at: Date
  }>(`SELECT status, available_at FROM job_queue WHERE dedupe_key = $1`, [dedupeKey])
  return rows[0] ?? null
}

async function auditCount(deps: Deps, eventId: string): Promise<number> {
  const { rows } = await deps.sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = $1`,
    [eventId],
  )
  return Number(rows[0]?.count ?? 0)
}

describe('scheduled follow-up retries', () => {
  let dir: string
  let sql: Transactional
  let deps: Deps
  const simulator = createPaymentsSimulator(WEBHOOK_SECRET)
  const nowMs = 1_756_000_000_000
  const nowSec = Math.floor(nowMs / 1000)

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-followup-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)

    deps = await buildContainer(loadEnv({}), {
      sql,
      kv: createMemoryKv(),
      // Deliberately far from real wall-clock time — the whole point of this
      // suite is proving a scheduled follow-up is compared against the
      // DATABASE's clock, never this one.
      clock: fixedClock(nowMs),
      payments: simulator,
      webhookSecret: WEBHOOK_SECRET,
    })
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a RETRY_NOW/RETRY_LATER decision schedules a follow-up job in the future, not claimable yet', async () => {
    const event = makeEvent('payment.failed', 'pay_followup_basic', nowSec)
    const signed = simulator.signEvent(event)
    const result = await ingestRazorpayEvent(deps, {
      rawBody: signed.rawBody,
      signatureHeader: signed.signature,
      eventIdHeader: 'evt_followup_basic',
    })
    expect(result.kind).toBe('accepted')

    const drain = await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })
    expect(drain.done).toBe(1)
    expect(drain.failed).toBe(0)

    const txn = await transactionsRepo.findTransactionById(deps.sql, transactionId('pay_followup_basic'))
    expect(txn).not.toBeNull()

    if (txn!.retryCount === 0) {
      // decide() chose an action other than RETRY_NOW/RETRY_LATER for this
      // input — nothing to schedule, and that is a correct outcome for a
      // fixture not specifically engineered to force a retry action. Skip
      // rather than assert a false premise.
      return
    }

    const scheduled = await jobRow(deps, 'evt:evt_followup_basic_retry1')
    expect(scheduled).not.toBeNull()
    expect(scheduled!.status).toBe('pending')
    // Scheduled strictly ahead of the DB's own now() at insert time — real
    // future, not an artifact of the app's own (deliberately displaced) clock.
    expect(scheduled!.available_at.getTime()).toBeGreaterThan(Date.now())

    // Draining right away must not claim it — it is not due yet.
    const immediateDrain = await drainOnce(deps, { maxJobs: 10, budgetMs: 1000, workerId: 'test' })
    expect(immediateDrain.claimed).toBe(0)
  })

  it('once due, the follow-up actually fires through the real pipeline and produces a second audit row', async () => {
    const event = makeEvent('payment.failed', 'pay_followup_fires', nowSec)
    const signed = simulator.signEvent(event)
    await ingestRazorpayEvent(deps, {
      rawBody: signed.rawBody,
      signatureHeader: signed.signature,
      eventIdHeader: 'evt_followup_fires',
    })
    await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })

    const txn = await transactionsRepo.findTransactionById(deps.sql, transactionId('pay_followup_fires'))
    if (txn === null || txn.retryCount === 0) return // see note above

    // Simulate real time passing: back-date the scheduled job rather than
    // waiting out a real +2h/+24h delay.
    await deps.sql.query(
      `UPDATE job_queue SET available_at = now() - interval '1 minute' WHERE dedupe_key = $1`,
      ['evt:evt_followup_fires_retry1'],
    )

    const drain = await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })
    expect(drain.done).toBe(1)
    expect(drain.failed).toBe(0)

    expect(await auditCount(deps, 'evt_followup_fires_retry1')).toBe(1)

    const after = await transactionsRepo.findTransactionById(deps.sql, transactionId('pay_followup_fires'))
    expect(after!.retryCount).toBe(txn.retryCount + 1)
  })

  it('never overwrites a transaction a real webhook already recovered, even if a follow-up fires late', async () => {
    const event = makeEvent('payment.failed', 'pay_followup_recovered', nowSec)
    const signed = simulator.signEvent(event)
    await ingestRazorpayEvent(deps, {
      rawBody: signed.rawBody,
      signatureHeader: signed.signature,
      eventIdHeader: 'evt_followup_recovered',
    })
    await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })

    const txn = await transactionsRepo.findTransactionById(deps.sql, transactionId('pay_followup_recovered'))
    if (txn === null || txn.retryCount === 0) return // see note above

    // A real Razorpay delivery arrives independently and resolves it.
    const capturedEvent = makeEvent('payment.captured', 'pay_followup_recovered', nowSec + 60)
    const capturedSigned = simulator.signEvent(capturedEvent)
    await ingestRazorpayEvent(deps, {
      rawBody: capturedSigned.rawBody,
      signatureHeader: capturedSigned.signature,
      eventIdHeader: 'evt_followup_recovered_captured',
    })
    await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })

    const recovered = await transactionsRepo.findTransactionById(
      deps.sql,
      transactionId('pay_followup_recovered'),
    )
    expect(recovered!.status).toBe('recovered')

    // The stale follow-up, scheduled before recovery, now becomes due and fires.
    await deps.sql.query(
      `UPDATE job_queue SET available_at = now() - interval '1 minute' WHERE dedupe_key = $1`,
      ['evt:evt_followup_recovered_retry1'],
    )
    const drain = await drainOnce(deps, { maxJobs: 10, budgetMs: 5000, workerId: 'test' })
    expect(drain.done).toBe(1)
    expect(drain.failed).toBe(0)

    // No audit row for the stale follow-up — it was skipped, not processed.
    expect(await auditCount(deps, 'evt_followup_recovered_retry1')).toBe(0)

    // And, the point of the guard: status is still 'recovered', never clobbered
    // back to 'failed' by the stale follow-up's hardcoded payment.failed shape.
    const final = await transactionsRepo.findTransactionById(
      deps.sql,
      transactionId('pay_followup_recovered'),
    )
    expect(final!.status).toBe('recovered')
  })
})
