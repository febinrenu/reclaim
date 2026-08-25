/**
 * Closes the D11 TODO for real: `buildLiveRiskSignals` genuinely computes
 * `cardVelocityHigh`, `amountFarAboveHistory`, and `cardFirstSeenRecently`
 * from real transaction history, checked against real PGlite — not the
 * hardcoded `false` every one of these carried on the live path before today.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgliteExecutor } from '@/adapters/db/pglite'
import { runMigrations } from '@/db/migrate'
import * as customersRepo from '@/repositories/customers.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import { transactionId, customerId } from '@/domain/ids'
import { paise } from '@/domain/money'
import { buildLiveRiskSignals } from '@/app/worker/live-risk-signals'
import type { Transactional } from '@/ports/sql'

const HOUR_MS = 60 * 60 * 1000

// `transactions.created_at` is always the database's own `now()` at insert
// time — InsertTransactionInput has no way to override it — so every window
// comparison in this suite has to be anchored to a `Date.now()` captured
// *after* the fixture rows it is meant to include have actually been
// inserted, never a value computed once up front. `future(offsetMs)` makes
// that anchor explicit at each call site rather than reusing a stale one.
function future(offsetMs = 0): number {
  return Date.now() + offsetMs
}

describe('buildLiveRiskSignals, against real PGlite', () => {
  let dir: string
  let sql: Transactional

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-live-risk-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('every signal is false when there is no history and no card/customer identity at all', async () => {
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_no_identity',
      customerId: null,
      cardId: null,
      amountPaise: 50000,
      nowMs: future(),
    })
    expect(risk).toEqual({
      geoMismatch: false,
      cardVelocityHigh: false,
      amountFarAboveHistory: false,
      cardFirstSeenRecently: false,
    })
  })

  it('geoMismatch is always false — no live signal for it exists in this build', async () => {
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_any',
      customerId: null,
      cardId: 'card_any',
      amountPaise: 50000,
      nowMs: future(),
    })
    expect(risk.geoMismatch).toBe(false)
  })

  it('cardVelocityHigh trips once >= 3 other failed transactions share the card id within 30 minutes', async () => {
    const cardId = 'card_velocity_test'
    for (let i = 0; i < 3; i++) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_velocity_prior_${i}`),
        amount: paise(10000),
        status: 'failed',
        cardId,
      })
    }
    // A 4th transaction, the one under decision, arrives 10 minutes later.
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_velocity_current',
      customerId: null,
      cardId,
      amountPaise: 10000,
      nowMs: future(10 * 60 * 1000),
    })
    expect(risk.cardVelocityHigh).toBe(true)
  })

  it('cardVelocityHigh stays false when the prior failures are outside the 30-minute window', async () => {
    const cardId = 'card_velocity_old'
    for (let i = 0; i < 3; i++) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_velocity_old_${i}`),
        amount: paise(10000),
        status: 'failed',
        cardId,
      })
    }
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_velocity_old_current',
      customerId: null,
      cardId,
      amountPaise: 10000,
      nowMs: future(2 * HOUR_MS), // well outside the 30-minute window
    })
    expect(risk.cardVelocityHigh).toBe(false)
  })

  it('cardVelocityHigh never counts a successful transaction toward the threshold', async () => {
    const cardId = 'card_velocity_success'
    for (let i = 0; i < 3; i++) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_velocity_success_${i}`),
        amount: paise(10000),
        status: 'recovered',
        cardId,
      })
    }
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_velocity_success_current',
      customerId: null,
      cardId,
      amountPaise: 10000,
      nowMs: future(10 * 60 * 1000),
    })
    expect(risk.cardVelocityHigh).toBe(false)
  })

  it('cardFirstSeenRecently is true for a genuinely new card, and false once it has aged past 24h', async () => {
    const cardId = 'card_first_seen_test'
    // Nothing recorded yet for this card at all.
    const freshRisk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_first_seen_1',
      customerId: null,
      cardId,
      amountPaise: 10000,
      nowMs: future(),
    })
    expect(freshRisk.cardFirstSeenRecently).toBe(true)

    await transactionsRepo.upsertTransaction(sql, {
      id: transactionId('pay_first_seen_1'),
      amount: paise(10000),
      status: 'failed',
      cardId,
    })
    const insertedAt = future()

    const stillRecentRisk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_first_seen_2',
      customerId: null,
      cardId,
      amountPaise: 10000,
      nowMs: insertedAt + 12 * HOUR_MS,
    })
    expect(stillRecentRisk.cardFirstSeenRecently).toBe(true)

    const agedRisk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_first_seen_3',
      customerId: null,
      cardId,
      amountPaise: 10000,
      nowMs: insertedAt + 48 * HOUR_MS,
    })
    expect(agedRisk.cardFirstSeenRecently).toBe(false)
  })

  it('amountFarAboveHistory trips only once the current amount clears 3x this customer\'s own average', async () => {
    const custId = customerId('cust_amount_history')
    await customersRepo.upsertCustomer(sql, { id: custId })
    for (const amount of [10000, 12000, 11000]) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_hist_${amount}`),
        customerId: custId,
        amount: paise(amount),
        status: 'recovered',
      })
    }
    const afterHistory = future()

    // Average of history ≈ 11000. 20000 is under 3x — should not trip.
    const belowThreshold = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_hist_current_below',
      customerId: 'cust_amount_history',
      cardId: null,
      amountPaise: 20000,
      nowMs: afterHistory,
    })
    expect(belowThreshold.amountFarAboveHistory).toBe(false)

    // 50000 clears 3x ≈ 33000 — should trip.
    const aboveThreshold = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_hist_current_above',
      customerId: 'cust_amount_history',
      cardId: null,
      amountPaise: 50000,
      nowMs: afterHistory,
    })
    expect(aboveThreshold.amountFarAboveHistory).toBe(true)
  })

  it('amountFarAboveHistory is false when the customer has no prior transaction history at all', async () => {
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_no_history',
      customerId: 'cust_brand_new',
      cardId: null,
      amountPaise: 100_00_000, // an enormous amount, but nothing to compare it against
      nowMs: future(),
    })
    expect(risk.amountFarAboveHistory).toBe(false)
  })

  it('falls back to the customer id as the risk-identity key when no card id is present (netbanking/UPI)', async () => {
    const custId = customerId('cust_no_card')
    await customersRepo.upsertCustomer(sql, { id: custId })
    for (let i = 0; i < 3; i++) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_no_card_${i}`),
        customerId: custId,
        amount: paise(10000),
        status: 'failed',
        // no cardId — a netbanking/UPI payment
      })
    }
    const risk = await buildLiveRiskSignals(sql, {
      transactionId: 'pay_no_card_current',
      customerId: 'cust_no_card',
      cardId: null,
      amountPaise: 10000,
      nowMs: future(10 * 60 * 1000),
    })
    expect(risk.cardVelocityHigh).toBe(true)
  })
})
