import { describe, it, expect } from 'vitest'
import { computeEv } from '@/domain/ev'
import { fromRupees, milliFromRupees, expectedValueOf, toMilli, scaleMilli, subMilli, milliPaise } from '@/domain/money'
import { SUBSCRIPTION_DEFAULT_POLICY } from '@/domain/scenario/subscription'

/**
 * The hand-worked example (BUILD_PLAN.md §6, D3 exit test): a ₹2,000 transaction, a
 * WHATSAPP_NUDGE scored at pRecover = 0.71 (isolating the EV arithmetic from the
 * scoring step — as of D5, pRecover comes from the trained model's own row for this
 * action, not a separate lift applied to pBase), a ₹0.35 nudge cost, and a
 * contact-fatigue term from BUILD_PLAN.md §6.1 correction 2 on a ₹6,000 LTV customer
 * with no prior contact this week. This exact scenario is the one already exercised
 * (without an assertion) by tests/unit/purity.test.ts's `money` domain exercise —
 * this test is where it becomes a pinned number. Intended to be quoted directly in
 * the README.
 */
describe('the hand-worked EV example', () => {
  it('matches an independently hand-computed total to the millipaise', () => {
    const policy = SUBSCRIPTION_DEFAULT_POLICY
    const breakdown = computeEv(
      {
        action: 'WHATSAPP_NUDGE',
        pBase: 0.71,
        pRecover: 0.71,
        amount: fromRupees(2000),
        contactsLast7d: 0,
        expectedLtv: fromRupees(6000),
        allowed: true,
        disallowedReason: null,
      },
      policy,
    )

    // Computed independently of computeEv, from the same primitive money functions,
    // so this is a genuine cross-check rather than the implementation grading itself.
    const expectedGain = scaleMilli(toMilli(fromRupees(2000)), 0.71) // ₹1,420.00
    const interventionCost = milliFromRupees(0.35) // ₹0.35
    const contactFatigueCost = expectedValueOf(fromRupees(6000), 0.0005) // ₹3.00 — churn_hazard(0)
    const expectedEv = subMilli(subMilli(expectedGain, interventionCost), contactFatigueCost)

    expect(breakdown.pRecover).toBeCloseTo(0.71, 12)
    expect(breakdown.expectedGain).toBe(142_000_000)
    expect(breakdown.interventionCost).toBe(35_000)
    expect(breakdown.contactFatigueCost).toBe(300_000)
    expect(breakdown.ev).toBe(expectedEv)
    expect(breakdown.ev).toBe(milliPaise(141_665_000)) // ₹1,416.65
  })
})

describe('computeEv', () => {
  const policy = SUBSCRIPTION_DEFAULT_POLICY

  it('is computed even for a disallowed action, so the counterfactual survives', () => {
    const breakdown = computeEv(
      {
        action: 'PAYMENT_LINK',
        pBase: 0.5,
        pRecover: 0.6,
        amount: fromRupees(1000),
        contactsLast7d: 0,
        expectedLtv: fromRupees(1000),
        allowed: false,
        disallowedReason: 'opted_out',
      },
      policy,
    )
    expect(breakdown.allowed).toBe(false)
    expect(breakdown.disallowedReason).toBe('opted_out')
    expect(Number.isInteger(breakdown.ev)).toBe(true) // property P12, as a direct example
  })

  it('logs zero RiskPenalty always — the gate is a hard constraint, not a subtracted penalty (BUILD_PLAN.md §6.1 correction 3)', () => {
    const breakdown = computeEv(
      {
        action: 'RETRY_NOW',
        pBase: 0.5,
        pRecover: 0.5,
        amount: fromRupees(500_00_00), // an amount large enough that a fixed penalty could not compete
        contactsLast7d: 0,
        expectedLtv: fromRupees(0),
        allowed: false,
        disallowedReason: 'stopping_rule',
      },
      policy,
    )
    expect(breakdown.riskPenalty).toBe(0)
  })

  it('charges contact fatigue only for actions in policy.contactFatigueActions', () => {
    const silent = computeEv(
      {
        action: 'RETRY_NOW',
        pBase: 0.5,
        pRecover: 0.5,
        amount: fromRupees(1000),
        contactsLast7d: 3,
        expectedLtv: fromRupees(6000),
        allowed: true,
        disallowedReason: null,
      },
      policy,
    )
    expect(silent.contactFatigueCost).toBe(0)

    const contacting = computeEv(
      {
        action: 'WHATSAPP_NUDGE',
        pBase: 0.5,
        pRecover: 0.5,
        amount: fromRupees(1000),
        contactsLast7d: 3,
        expectedLtv: fromRupees(6000),
        allowed: true,
        disallowedReason: null,
      },
      policy,
    )
    expect(contacting.contactFatigueCost).toBeGreaterThan(0)
  })

  it('every monetary field is an integer (property P12, as a direct example)', () => {
    const breakdown = computeEv(
      {
        action: 'ESCALATE_HUMAN',
        pBase: 0.3333333333,
        pRecover: 0.4,
        amount: fromRupees(1234), // an odd, non-round amount
        contactsLast7d: 1,
        expectedLtv: fromRupees(7777),
        allowed: true,
        disallowedReason: null,
      },
      policy,
    )
    for (const field of [
      breakdown.expectedGain,
      breakdown.interventionCost,
      breakdown.computeCost,
      breakdown.riskPenalty,
      breakdown.contactFatigueCost,
      breakdown.ev,
    ]) {
      expect(Number.isInteger(field)).toBe(true)
    }
  })
})
