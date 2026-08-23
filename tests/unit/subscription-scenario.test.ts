import { describe, it, expect } from 'vitest'
import {
  SUBSCRIPTION_SCENARIO,
  SUBSCRIPTION_ACTIONS,
  SUBSCRIPTION_FEATURES,
  buildSubscriptionFeatures,
} from '@/domain/scenario/subscription'
import { scoreLogistic } from '@/domain/scoring/logistic'

describe('the subscription scenario', () => {
  it('every action has a policy entry for every exhaustive Record field', () => {
    const policy = SUBSCRIPTION_SCENARIO.defaultPolicy
    for (const action of SUBSCRIPTION_ACTIONS) {
      expect(policy.interventionCost[action]).toBeTypeOf('number')
      expect(policy.computeCost[action]).toBeTypeOf('number')
      expect(policy.liftLogit[action]).toBeTypeOf('number')
    }
  })

  it('DO_NOTHING is the reference level: zero lift, zero intervention cost', () => {
    const policy = SUBSCRIPTION_SCENARIO.defaultPolicy
    expect(policy.liftLogit.DO_NOTHING).toBe(0)
    expect(policy.interventionCost.DO_NOTHING).toBe(0)
  })

  it('only contact-requiring actions are marked as such', () => {
    expect(SUBSCRIPTION_SCENARIO.requiresContact('WHATSAPP_NUDGE')).toBe(true)
    expect(SUBSCRIPTION_SCENARIO.requiresContact('PAYMENT_LINK')).toBe(true)
    expect(SUBSCRIPTION_SCENARIO.requiresContact('RETRY_NOW')).toBe(false)
    expect(SUBSCRIPTION_SCENARIO.requiresContact('DO_NOTHING')).toBe(false)
    expect(SUBSCRIPTION_SCENARIO.requiresContact('ESCALATE_HUMAN')).toBe(false)
  })

  it('buildSubscriptionFeatures produces every declared feature, and only those', () => {
    const features = buildSubscriptionFeatures({
      priorSuccessRate: 0.4,
      daysSinceLastFailure: 2,
      amountZscore: -0.3,
      retryCount: 1,
      isRecurringSubscription: true,
      hourOfDayRisk: 0.2,
    })
    expect(Object.keys(features).sort()).toEqual([...SUBSCRIPTION_FEATURES].sort())
    expect(features.isRecurringSubscription).toBe(1) // booleans become 0/1, never true/false
    expect(features.retryCountSoFar).toBe(1)
  })

  it("the placeholder model's coefficients score a real feature vector without throwing", () => {
    const features = buildSubscriptionFeatures({
      priorSuccessRate: 0.5,
      daysSinceLastFailure: 3,
      amountZscore: 0,
      retryCount: 0,
      isRecurringSubscription: true,
      hourOfDayRisk: 0,
    })
    const p = scoreLogistic(SUBSCRIPTION_SCENARIO.model, features)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
  })

  it("the intercept reproduces BUILD_PLAN.md §6.1's ~0.11 organic recovery rate at the zero vector", () => {
    const zero = Object.fromEntries(SUBSCRIPTION_FEATURES.map((f) => [f, 0])) as Record<
      (typeof SUBSCRIPTION_FEATURES)[number],
      number
    >
    const p = scoreLogistic(SUBSCRIPTION_SCENARIO.model, zero)
    expect(p).toBeCloseTo(0.11, 2)
  })
})
