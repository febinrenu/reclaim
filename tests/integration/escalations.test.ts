/**
 * The escalation queue, against real PGlite.
 *
 * Every state transition in `escalations.repo.ts` is one conditional UPDATE that names
 * the status it expects in its own WHERE clause. These tests are therefore about what
 * the DATABASE guarantees, not about what the application remembers to check — the same
 * shape `incrementRetryCount` was rewritten into after the real concurrency race in
 * docs/INCIDENTS.md. The claim test uses `Promise.all` rather than a sequential loop
 * for exactly that reason: sequential calls cannot race, so a sequential version of it
 * would prove nothing.
 *
 * The resolve tests are the ones that matter most. A resolved escalation is the first
 * label in this project that its own data generator did not draw, and
 * `resolve-escalation.ts` writes it back to the transaction and the customer. Getting
 * that wrong in the flattering direction — counting a promise as a payment — is exactly
 * the failure this project exists to avoid, so it is asserted directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgliteExecutor } from '@/adapters/db/pglite'
import { runMigrations } from '@/db/migrate'
import * as customersRepo from '@/repositories/customers.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as escalationsRepo from '@/repositories/escalations.repo'
import { resolveEscalationAndRecordOutcome } from '@/app/operator/resolve-escalation'
import { slaDueAtMs } from '@/domain/escalation'
import { transactionId, customerId, eventId } from '@/domain/ids'
import { paise } from '@/domain/money'
import type { Transactional } from '@/ports/sql'

function uniqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

describe('the escalation queue, against real PGlite', () => {
  let dir: string
  let sql: Transactional

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-escalations-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function seed(amountPaise = 500_00, reason: 'risk_gated' | 'economic' = 'risk_gated') {
    const custId = customerId(uniqueId('cust'))
    await customersRepo.upsertCustomer(sql, { id: custId })
    const txnId = transactionId(uniqueId('pay'))
    await transactionsRepo.upsertTransaction(sql, {
      id: txnId,
      customerId: custId,
      amount: paise(amountPaise),
      status: 'failed',
      errorCode: 'BAD_REQUEST_ERROR',
    })
    const evtId = eventId(uniqueId('evt'))
    const created = await escalationsRepo.createEscalation(sql, {
      eventId: evtId,
      attemptGeneration: 1,
      transactionId: txnId,
      customerId: custId,
      amountPaise,
      reason,
      riskScore: 0.82,
      rationale: 'risk gate fired',
      slaDueAtMs: slaDueAtMs(Date.now(), reason),
    })
    return { custId, txnId, evtId, created }
  }

  it('creates a work item, and is idempotent on (event, generation)', async () => {
    const { evtId, created } = await seed()
    expect(created.status).toBe('open')
    expect(created.reason).toBe('risk_gated')
    expect(created.amountPaise).toBe(50000)
    expect(created.riskScore).toBeCloseTo(0.82)
    expect(created.resolution).toBeNull()

    // Re-processing one event must return the SAME row — not a second work item, and
    // not a moved deadline, because an operator may already be working against it.
    const again = await escalationsRepo.createEscalation(sql, {
      eventId: evtId,
      attemptGeneration: 1,
      transactionId: created.transactionId,
      customerId: created.customerId,
      amountPaise: 999_00,
      reason: 'economic',
      riskScore: 0.1,
      rationale: 'a completely different rationale',
      slaDueAtMs: created.slaDueAt.getTime() + 86_400_000,
    })
    expect(again.id).toBe(created.id)
    expect(again.reason).toBe('risk_gated')
    expect(again.amountPaise).toBe(50000)
    expect(again.slaDueAt.getTime()).toBe(created.slaDueAt.getTime())
  })

  it('lets exactly one of twelve concurrent claims win', async () => {
    const { created } = await seed()

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        escalationsRepo.claimEscalation(sql, created.id, `operator_${i}`, Date.now()),
      ),
    )
    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.status).toBe('claimed')

    const reread = await escalationsRepo.findById(sql, created.id)
    expect(reread?.status).toBe('claimed')
    expect(reread?.assignee).toBe(winners[0]?.assignee)
  })

  it('refuses to resolve an item nobody claimed', async () => {
    const { created } = await seed()
    const result = await resolveEscalationAndRecordOutcome(sql, {
      id: created.id,
      resolution: 'paid',
      note: 'skipping the queue',
      nowMs: Date.now(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_claimed')

    // And nothing leaked: the item is untouched, no outcome was recorded.
    const reread = await escalationsRepo.findById(sql, created.id)
    expect(reread?.status).toBe('open')
    expect(reread?.resolution).toBeNull()
    expect(reread?.resolvedAt).toBeNull()
  })

  it("writes a human-observed 'paid' back to the transaction and the customer", async () => {
    const { created, txnId, custId } = await seed(750_00)
    await escalationsRepo.claimEscalation(sql, created.id, 'asha', Date.now())

    const result = await resolveEscalationAndRecordOutcome(sql, {
      id: created.id,
      resolution: 'paid',
      note: 'called, paid by UPI',
      nowMs: Date.now(),
    })
    expect(result.ok).toBe(true)

    // The point of the whole feature: a label the generator did not draw.
    const txn = await transactionsRepo.findTransactionById(sql, txnId)
    expect(txn?.status).toBe('recovered')
    const cust = await customersRepo.findCustomerById(sql, custId)
    expect(cust?.successfulPayments).toBe(1)
    expect(cust?.failedPayments).toBe(0)
    expect(cust?.ltvAmount).toBe(75000)
  })

  it("leaves 'promised_to_pay' open and banks nothing — a promise is not a payment", async () => {
    const { created, txnId, custId } = await seed()
    await escalationsRepo.claimEscalation(sql, created.id, 'asha', Date.now())
    const result = await resolveEscalationAndRecordOutcome(sql, {
      id: created.id,
      resolution: 'promised_to_pay',
      note: 'will pay Friday',
      nowMs: Date.now(),
    })
    expect(result.ok).toBe(true)

    const txn = await transactionsRepo.findTransactionById(sql, txnId)
    expect(txn?.status).toBe('escalated') // not 'recovered', not 'abandoned'

    // Neither counter moved. Counting this either way would be wrong, and the same
    // transaction would then be double-counted when the promise resolves for real.
    const cust = await customersRepo.findCustomerById(sql, custId)
    expect(cust?.successfulPayments).toBe(0)
    expect(cust?.failedPayments).toBe(0)
    expect(cust?.ltvAmount).toBe(0)
  })

  it('records a terminal negative as a real failure, not as nothing', async () => {
    const { created, txnId, custId } = await seed()
    await escalationsRepo.claimEscalation(sql, created.id, 'asha', Date.now())
    await resolveEscalationAndRecordOutcome(sql, {
      id: created.id,
      resolution: 'uncontactable',
      note: 'three attempts, no answer',
      nowMs: Date.now(),
    })

    const txn = await transactionsRepo.findTransactionById(sql, txnId)
    expect(txn?.status).toBe('abandoned')
    const cust = await customersRepo.findCustomerById(sql, custId)
    expect(cust?.failedPayments).toBe(1)
    expect(cust?.successfulPayments).toBe(0)
  })

  it('cannot be resolved twice', async () => {
    const { created } = await seed()
    await escalationsRepo.claimEscalation(sql, created.id, 'asha', Date.now())
    const first = await resolveEscalationAndRecordOutcome(sql, {
      id: created.id,
      resolution: 'paid',
      note: null,
      nowMs: Date.now(),
    })
    expect(first.ok).toBe(true)

    // A second operator pressing Resolve on an already-closed item must not double
    // the customer's recovery count.
    const second = await resolveEscalationAndRecordOutcome(sql, {
      id: created.id,
      resolution: 'written_off',
      note: null,
      nowMs: Date.now(),
    })
    expect(second.ok).toBe(false)

    const reread = await escalationsRepo.findById(sql, created.id)
    expect(reread?.resolution).toBe('paid')
    const cust = await customersRepo.findCustomerById(sql, created.customerId ?? customerId('nope'))
    expect(cust?.successfulPayments).toBe(1)
  })

  it('releases a claimed item, and only a claimed one', async () => {
    const { created } = await seed()
    expect(await escalationsRepo.releaseEscalation(sql, created.id)).toBeNull() // still open

    await escalationsRepo.claimEscalation(sql, created.id, 'asha', Date.now())
    const released = await escalationsRepo.releaseEscalation(sql, created.id)
    expect(released?.status).toBe('open')
    expect(released?.assignee).toBeNull()
    expect(released?.claimedAt).toBeNull()
  })

  it('orders the queue by deadline, and reports overdue against a passed-in instant', async () => {
    // Its own isolated table state, so ordering assertions cannot be polluted by the
    // items the tests above left behind.
    await sql.query('DELETE FROM escalations')
    const now = Date.now()
    const custId = customerId(uniqueId('cust'))
    await customersRepo.upsertCustomer(sql, { id: custId })

    // Inserted latest-deadline-first, so correct ordering cannot pass by accident.
    for (const [offsetMs, label] of [
      [86_400_000, 'later'],
      [-3_600_000, 'overdue'],
      [3_600_000, 'soon'],
    ] as const) {
      await escalationsRepo.createEscalation(sql, {
        eventId: eventId(uniqueId(`evt_${label}`)),
        attemptGeneration: 1,
        transactionId: null,
        customerId: custId,
        amountPaise: 100_00,
        reason: 'economic',
        riskScore: null,
        rationale: label,
        slaDueAtMs: now + offsetMs,
      })
    }

    const queue = await escalationsRepo.listQueue(sql, 10)
    expect(queue.map((e) => e.rationale)).toEqual(['overdue', 'soon', 'later'])

    const stats = await escalationsRepo.queueStats(sql, now)
    expect(stats.open).toBe(3)
    expect(stats.claimed).toBe(0)
    expect(stats.resolved).toBe(0)
    expect(stats.overdue).toBe(1)

    const first = queue[0]
    if (first === undefined) throw new Error('queue unexpectedly empty')
    await escalationsRepo.claimEscalation(sql, first.id, 'asha', now)
    await resolveEscalationAndRecordOutcome(sql, {
      id: first.id,
      resolution: 'written_off',
      note: null,
      nowMs: now,
    })

    const after = await escalationsRepo.queueStats(sql, now)
    expect(after.open).toBe(2)
    expect(after.resolved).toBe(1)
    expect(after.byResolution.get('written_off')).toBe(1)
    expect((await escalationsRepo.listQueue(sql, 10)).map((e) => e.rationale)).toEqual(['soon', 'later'])
    expect((await escalationsRepo.listResolved(sql, 10)).map((e) => e.rationale)).toEqual(['overdue'])
  })
})
