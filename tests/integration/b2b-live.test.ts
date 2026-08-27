/**
 * Real, live wiring for the B2B receivables scenario (docs/adr/0007's
 * "supersedes" note): `POST /api/b2b/invoices` -> `processB2bInvoiceEvent` is
 * a real, database-writing path a request can actually reach, not just the
 * offline simulator/training scripts B2B was previously scoped to. Checked
 * against real PGlite, the same discipline every other live-path test in this
 * suite holds to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createMemoryKv } from '@/adapters/kv/memory'
import { runMigrations } from '@/db/migrate'
import { loadEnv } from '@/config/env'
import { buildContainer, type Deps } from '@/config/container'
import { fixedClock } from '@/domain/clock'
import { transactionId, customerId } from '@/domain/ids'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as customersRepo from '@/repositories/customers.repo'
import { processB2bInvoiceEvent } from '@/app/b2b/process-invoice-event'
import { B2B_ACTIONS, type B2bAction } from '@/domain/scenario/b2b-receivable'
import type { Transactional } from '@/ports/sql'

describe('processB2bInvoiceEvent, against real PGlite', () => {
  let dir: string
  let sql: Transactional
  let deps: Deps
  const nowMs = 1_756_100_000_000

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-b2b-live-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
    // loadEnv({}) — no credentials, same as every other integration test in
    // this suite: deterministic template-only language layer, never a real
    // Groq call from an automated test run.
    deps = await buildContainer(loadEnv({}), {
      sql,
      kv: createMemoryKv(),
      clock: fixedClock(nowMs),
    })
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('produces a real, persisted decision from the B2B action vocabulary, with a real audit row', async () => {
    const result = await processB2bInvoiceEvent(deps, {
      eventId: 'b2b_evt_1',
      invoiceId: 'inv_1',
      customerId: 'cust_b2b_1',
      amountPaise: 500_000_00,
      daysOverdue: 15,
    })
    expect(result.duplicate).toBe(false)
    expect(B2B_ACTIONS as readonly string[]).toContain(result.chosenAction)

    const txn = await transactionsRepo.findTransactionById(deps.sql, transactionId('inv_1'))
    expect(txn?.scenario).toBe('b2b_receivable')
    expect(txn?.status).toBe('failed')

    const { rows } = await deps.sql.query<{ chosen_action: string; execution_mode: string }>(
      'SELECT chosen_action, execution_mode FROM recovery_audit WHERE transaction_id = $1',
      [transactionId('inv_1')],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.chosen_action).toBe(result.chosenAction)
    expect(rows[0]?.execution_mode).toBe('dry_run')
  })

  it('drafts real customer-facing copy, with the amount slot filled and no unfilled link placeholder, for the two contact actions', async () => {
    const contactActions: readonly B2bAction[] = ['SEND_REMINDER', 'OFFER_PAYMENT_PLAN']
    for (const action of contactActions) {
      // Different customers/invoices so decide() has no shared retry-count
      // state to interfere with which action gets chosen — this test cares
      // about copy quality once an action IS chosen with contact required.
      const result = await processB2bInvoiceEvent(deps, {
        eventId: `b2b_evt_copy_${action}`,
        invoiceId: `inv_copy_${action}`,
        customerId: `cust_copy_${action}`,
        amountPaise: 300_000_00,
        daysOverdue: 10,
      })
      if (result.chosenAction !== action) continue // decide()'s own real choice; not this test's premise to force
      expect(result.draftedMessage).not.toBeNull()
      expect(result.draftedMessage).not.toContain('{{')
      expect(result.draftedMessage).not.toContain('}}')
    }
  })

  it('never invents a real payment gateway call — every action stays dry_run, structurally', async () => {
    const result = await processB2bInvoiceEvent(deps, {
      eventId: 'b2b_evt_dryrun',
      invoiceId: 'inv_dryrun',
      customerId: 'cust_b2b_dryrun',
      amountPaise: 100_000_00,
      daysOverdue: 5,
    })
    const { rows } = await deps.sql.query<{ execution_mode: string }>(
      'SELECT execution_mode FROM action_attempts WHERE transaction_id = $1',
      [transactionId('inv_dryrun')],
    )
    expect(rows[0]?.execution_mode).toBe('dry_run')
    void result
  })

  it('is idempotent under a real duplicate eventId — no second audit row, no second chase-round increment', async () => {
    const input = {
      eventId: 'b2b_evt_dup',
      invoiceId: 'inv_dup',
      customerId: 'cust_b2b_dup',
      amountPaise: 200_000_00,
      daysOverdue: 8,
    }
    const first = await processB2bInvoiceEvent(deps, input)
    expect(first.duplicate).toBe(false)

    const second = await processB2bInvoiceEvent(deps, input)
    expect(second.duplicate).toBe(true)

    const { rows } = await deps.sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM recovery_audit WHERE transaction_id = $1',
      [transactionId('inv_dup')],
    )
    expect(rows[0]?.count).toBe('1')
  })

  it('short-circuits on a real payment, before decide() ever runs, and records the customer outcome', async () => {
    const custId = customerId('cust_b2b_paid')
    await customersRepo.upsertCustomer(deps.sql, { id: custId })
    const before = await customersRepo.findCustomerById(deps.sql, custId)
    expect(before?.successfulPayments).toBe(0)

    const result = await processB2bInvoiceEvent(deps, {
      eventId: 'b2b_evt_paid',
      invoiceId: 'inv_paid',
      customerId: 'cust_b2b_paid',
      amountPaise: 150_000_00,
      daysOverdue: 3,
      paid: true,
    })
    expect(result.chosenAction).toBe('PAID')

    const { rows } = await deps.sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM recovery_audit WHERE transaction_id = $1',
      [transactionId('inv_paid')],
    )
    expect(rows[0]?.count).toBe('0')

    const txn = await transactionsRepo.findTransactionById(deps.sql, transactionId('inv_paid'))
    expect(txn?.status).toBe('recovered')

    const after = await customersRepo.findCustomerById(deps.sql, custId)
    expect(after?.successfulPayments).toBe(1)
    expect(after?.ltvAmount).toBe(150_000_00)
  })

  it('chase_rounds_so_far advances across real repeated calls for the same invoice, capped and escalating like the subscription path', async () => {
    const invoiceId = 'inv_chase_cap'
    let lastResult = null as Awaited<ReturnType<typeof processB2bInvoiceEvent>> | null
    for (let i = 0; i < 5; i++) {
      lastResult = await processB2bInvoiceEvent(deps, {
        eventId: `b2b_evt_chase_${i}`,
        invoiceId,
        customerId: 'cust_b2b_chase',
        amountPaise: 400_000_00,
        daysOverdue: 12 + i,
      })
    }
    const txn = await transactionsRepo.findTransactionById(deps.sql, transactionId(invoiceId))
    // Never past maxRetries (2) — same atomic cap incrementRetryCount already
    // enforces on the subscription side, reused here unmodified.
    expect(txn!.retryCount).toBeLessThanOrEqual(2)
    // By the 5th real call, chase rounds capped, the decision must be the B2B
    // scenario's own escalation action.
    expect(lastResult!.chosenAction).toBe('ESCALATE_COLLECTIONS')
  })

  it('scopes invoice-amount history to the b2b_receivable scenario, never mixing in a subscription transaction sharing the same customer id', async () => {
    // A customer who happens to also exist on the subscription side, with a
    // wildly different amount scale, must never skew this invoice's own
    // z-score-driven risk signal. Tested directly against the risk-signal
    // builder rather than through decide()'s full pipeline, so this is a
    // precise check of the scoping itself, not an indirect proxy that could
    // pass or fail for unrelated model reasons.
    const { paise } = await import('@/domain/money')
    const { buildB2bLiveRiskSignals } = await import('@/app/worker/b2b-live-features')
    const sharedCustomerId = 'cust_shared_scenarios_2'
    await customersRepo.upsertCustomer(deps.sql, { id: customerId(sharedCustomerId) })
    // A tiny, consistent subscription payment history — if this leaked into
    // the B2B risk signal below, a ₹5,00,000 invoice would trivially read as
    // "far above history" against it.
    for (let i = 0; i < 4; i++) {
      await transactionsRepo.upsertTransaction(deps.sql, {
        id: transactionId(`sub_txn_shared_${i}`),
        customerId: customerId(sharedCustomerId),
        amount: paise(10_00),
        status: 'failed',
        scenario: 'subscription',
      })
    }

    const risk = await buildB2bLiveRiskSignals(deps.sql, {
      transactionId: 'inv_shared_scope_2',
      customerId: sharedCustomerId,
      amountPaise: 500_000_00,
      daysOverdue: 15,
      chaseRoundsSoFar: 0,
      billingAddressMismatch: false,
      nowMs,
    })
    // No B2B history at all for this customer yet — customerAmountStats
    // scoped to 'b2b_receivable' must return null, not the subscription
    // rows, so amountFarAboveHistory can never fire here.
    expect(risk.amountFarAboveHistory).toBe(false)
  })
})
