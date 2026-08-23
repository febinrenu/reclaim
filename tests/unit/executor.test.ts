import { describe, it, expect } from 'vitest'
import { resolveExecutionMode, executeAction, type PaymentsPort } from '@/ports/executor'

/**
 * The full truth table (BUILD_PLAN.md §5.3: "pure, unit-tested with a truth
 * table"). Live requires ALL FOUR: not a batch replay, credentials present,
 * explicitly configured to allow live, and budget remaining.
 */
describe('resolveExecutionMode', () => {
  const rows: Array<[Parameters<typeof resolveExecutionMode>[0], 'dry_run' | 'live']> = [
    [{ source: 'batch_replay', hasCredentials: true, configured: 'live', liveBudgetRemaining: 10 }, 'dry_run'],
    [{ source: 'live_webhook', hasCredentials: false, configured: 'live', liveBudgetRemaining: 10 }, 'dry_run'],
    [{ source: 'live_webhook', hasCredentials: true, configured: 'dry_run', liveBudgetRemaining: 10 }, 'dry_run'],
    [{ source: 'live_webhook', hasCredentials: true, configured: 'live', liveBudgetRemaining: 0 }, 'dry_run'],
    [{ source: 'live_webhook', hasCredentials: true, configured: 'live', liveBudgetRemaining: 5 }, 'live'],
    [{ source: 'live_webhook', hasCredentials: true, configured: 'auto', liveBudgetRemaining: 5 }, 'live'],
    [{ source: 'simulation', hasCredentials: true, configured: 'live', liveBudgetRemaining: 5 }, 'live'],
  ]

  it.each(rows)('%j -> %s', (input, expected) => {
    expect(resolveExecutionMode(input).mode).toBe(expected)
  })

  it('a batch replay can never reach live, structurally, regardless of the other three inputs', () => {
    const result = resolveExecutionMode({
      source: 'batch_replay',
      hasCredentials: true,
      configured: 'live',
      liveBudgetRemaining: 1000,
    })
    expect(result.mode).toBe('dry_run')
    expect(result.reason).toMatch(/always dry_run/)
  })

  it('every result carries a human-readable reason', () => {
    for (const [input] of rows) {
      expect(resolveExecutionMode(input).reason.length).toBeGreaterThan(5)
    }
  })
})

function fakePayments(overrides: Partial<PaymentsPort> = {}): PaymentsPort {
  return {
    name: 'simulator',
    createPaymentLink: async (req) => ({ id: `plink_${req.transactionId}`, shortUrl: 'https://example.test' }),
    findByReference: async () => null,
    ...overrides,
  }
}

describe('executeAction', () => {
  const req = { transactionId: 'pay_1', amountPaise: 1000, customerId: 'cust_1' }

  it('dry_run never calls the payments port at all', async () => {
    let called = false
    const payments = fakePayments({ createPaymentLink: async () => { called = true; return { id: 'x', shortUrl: 'x' } } })
    const result = await executeAction('PAYMENT_LINK', 'dry_run', req, payments)
    expect(called).toBe(false)
    expect(result.mode).toBe('dry_run')
    expect(result.receipt).toBeNull()
  })

  it('live PAYMENT_LINK calls createPaymentLink and returns a receipt', async () => {
    const payments = fakePayments()
    const result = await executeAction('PAYMENT_LINK', 'live', req, payments)
    expect(result.mode).toBe('live')
    expect(result.receipt).toEqual({ linkId: 'plink_pay_1', shortUrl: 'https://example.test' })
  })

  it('live actions with no payments-side effect never call the payments port', async () => {
    let called = false
    const payments = fakePayments({ createPaymentLink: async () => { called = true; return { id: 'x', shortUrl: 'x' } } })
    const result = await executeAction('WHATSAPP_NUDGE', 'live', req, payments)
    expect(called).toBe(false)
    expect(result.receipt).toBeNull()
  })
})
