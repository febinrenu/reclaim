/**
 * The D2 exit test (BUILD_PLAN.md §7): the same repository suite runs against both
 * drivers. The PGlite block always runs, against a fresh temp directory per test run.
 * The node-pg block runs only when DATABASE_URL is set — `docker compose up -d` plus
 * `DATABASE_URL=postgresql://reclaim:reclaim_dev_only@localhost:5432/reclaim` — so a
 * plain `npm run test:integration` with no Docker still exercises the whole suite on
 * the embedded driver, and setting DATABASE_URL exercises the identical suite against
 * real Postgres.
 *
 * Every id in this file is freshly randomised per run, so the suite is safe to repeat
 * against a persistent Docker volume without truncating anything first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createNodePgExecutor } from '@/adapters/db/node-pg'
import { createPostgresKv } from '@/adapters/kv/postgres'
import { createMemoryKv } from '@/adapters/kv/memory'
import { runMigrations, listMigrationFiles } from '@/db/migrate'
import type { Transactional } from '@/ports/sql'

import * as customers from '@/repositories/customers.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as groundTruth from '@/repositories/ground-truth.repo'
import * as webhookEvents from '@/repositories/webhook-events.repo'
import * as jobQueue from '@/repositories/job-queue.repo'
import * as actionAttempts from '@/repositories/action-attempts.repo'
import * as recoveryAudit from '@/repositories/recovery-audit.repo'
import * as modelEvaluations from '@/repositories/model-evaluations.repo'
import * as batches from '@/repositories/batches.repo'

import { customerId, transactionId, eventId } from '@/domain/ids'
import { paise } from '@/domain/money'

function uniqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/**
 * Every fixture id in this suite is randomised, which is enough isolation for lookups
 * by id. It is not enough for `job_queue.claimNext`, which deliberately scans for
 * "the next available job" with no id filter — that is the whole point of the query.
 * Against the Docker target, whose volume persists across runs, a stray job left
 * `claimed` with an expired lease by an earlier run has an older `available_at` than
 * anything this run creates, and wins the ordering. Truncating first removes that
 * class of cross-run contamination at the source rather than requiring every test to
 * clean up perfectly after itself.
 */
async function truncateAppTables(sql: Transactional): Promise<void> {
  await sql.query(`
    TRUNCATE
      recovery_audit, model_evaluations, batches, action_attempts, job_queue,
      webhook_events, kv, ground_truth, transactions, customers
  `)
}

function repoSuite(label: string, getSql: () => Transactional) {
  describe(`repositories on ${label}`, () => {
    it('has applied every migration file', async () => {
      const result = await runMigrations(getSql())
      expect(result.alreadyCurrent).toBe(true)
      expect(result.applied).toEqual([])
      expect(listMigrationFiles().length).toBeGreaterThanOrEqual(5)
    })

    it('upserts a customer and merges fields on conflict', async () => {
      const sql = getSql()
      const id = customerId(uniqueId('cust'))
      const created = await customers.upsertCustomer(sql, { id, name: 'Asha Rao' })
      expect(created.name).toBe('Asha Rao')
      expect(created.ltvAmount).toBe(0)

      const merged = await customers.upsertCustomer(sql, { id, phone: '+91-90000-00000' })
      expect(merged.name).toBe('Asha Rao') // untouched field survives the merge
      expect(merged.phone).toBe('+91-90000-00000')

      const found = await customers.findCustomerById(sql, id)
      expect(found?.id).toBe(id)
      expect(await customers.findCustomerById(sql, customerId(uniqueId('nope')))).toBeNull()
    })

    it('records customer outcomes without a separate reconciliation pass', async () => {
      const sql = getSql()
      const id = customerId(uniqueId('cust'))
      await customers.upsertCustomer(sql, { id })
      await customers.recordCustomerOutcome(sql, id, { recovered: true, deltaLtvPaise: 50_000 })
      const found = await customers.findCustomerById(sql, id)
      expect(found?.successfulPayments).toBe(1)
      expect(found?.failedPayments).toBe(0)
      expect(found?.ltvAmount).toBe(50_000)
    })

    it('upserts a transaction and updates its status as new events arrive', async () => {
      const sql = getSql()
      const custId = customerId(uniqueId('cust'))
      await customers.upsertCustomer(sql, { id: custId })
      const txnId = transactionId(uniqueId('pay'))

      const created = await transactionsRepo.upsertTransaction(sql, {
        id: txnId,
        customerId: custId,
        amount: paise(250_00),
        status: 'failed',
        errorCode: 'BAD_REQUEST_ERROR',
      })
      expect(created.status).toBe('failed')
      expect(created.amount).toBe(25000)
      expect(created.scenario).toBe('subscription')

      await transactionsRepo.updateTransactionStatus(sql, txnId, 'recovered')
      const found = await transactionsRepo.findTransactionById(sql, txnId)
      expect(found?.status).toBe('recovered')

      const first = await transactionsRepo.incrementRetryCount(sql, txnId, 3)
      expect(first.retryCount).toBe(1)
      expect(first.incremented).toBe(true)

      // The atomic cap itself, the real point of this function's own guard:
      // incrementing 5 more times against a cap of 3 must never push the
      // stored value past 3, regardless of how many calls race it. Once the
      // cap is reached, `incremented` must flip to false — the signal a
      // caller uses to know its own decision raced past the stopping rule.
      let last = first
      for (let i = 0; i < 5; i++) {
        last = await transactionsRepo.incrementRetryCount(sql, txnId, 3)
      }
      expect(last.retryCount).toBe(3)
      expect(last.incremented).toBe(false)
      expect((await transactionsRepo.findTransactionById(sql, txnId))?.retryCount).toBe(3)

      const recovered = await transactionsRepo.listByStatus(sql, 'recovered')
      expect(recovered.some((t) => t.id === txnId)).toBe(true)
    })

    it('caps retry_count atomically under genuine concurrent callers, not just sequential ones', async () => {
      // The real scenario docs/INCIDENTS.md records: several concurrent
      // callers (in production, several `after()` webhook kicks racing the
      // embedded poller for the same transaction) all incrementing at once.
      // `Promise.all` is what actually exercises the WHERE-guarded UPDATE's
      // atomicity — 20 sequential awaits would never race each other at all.
      const sql = getSql()
      const txnId = transactionId(uniqueId('pay'))
      await transactionsRepo.upsertTransaction(sql, { id: txnId, amount: paise(100_00), status: 'failed' })

      const cap = 3
      const results = await Promise.all(
        Array.from({ length: 20 }, () => transactionsRepo.incrementRetryCount(sql, txnId, cap)),
      )
      expect(Math.max(...results.map((r) => r.retryCount))).toBe(cap)
      expect((await transactionsRepo.findTransactionById(sql, txnId))?.retryCount).toBe(cap)
      // Exactly `cap` of the 20 concurrent callers actually incremented — the
      // rest lost the race and must know it via `incremented: false`, which is
      // what lets a caller (process-event.ts) tell a genuine attempt apart
      // from a decision that raced past the stopping rule after the fact.
      expect(results.filter((r) => r.incremented).length).toBe(cap)
    })

    it('records a bank on first insert and never overwrites it on a later conflict, same treatment as card_id', async () => {
      const sql = getSql()
      const txnId = transactionId(uniqueId('pay'))
      await transactionsRepo.upsertTransaction(sql, {
        id: txnId,
        amount: paise(100_00),
        status: 'failed',
        bank: 'HDFC',
      })
      // A later event for the same transaction tries to set a different bank —
      // must not win, exactly like card_id's own documented contract.
      const updated = await transactionsRepo.upsertTransaction(sql, {
        id: txnId,
        amount: paise(100_00),
        status: 'failed',
        bank: 'ICICI',
      })
      expect(updated.bank).toBe('HDFC')
    })

    it('computes a real bank failure rate over a trailing window, and returns null with zero history', async () => {
      const sql = getSql()
      const bank = uniqueId('bank') // unique per test run so runs never contaminate each other
      // +5 minutes of slack on every upper bound in this test: comparing an
      // absolute JS timestamp against the database's own `created_at` is
      // exactly the class of clock-skew risk job-queue.repo.ts's
      // `availableInSec` exists to sidestep for scheduling — a real caller
      // never reads a window ending this close to writes made in the same
      // breath, only a test does.
      expect(await transactionsRepo.bankRecentFailRate(sql, bank, Date.now() - 86_400_000, Date.now() + 5 * 60_000)).toBeNull()

      for (let i = 0; i < 3; i++) {
        await transactionsRepo.upsertTransaction(sql, {
          id: transactionId(uniqueId('pay')),
          amount: paise(100_00),
          status: 'failed',
          bank,
        })
      }
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(uniqueId('pay')),
        amount: paise(100_00),
        status: 'recovered',
        bank,
      })

      const result = await transactionsRepo.bankRecentFailRate(sql, bank, Date.now() - 86_400_000, Date.now() + 5 * 60_000)
      expect(result?.n).toBe(4)
      expect(result?.rate).toBeCloseTo(0.75, 5) // 3 failed of 4 total

      // Outside the window entirely — same bank, but the window excludes it.
      const future = Date.now() + 10 * 86_400_000
      const outside = await transactionsRepo.bankRecentFailRate(sql, bank, future, future + 86_400_000)
      expect(outside).toBeNull()
    })

    it("computes a customer's own amount stats with a real stddev, distinct from a lone-point stddev of zero", async () => {
      const sql = getSql()
      const custId = customerId(uniqueId('cust'))
      const excludeId = transactionId(uniqueId('pay'))
      await customers.upsertCustomer(sql, { id: custId })

      const single = transactionId(uniqueId('pay'))
      await transactionsRepo.upsertTransaction(sql, { id: single, customerId: custId, amount: paise(500_00), status: 'failed' })
      const lonePoint = await transactionsRepo.customerAmountStats(sql, custId, excludeId, Date.now() + 5 * 60_000)
      expect(lonePoint?.n).toBe(1)
      expect(lonePoint?.stddev).toBe(0) // no spread to measure with one point

      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(uniqueId('pay')),
        customerId: custId,
        amount: paise(700_00),
        status: 'failed',
      })
      const withSpread = await transactionsRepo.customerAmountStats(sql, custId, excludeId, Date.now() + 5 * 60_000)
      expect(withSpread?.n).toBe(2)
      expect(withSpread?.stddev).toBeGreaterThan(0)

      const noHistory = await transactionsRepo.customerAmountStats(sql, customerId(uniqueId('cust')), excludeId, Date.now())
      expect(noHistory).toBeNull()
    })

    it('computes a real global amount population and a real customer LTV population', async () => {
      const sql = getSql()
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(uniqueId('pay')),
        amount: paise(1_000_00),
        status: 'failed',
      })
      const global = await transactionsRepo.globalAmountStats(sql, Date.now() + 5 * 60_000)
      expect(global).not.toBeNull()
      expect(global!.n).toBeGreaterThan(0)

      const custId = customerId(uniqueId('cust'))
      await customers.upsertCustomer(sql, { id: custId })
      await customers.recordCustomerOutcome(sql, custId, { recovered: true, deltaLtvPaise: 250_00 })
      const ltvPop = await customers.ltvPopulationStats(sql)
      expect(ltvPop).not.toBeNull()
      expect(ltvPop!.n).toBeGreaterThan(0)
    })

    it('counts only contact-requiring attempts, only for this customer, only inside the window', async () => {
      const sql = getSql()
      const custId = customerId(uniqueId('cust'))
      await customers.upsertCustomer(sql, { id: custId })
      const txnId = transactionId(uniqueId('pay'))
      await transactionsRepo.upsertTransaction(sql, { id: txnId, customerId: custId, amount: paise(100_00), status: 'failed' })

      // A contact-requiring attempt, inside the window.
      await sql.transaction((tx) =>
        actionAttempts.createIntent(tx, {
          transactionId: txnId,
          eventId: null,
          action: 'WHATSAPP_NUDGE',
          attemptGeneration: 1,
          idempotencyKey: uniqueId('idem'),
          executionMode: 'dry_run',
        }),
      )
      // A non-contact attempt (must never count, regardless of window).
      await sql.transaction((tx) =>
        actionAttempts.createIntent(tx, {
          transactionId: txnId,
          eventId: null,
          action: 'RETRY_LATER',
          attemptGeneration: 1,
          idempotencyKey: uniqueId('idem'),
          executionMode: 'dry_run',
        }),
      )
      // A contact-requiring attempt, backdated outside the 7-day window — this
      // is the only PAYMENT_LINK attempt against this (freshly unique) txnId,
      // so the backdate targets it unambiguously.
      await sql.transaction((tx) =>
        actionAttempts.createIntent(tx, {
          transactionId: txnId,
          eventId: null,
          action: 'PAYMENT_LINK',
          attemptGeneration: 1,
          idempotencyKey: uniqueId('idem'),
          executionMode: 'dry_run',
        }),
      )
      await sql.query(
        "UPDATE action_attempts SET created_at = now() - interval '10 days' WHERE transaction_id = $1 AND action = 'PAYMENT_LINK'",
        [txnId],
      )

      // +5 minutes of slack on the upper bound: this function compares an
      // absolute JS timestamp against the database's own `created_at`
      // (`now()` at insert time), and a real, networked database's clock is
      // never guaranteed to agree with this machine's to the millisecond —
      // the same class of issue job-queue.repo.ts's `availableInSec` exists
      // to sidestep for scheduling. A real caller never hits this: it always
      // reads a window ending at "now" well after the writes inside it
      // actually committed, not immediately after inserting them in the same
      // breath a test does.
      const count = await actionAttempts.contactsInWindow(
        sql,
        custId,
        Date.now() - 7 * 86_400_000,
        Date.now() + 5 * 60_000,
        ['WHATSAPP_NUDGE', 'PAYMENT_LINK'],
      )
      expect(count).toBe(1) // only the in-window WHATSAPP_NUDGE
    })

    it('stores oracle ground truth without it depending on any decision code', async () => {
      const sql = getSql()
      const txnId = transactionId(uniqueId('pay'))
      await transactionsRepo.upsertTransaction(sql, {
        id: txnId,
        amount: paise(1_000_00),
        status: 'failed',
      })
      await groundTruth.saveGroundTruth(sql, {
        transactionId: txnId,
        payload: { pTrueByAction: { DO_NOTHING: 0.11, RETRY_NOW: 0.42 } },
      })
      const found = await groundTruth.findGroundTruth(sql, txnId)
      expect(found?.payload).toEqual({ pTrueByAction: { DO_NOTHING: 0.11, RETRY_NOW: 0.42 } })
    })

    it('is the idempotency authority: the same event id inserts exactly once', async () => {
      const sql = getSql()
      const evtId = eventId(uniqueId('evt'))
      const first = await webhookEvents.insertIfAbsent(sql, {
        eventId: evtId,
        eventType: 'payment.failed',
        payload: { id: evtId, event: 'payment.failed' },
      })
      const second = await webhookEvents.insertIfAbsent(sql, {
        eventId: evtId,
        eventType: 'payment.failed',
        payload: { id: evtId, event: 'payment.failed' },
      })
      expect(first).toBe(true)
      expect(second).toBe(false)
      expect((await webhookEvents.findWebhookEvent(sql, evtId))?.eventType).toBe('payment.failed')
    })

    it('enqueues with dedupe, claims with SKIP LOCKED semantics, and completes', async () => {
      const sql = getSql()
      const dedupeKey = uniqueId('evt')

      const enq1 = await sql.transaction((tx) =>
        jobQueue.enqueue(tx, { kind: 'process_event', dedupeKey, payload: { n: 1 } }),
      )
      expect(enq1.created).toBe(true)

      // Re-enqueueing the same dedupe key must not create a second job.
      const enq2 = await sql.transaction((tx) =>
        jobQueue.enqueue(tx, { kind: 'process_event', dedupeKey, payload: { n: 2 } }),
      )
      expect(enq2.created).toBe(false)
      expect(enq2.jobId).toBe(enq1.jobId)

      const claimed = await sql.transaction((tx) =>
        jobQueue.claimNext(tx, { workerId: 'test-worker', leaseSeconds: 30 }),
      )
      expect(claimed?.id).toBe(enq1.jobId)
      expect(claimed?.status).toBe('claimed')
      expect(claimed?.attempts).toBe(1)

      await sql.transaction((tx) => jobQueue.complete(tx, enq1.jobId, { ok: true }))
      const done = await jobQueue.findJobById(sql, enq1.jobId)
      expect(done?.status).toBe('done')
      expect(done?.result).toEqual({ ok: true })
    })

    it('reclaims a job whose lease has expired without a separate sweeper', async () => {
      const sql = getSql()
      const dedupeKey = uniqueId('evt')
      const { jobId } = await sql.transaction((tx) =>
        jobQueue.enqueue(tx, { kind: 'process_event', dedupeKey, payload: {} }),
      )

      // Claim with an already-expired lease by asking for a negative lease window.
      const firstClaim = await sql.transaction((tx) =>
        jobQueue.claimNext(tx, { workerId: 'worker-a', leaseSeconds: -1 }),
      )
      expect(firstClaim?.id).toBe(jobId)

      const reclaimed = await sql.transaction((tx) =>
        jobQueue.claimNext(tx, { workerId: 'worker-b', leaseSeconds: 30 }),
      )
      expect(reclaimed?.id).toBe(jobId)
      expect(reclaimed?.attempts).toBe(2)
    })

    it('creates a T3 intent row, looks it up by idempotency key, and settles it', async () => {
      const sql = getSql()
      const txnId = transactionId(uniqueId('pay'))
      await transactionsRepo.upsertTransaction(sql, { id: txnId, amount: paise(100_00), status: 'failed' })
      const key = uniqueId('idem')

      const intent = await sql.transaction((tx) =>
        actionAttempts.createIntent(tx, {
          transactionId: txnId,
          eventId: null,
          action: 'WHATSAPP_NUDGE',
          attemptGeneration: 1,
          idempotencyKey: key,
          executionMode: 'dry_run',
          requestBody: { to: '+91...' },
        }),
      )
      expect(intent.status).toBe('pending')

      const found = await actionAttempts.findByIdempotencyKey(sql, key)
      expect(found?.id).toBe(intent.id)

      await sql.transaction((tx) =>
        actionAttempts.settleIntent(tx, intent.id, { status: 'settled', result: { sent: true } }),
      )
      const settled = await actionAttempts.findByIdempotencyKey(sql, key)
      expect(settled?.status).toBe('settled')
      expect(settled?.result).toEqual({ sent: true })
    })

    it('cannot hold two audit rows for one event and generation', async () => {
      const sql = getSql()
      const evtId = eventId(uniqueId('evt'))
      const decisionInput = { s: { amount: 10000 }, policy: 'default' }

      await recoveryAudit.insertAuditRow(sql, {
        eventId: evtId,
        attemptGeneration: 1,
        transactionId: null,
        decisionInput,
        chosenAction: 'DO_NOTHING',
        executionMode: 'dry_run',
      })

      await expect(
        recoveryAudit.insertAuditRow(sql, {
          eventId: evtId,
          attemptGeneration: 1,
          transactionId: null,
          decisionInput,
          chosenAction: 'RETRY_NOW',
          executionMode: 'dry_run',
        }),
      ).rejects.toThrow()

      // A different generation for the same event is a different row, by design.
      const secondGen = await recoveryAudit.insertAuditRow(sql, {
        eventId: evtId,
        attemptGeneration: 2,
        transactionId: null,
        decisionInput,
        chosenAction: 'RETRY_NOW',
        executionMode: 'dry_run',
      })
      expect(secondGen.attemptGeneration).toBe(2)

      const found = await recoveryAudit.findAuditByEvent(sql, evtId, 1)
      expect(found?.chosenAction).toBe('DO_NOTHING')
      expect(found?.decisionInput).toEqual(decisionInput)
    })

    it('records a model evaluation receipt', async () => {
      const sql = getSql()
      const modelName = uniqueId('recovery_scorer')
      await modelEvaluations.recordEvaluation(sql, {
        modelName,
        evalSetSize: 1800,
        brierScore: 0.1897,
        precisionScore: 0.62,
        recallScore: 0.68,
      })
      const rows = await modelEvaluations.listByModel(sql, modelName)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.brierScore).toBeCloseTo(0.1897)
    })

    it('tracks a batch from running to done with its counters', async () => {
      const sql = getSql()
      const scenario = uniqueId('subscription')
      const batch = await batches.startBatch(sql, { scenario, total: 10, policy: { nudgeCost: 35 } })
      expect(batch.status).toBe('running')

      await batches.bumpBatchCounters(sql, batch.id, { claimed: 10, done: 9, failed: 1 })
      await batches.finishBatch(sql, batch.id, 'done')

      const found = await batches.findBatchById(sql, batch.id)
      expect(found?.status).toBe('done')
      expect(found?.done).toBe(9)
      expect(found?.failed).toBe(1)
      expect(found?.finishedAt).not.toBeNull()
    })

    it('KV: setIfAbsent is atomic, and an expired key is treated as absent', async () => {
      const sql = getSql()
      const kv = createPostgresKv(sql)
      const key = uniqueId('lock')

      expect(await kv.setIfAbsent(key, '1', 60)).toBe(true)
      expect(await kv.setIfAbsent(key, '1', 60)).toBe(false)
      expect(await kv.get(key)).toBe('1')

      const expiredKey = uniqueId('lock')
      expect(await kv.setIfAbsent(expiredKey, '1', -1)).toBe(true) // already expired
      expect(await kv.get(expiredKey)).toBeNull()
      expect(await kv.setIfAbsent(expiredKey, '2', 60)).toBe(true) // wins again

      await kv.del(key)
      expect(await kv.get(key)).toBeNull()
    })

    it('KV: incrWithTtl sets the TTL once, on creation, not on every increment', async () => {
      const sql = getSql()
      const kv = createPostgresKv(sql)
      const key = uniqueId('counter')

      expect(await kv.incrWithTtl(key, 60)).toBe(1)
      expect(await kv.incrWithTtl(key, 60)).toBe(2)
      expect(await kv.incrWithTtl(key, 60)).toBe(3)
    })
  })
}

// ── PGlite: always runs, against a throwaway temp directory ──────────────────────
describe.sequential('pglite driver', () => {
  let dir: string
  let sql: Transactional

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-pglite-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
    await truncateAppTables(sql) // fresh per run even so; see truncateAppTables above
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  repoSuite('pglite', () => sql)

  it('the in-memory KV adapter matches the same contract', async () => {
    const kv = createMemoryKv()
    const key = uniqueId('lock')
    expect(await kv.setIfAbsent(key, '1', 60)).toBe(true)
    expect(await kv.setIfAbsent(key, '1', 60)).toBe(false)
    expect(await kv.incrWithTtl(uniqueId('counter'), 60)).toBe(1)
  })
})

// ── node-pg: only when a real Postgres is reachable ───────────────────────────────
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(databaseUrl === undefined).sequential('node-pg driver', () => {
  let sql: Transactional

  beforeAll(async () => {
    sql = createNodePgExecutor(databaseUrl!)
    await runMigrations(sql)
    await truncateAppTables(sql) // this target's volume persists across runs
  })

  afterAll(async () => {
    await sql.close()
  })

  repoSuite('node-pg', () => sql)
})

// vitest's skipIf above reports the whole block as skipped when DATABASE_URL is unset;
// this just makes the reason visible without a passing/skipped assertion of its own.
if (databaseUrl === undefined) {
  console.log('  node-pg driver: skipped (DATABASE_URL not set — see docker-compose.yml)')
}
