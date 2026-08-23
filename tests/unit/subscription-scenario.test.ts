import { describe, it, expect } from 'vitest'
import {
  SUBSCRIPTION_SCENARIO,
  SUBSCRIPTION_ACTIONS,
  SUBSCRIPTION_FEATURES,
  buildSubscriptionFeatures,
} from '@/domain/scenario/subscription'
import { scoreRow } from '@/domain/scoring/recovery-model'

describe('the subscription scenario', () => {
  it('every action has a policy entry for every exhaustive Record field', () => {
    const policy = SUBSCRIPTION_SCENARIO.defaultPolicy
    for (const action of SUBSCRIPTION_ACTIONS) {
      expect(policy.interventionCost[action]).toBeTypeOf('number')
      expect(policy.computeCost[action]).toBeTypeOf('number')
    }
  })

  it('DO_NOTHING is the reference level: zero intervention cost', () => {
    const policy = SUBSCRIPTION_SCENARIO.defaultPolicy
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
      hourOfDayUtc: 6,
      bankRecentFailRate: 0.1,
      contactsLast7d: 2,
      ltvZscore: 0.5,
      customerTenureDays: 90,
      isSoftDecline: false,
      isInsufficientFunds: true,
    })
    expect(Object.keys(features).sort()).toEqual([...SUBSCRIPTION_FEATURES].sort())
    expect(features.is_recurring_subscription).toBe(1) // booleans become 0/1, never true/false
    expect(features.is_insufficient_funds).toBe(1)
    expect(features.is_soft_decline).toBe(0)
    expect(features.retry_count_so_far).toBe(1)
  })

  it('hour_sin / hour_cos round-trip a 24-hour clock (BUILD_PLAN.md §6.7 correction: no more hour_of_day_risk)', () => {
    const midnight = buildSubscriptionFeatures({
      priorSuccessRate: 0.5, daysSinceLastFailure: 0, amountZscore: 0, retryCount: 0,
      isRecurringSubscription: true, hourOfDayUtc: 0, bankRecentFailRate: 0.1,
      contactsLast7d: 0, ltvZscore: 0, customerTenureDays: 0, isSoftDecline: false,
      isInsufficientFunds: false,
    })
    expect(midnight.hour_sin).toBeCloseTo(0, 10)
    expect(midnight.hour_cos).toBeCloseTo(1, 10)

    const sixAm = buildSubscriptionFeatures({
      priorSuccessRate: 0.5, daysSinceLastFailure: 0, amountZscore: 0, retryCount: 0,
      isRecurringSubscription: true, hourOfDayUtc: 6, bankRecentFailRate: 0.1,
      contactsLast7d: 0, ltvZscore: 0, customerTenureDays: 0, isSoftDecline: false,
      isInsufficientFunds: false,
    })
    expect(sixAm.hour_sin).toBeCloseTo(1, 10)
    expect(sixAm.hour_cos).toBeCloseTo(0, 10)
  })

  it("the trained model's coefficients score a real feature vector, for every action, without throwing (property P11, direct example)", () => {
    const features = buildSubscriptionFeatures({
      priorSuccessRate: 0.5, daysSinceLastFailure: 3, amountZscore: 0, retryCount: 0,
      isRecurringSubscription: true, hourOfDayUtc: 14, bankRecentFailRate: 0.1,
      contactsLast7d: 1, ltvZscore: 0, customerTenureDays: 200, isSoftDecline: true,
      isInsufficientFunds: false,
    })
    for (const action of SUBSCRIPTION_ACTIONS) {
      const row = SUBSCRIPTION_SCENARIO.buildModelRow(features, action)
      const p = scoreRow(SUBSCRIPTION_SCENARIO.model, row)
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThan(1)
    }
  })

  it('the null action row has every action dummy and interaction at zero', () => {
    const features = buildSubscriptionFeatures({
      priorSuccessRate: 0.5, daysSinceLastFailure: 3, amountZscore: 1.2, retryCount: 2,
      isRecurringSubscription: true, hourOfDayUtc: 9, bankRecentFailRate: 0.3,
      contactsLast7d: 3, ltvZscore: -0.4, customerTenureDays: 50, isSoftDecline: true,
      isInsufficientFunds: false,
    })
    const row = SUBSCRIPTION_SCENARIO.buildModelRow(features, 'DO_NOTHING')
    // The last 12 columns (5 dummies + 7 interactions) must all be zero for the
    // reference level — see scripts/data/model_spec.py.
    expect(row.slice(13)).toEqual(new Array(12).fill(0))
  })
})
