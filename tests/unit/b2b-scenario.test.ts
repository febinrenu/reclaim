/**
 * SYSTEM_SPEC.md §16's own proof: `decide()` — the exact same function, no
 * scenario-specific branch inside it — produces sane, feasibility-respecting
 * decisions for a completely different action vocabulary and feature set.
 */
import { describe, it, expect } from 'vitest'
import { decide } from '@/domain/decide'
import { B2B_RECEIVABLE_SCENARIO, B2B_DEFAULT_POLICY, B2B_ACTIONS, type B2bAction } from '@/domain/scenario/b2b-receivable'
import { paise, fromRupees } from '@/domain/money'
import type { DecisionInput } from '@/domain/scenario/types'
import type { B2bFeature } from '@/domain/scenario/b2b-receivable'

const ALL_CAPABLE = Object.fromEntries(B2B_ACTIONS.map((a) => [a, true])) as Record<B2bAction, boolean>

function makeInput(overrides: Partial<DecisionInput<B2bAction, B2bFeature>> = {}): DecisionInput<B2bAction, B2bFeature> {
  return {
    transactionId: 'inv_x',
    eventId: 'evt_x',
    nowMs: 0,
    amount: paise(50000_00),
    retryCount: 0,
    contactsLast7d: 0,
    expectedLtv: fromRupees(0),
    features: {
      days_overdue: 10,
      customer_ontime_rate: 0.6,
      invoice_size_zscore: 0,
      chase_rounds_so_far: 0,
      is_repeat_overdue_this_quarter: 0,
      quarter_sin: 0,
      quarter_cos: 1,
      contacts_last_14d: 0,
      customer_relationship_days: 300,
    },
    risk: { geoMismatch: false, cardVelocityHigh: false, amountFarAboveHistory: false, cardFirstSeenRecently: false },
    shockSuppressed: false,
    optedOut: false,
    capabilityAvailable: ALL_CAPABLE,
    ...overrides,
  }
}

describe('decide() over the B2B receivables scenario', () => {
  it('produces a chosen action from the B2B action vocabulary', () => {
    const decision = decide(makeInput(), B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    expect(B2B_ACTIONS).toContain(decision.chosenAction)
  })

  it('computes a full EV breakdown for every action, including disallowed ones', () => {
    const decision = decide(makeInput(), B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    expect(decision.breakdown).toHaveLength(B2B_ACTIONS.length)
    for (const action of B2B_ACTIONS) {
      expect(decision.breakdown.some((b) => b.action === action)).toBe(true)
    }
  })

  it('forces ESCALATE_COLLECTIONS once chase_rounds_so_far reaches maxRetries, never a further chase action', () => {
    const decision = decide(makeInput({ retryCount: B2B_DEFAULT_POLICY.maxRetries }), B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    expect(decision.chosenAction).toBe('ESCALATE_COLLECTIONS')
  })

  it('a gated risk score forces escalation regardless of the invoice amount', () => {
    const risk = { geoMismatch: true, cardVelocityHigh: true, amountFarAboveHistory: true, cardFirstSeenRecently: true }
    const decision = decide(makeInput({ risk }), B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    expect(decision.riskGated).toBe(true)
    expect(decision.chosenAction).toBe('ESCALATE_COLLECTIONS')
  })

  it('opting out disallows the two contact actions but never the silent/human ones', () => {
    const decision = decide(makeInput({ optedOut: true }), B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    const sendReminder = decision.breakdown.find((b) => b.action === 'SEND_REMINDER')
    const offerPlan = decision.breakdown.find((b) => b.action === 'OFFER_PAYMENT_PLAN')
    const writeOff = decision.breakdown.find((b) => b.action === 'WRITE_OFF')
    expect(sendReminder?.allowed).toBe(false)
    expect(sendReminder?.disallowedReason).toBe('opted_out')
    expect(offerPlan?.allowed).toBe(false)
    expect(writeOff?.allowed).toBe(true)
  })

  it('WRITE_OFF (the null action) has a non-zero EV whenever the organic payment probability is non-zero', () => {
    const decision = decide(makeInput(), B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    const writeOff = decision.breakdown.find((b) => b.action === 'WRITE_OFF')
    expect(writeOff).toBeDefined()
    // BUILD_PLAN.md §6.1 correction 1, generalized to a second scenario: the
    // null action is not zero, because organic payment happens without chasing.
    if ((writeOff?.pRecover ?? 0) > 0) {
      expect(writeOff?.ev).toBeGreaterThan(0)
    }
  })
})
