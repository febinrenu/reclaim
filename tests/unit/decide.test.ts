import { describe, it, expect } from 'vitest'
import { decide } from '@/domain/decide'
import { fromRupees } from '@/domain/money'
import {
  SUBSCRIPTION_SCENARIO,
  SUBSCRIPTION_DEFAULT_POLICY,
  buildSubscriptionFeatures,
  type SubscriptionAction,
  type SubscriptionFeature,
} from '@/domain/scenario/subscription'
import type { DecisionInput } from '@/domain/scenario/types'

const CLEAN_RISK = {
  geoMismatch: false,
  cardVelocityHigh: false,
  amountFarAboveHistory: false,
  cardFirstSeenRecently: false,
}

const ALL_CAPABLE: Readonly<Record<SubscriptionAction, boolean>> = {
  RETRY_NOW: true,
  RETRY_LATER: true,
  PAYMENT_LINK: true,
  WHATSAPP_NUDGE: true,
  ESCALATE_HUMAN: true,
  DO_NOTHING: true,
}

function baseInput(
  overrides: Partial<DecisionInput<SubscriptionAction, SubscriptionFeature>> = {},
): DecisionInput<SubscriptionAction, SubscriptionFeature> {
  return {
    transactionId: 'pay_test',
    eventId: 'evt_test',
    nowMs: 0,
    amount: fromRupees(2000),
    retryCount: 0,
    contactsLast7d: 0,
    expectedLtv: fromRupees(6000),
    features: buildSubscriptionFeatures({
      priorSuccessRate: 0.4,
      daysSinceLastFailure: 1,
      amountZscore: 0,
      retryCount: 0,
      isRecurringSubscription: true,
      hourOfDayUtc: 12,
      bankRecentFailRate: 0.1,
      contactsLast7d: 0,
      ltvZscore: 0,
      customerTenureDays: 180,
      isSoftDecline: false,
      isInsufficientFunds: false,
    }),
    risk: CLEAN_RISK,
    shockSuppressed: false,
    optedOut: false,
    capabilityAvailable: ALL_CAPABLE,
    ...overrides,
  }
}

const scenario = SUBSCRIPTION_SCENARIO
const policy = SUBSCRIPTION_DEFAULT_POLICY

describe('decide', () => {
  it('always returns an entry for every scenario action, allowed or not', () => {
    const decision = decide(baseInput(), policy, scenario)
    expect(decision.breakdown.map((b) => b.action).sort()).toEqual([...scenario.actions].sort())
  })

  it('chooses the argmax over the allowed subset (property P5, as a direct example)', () => {
    const decision = decide(baseInput(), policy, scenario)
    const allowed = decision.breakdown.filter((b) => b.allowed)
    const best = allowed.reduce((a, b) => (b.ev > a.ev ? b : a))
    expect(decision.chosenAction).toBe(best.action)
  })

  it('uplift is EV(chosen) minus EV(the null action) — BUILD_PLAN.md §6.1 correction 1', () => {
    const decision = decide(baseInput(), policy, scenario)
    const nullEv = decision.breakdown.find((b) => b.action === scenario.nullAction)!.ev
    const chosenEv = decision.breakdown.find((b) => b.action === decision.chosenAction)!.ev
    expect(decision.uplift).toBe(chosenEv - nullEv)
  })

  it('DO_NOTHING has a positive organic EV rather than exactly zero', () => {
    const decision = decide(baseInput(), policy, scenario)
    const doNothing = decision.breakdown.find((b) => b.action === 'DO_NOTHING')!
    expect(doNothing.ev).toBeGreaterThan(0)
    expect(doNothing.interventionCost).toBe(0)
  })

  it('forces escalation and disallows everything else once retryCount hits the limit', () => {
    const decision = decide(baseInput({ retryCount: 3 }), policy, scenario)
    expect(decision.chosenAction).toBe('ESCALATE_HUMAN')
    for (const b of decision.breakdown) {
      if (b.action === 'ESCALATE_HUMAN') {
        expect(b.allowed).toBe(true)
      } else {
        expect(b.allowed).toBe(false)
        expect(b.disallowedReason).toBe('stopping_rule')
      }
    }
  })

  it('forces escalation when the risk gate fires, for a very large amount too (property P10, as a direct example)', () => {
    const risky = { geoMismatch: true, cardVelocityHigh: true, amountFarAboveHistory: true, cardFirstSeenRecently: true }
    const decision = decide(baseInput({ risk: risky, amount: fromRupees(50_00_000) }), policy, scenario)
    expect(decision.riskGated).toBe(true)
    expect(decision.chosenAction).toBe('ESCALATE_HUMAN')
  })

  it('disallows a contact-requiring action for an opted-out customer', () => {
    const decision = decide(baseInput({ optedOut: true }), policy, scenario)
    const nudge = decision.breakdown.find((b) => b.action === 'WHATSAPP_NUDGE')!
    expect(nudge.allowed).toBe(false)
    expect(nudge.disallowedReason).toBe('opted_out')
    // Silent actions are untouched by an opt-out, which only concerns contact.
    const retry = decision.breakdown.find((b) => b.action === 'RETRY_NOW')!
    expect(retry.allowed).toBe(true)
  })

  it('distinguishes "this channel is down" from "this customer is unreachable by any channel"', () => {
    const oneChannelDown = decide(
      baseInput({ capabilityAvailable: { ...ALL_CAPABLE, WHATSAPP_NUDGE: false } }),
      policy,
      scenario,
    )
    expect(oneChannelDown.breakdown.find((b) => b.action === 'WHATSAPP_NUDGE')!.disallowedReason).toBe(
      'capability_missing',
    )

    const noChannel = decide(
      baseInput({ capabilityAvailable: { ...ALL_CAPABLE, WHATSAPP_NUDGE: false, PAYMENT_LINK: false } }),
      policy,
      scenario,
    )
    expect(noChannel.breakdown.find((b) => b.action === 'WHATSAPP_NUDGE')!.disallowedReason).toBe('no_contact')
    expect(noChannel.breakdown.find((b) => b.action === 'PAYMENT_LINK')!.disallowedReason).toBe('no_contact')
  })

  it('redirects away from a shock-suppressed action without disallowing everything else', () => {
    const decision = decide(baseInput({ shockSuppressed: true }), policy, scenario)
    const retryNow = decision.breakdown.find((b) => b.action === 'RETRY_NOW')!
    expect(retryNow.allowed).toBe(false)
    expect(retryNow.disallowedReason).toBe('shock_suppressed')
    const retryLater = decision.breakdown.find((b) => b.action === 'RETRY_LATER')!
    expect(retryLater.allowed).toBe(true)
  })

  it('is a pure function: the same input, policy, and scenario always produce the same decision', () => {
    const input = baseInput({ retryCount: 1, contactsLast7d: 2 })
    const a = decide(input, policy, scenario)
    const b = decide(input, policy, scenario)
    expect(a).toEqual(b)
  })
})
