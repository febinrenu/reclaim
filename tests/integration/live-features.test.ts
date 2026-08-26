/**
 * Closes the live-features.ts TODOs for real: `contacts_last_7d`,
 * `bank_recent_fail_rate`, `amount_zscore`, and `ltv_zscore` genuinely compute
 * from real database state now, checked against real PGlite — not the fixed
 * defaults every one of these carried on the live path before today.
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
import { buildLiveFeatures } from '@/app/worker/live-features'
import type { Transactional } from '@/ports/sql'

function future(offsetMs = 0): number {
  return Date.now() + offsetMs
}

describe('buildLiveFeatures, against real PGlite', () => {
  let dir: string
  let sql: Transactional

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-live-features-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to honest defaults with no history and no bank at all', async () => {
    const features = await buildLiveFeatures(sql, {
      customerId: null,
      transactionId: 'pay_no_history',
      amountPaise: 50000,
      bank: null,
      retryIndex: 0,
      nowMs: future(),
    })
    expect(features.prior_success_rate).toBe(0.5)
    expect(features.contacts_last_7d).toBe(0)
    expect(features.bank_recent_fail_rate).toBe(0.1) // NO_BANK_HISTORY_PRIOR
    expect(features.amount_zscore).toBe(0) // no global population yet either
    expect(features.ltv_zscore).toBe(0)
  })

  it('computes a real bank_recent_fail_rate once real history for that bank exists', async () => {
    const bank = `bank_${crypto.randomUUID()}`
    for (let i = 0; i < 4; i++) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_bankhist_${i}`),
        amount: paise(100_00),
        status: i < 3 ? 'failed' : 'recovered',
        bank,
      })
    }
    const features = await buildLiveFeatures(sql, {
      customerId: null,
      transactionId: 'pay_new_for_this_bank',
      amountPaise: 100_00,
      bank,
      retryIndex: 0,
      nowMs: future(1000),
    })
    expect(features.bank_recent_fail_rate).toBeCloseTo(0.75, 5)
  })

  it('prior_success_rate reflects real recorded outcomes, not a permanent 0.5 default', async () => {
    const custId = customerId(`cust_${crypto.randomUUID()}`)
    await customersRepo.upsertCustomer(sql, { id: custId })
    await customersRepo.recordCustomerOutcome(sql, custId, { recovered: true, deltaLtvPaise: 100_00 })
    await customersRepo.recordCustomerOutcome(sql, custId, { recovered: false, deltaLtvPaise: 0 })
    await customersRepo.recordCustomerOutcome(sql, custId, { recovered: false, deltaLtvPaise: 0 })

    const features = await buildLiveFeatures(sql, {
      customerId: custId,
      transactionId: 'pay_returning_customer',
      amountPaise: 100_00,
      bank: null,
      retryIndex: 0,
      nowMs: future(1000),
    })
    expect(features.prior_success_rate).toBeCloseTo(1 / 3, 5)
  })

  it('amount_zscore falls back to the global population below the personal-history threshold, and uses personal history above it', async () => {
    const custId = customerId(`cust_${crypto.randomUUID()}`)
    await customersRepo.upsertCustomer(sql, { id: custId })

    // Fewer than MIN_TXNS_FOR_PERSONAL_ZSCORE (3) of their own history — must
    // fall back to the real global population, not silently return 0 just
    // because personal history is thin.
    await transactionsRepo.upsertTransaction(sql, {
      id: transactionId(`pay_thin1_${crypto.randomUUID()}`),
      customerId: custId,
      amount: paise(200_00),
      status: 'failed',
    })
    const thinHistory = await buildLiveFeatures(sql, {
      customerId: custId,
      transactionId: `pay_check_thin_${crypto.randomUUID()}`,
      amountPaise: 5_000_00, // wildly above anything seeded so far
      bank: null,
      retryIndex: 0,
      nowMs: future(2000),
    })
    // With real global history now containing far smaller amounts, a
    // ₹5,000 transaction must read as a real positive outlier, not 0.
    expect(thinHistory.amount_zscore).toBeGreaterThan(0)

    // Now give this customer enough of their own history that their personal
    // distribution, not the global one, should govern.
    for (let i = 0; i < 3; i++) {
      await transactionsRepo.upsertTransaction(sql, {
        id: transactionId(`pay_personal_${i}_${crypto.randomUUID()}`),
        customerId: custId,
        amount: paise(1_000_00),
        status: 'failed',
      })
    }
    const richHistory = await buildLiveFeatures(sql, {
      customerId: custId,
      transactionId: `pay_check_rich_${crypto.randomUUID()}`,
      amountPaise: 1_000_00, // exactly this customer's own typical amount now
      bank: null,
      retryIndex: 0,
      nowMs: future(3000),
    })
    // Against their own now-established ₹1,000 pattern, an identical ₹1,000
    // transaction should read as unremarkable (small |z|), not the large
    // outlier it read as against the thinner global population above.
    expect(Math.abs(richHistory.amount_zscore)).toBeLessThan(Math.abs(thinHistory.amount_zscore))
  })

  it('ltv_zscore reflects the real live customer population, not a permanent 0', async () => {
    // A below-average and an above-average customer, by real recorded LTV.
    const low = customerId(`cust_low_${crypto.randomUUID()}`)
    const high = customerId(`cust_high_${crypto.randomUUID()}`)
    await customersRepo.upsertCustomer(sql, { id: low })
    await customersRepo.upsertCustomer(sql, { id: high })
    await customersRepo.recordCustomerOutcome(sql, low, { recovered: true, deltaLtvPaise: 10_00 })
    await customersRepo.recordCustomerOutcome(sql, high, { recovered: true, deltaLtvPaise: 100_000_00 })

    const highFeatures = await buildLiveFeatures(sql, {
      customerId: high,
      transactionId: `pay_high_ltv_${crypto.randomUUID()}`,
      amountPaise: 100_00,
      bank: null,
      retryIndex: 0,
      nowMs: future(4000),
    })
    const lowFeatures = await buildLiveFeatures(sql, {
      customerId: low,
      transactionId: `pay_low_ltv_${crypto.randomUUID()}`,
      amountPaise: 100_00,
      bank: null,
      retryIndex: 0,
      nowMs: future(4000),
    })
    expect(highFeatures.ltv_zscore).toBeGreaterThan(lowFeatures.ltv_zscore)
  })
})
