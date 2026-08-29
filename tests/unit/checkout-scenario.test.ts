import { describe, it, expect } from 'vitest'
import { decide } from '@/domain/decide'
import { CHECKOUT_SCENARIO, CHECKOUT_ACTIONS, CHECKOUT_DEFAULT_POLICY } from '@/domain/scenario/checkout'
import { SUBSCRIPTION_SCENARIO, SUBSCRIPTION_ACTIONS } from '@/domain/scenario/subscription'
import { paise, milliPaise } from '@/domain/money'
import type { DecisionInput } from '@/domain/scenario/types'
import type { CheckoutAction } from '@/domain/scenario/checkout'
import type { SubscriptionFeature } from '@/domain/scenario/subscription'

/**
 * The checkout scenario's whole substance is what it REMOVES, so that is what these pin.
 * If `RETRY_NOW` ever reappears in this menu, an abandoned checkout — an order that was
 * created and never charged — could be answered by retrying a payment that never existed.
 */

const FEATURES: Record<SubscriptionFeature, number> = Object.fromEntries(
  SUBSCRIPTION_SCENARIO.features.map((f) => [f, 0]),
) as Record<SubscriptionFeature, number>

function input(overrides: Partial<DecisionInput<CheckoutAction, SubscriptionFeature>> = {}) {
  const capabilityAvailable = Object.fromEntries(
    CHECKOUT_ACTIONS.map((a) => [a, true]),
  ) as Record<CheckoutAction, boolean>

  return {
    transactionId: 'order_test_1',
    eventId: 'evt_test_1',
    nowMs: 1_700_000_000_000,
    amount: paise(250_00),
    features: FEATURES,
    risk: {
      cardVelocityHigh: false,
      cardFirstSeenRecently: false,
      amountFarAboveHistory: false,
      geoMismatch: false,
    },
    shockSuppressed: false,
    optedOut: false,
    capabilityAvailable,
    retryCount: 0,
    contactsLast7d: 0,
    expectedLtv: paise(5_000_00),
    escalationBudgetExhausted: false,
    ...overrides,
  } as DecisionInput<CheckoutAction, SubscriptionFeature>
}

describe('CHECKOUT_SCENARIO', () => {
  it('offers no retry action, because there is no charge to retry', () => {
    expect(CHECKOUT_ACTIONS).not.toContain('RETRY_NOW')
    expect(CHECKOUT_ACTIONS).not.toContain('RETRY_LATER')
    // Only one contact action too — see checkout.ts's own header for why
    // WHATSAPP_NUDGE specifically was the wrong thing to ask a borrowed,
    // uncalibrated probability to choose between.
    expect([...CHECKOUT_ACTIONS].sort()).toEqual(['DO_NOTHING', 'ESCALATE_HUMAN', 'PAYMENT_LINK'].sort())
  })

  it('is a strict subset of the subscription menu, not a divergent one', () => {
    // A new vocabulary would mean a second thing to keep in sync. This is a restriction.
    for (const action of CHECKOUT_ACTIONS) {
      expect(SUBSCRIPTION_ACTIONS as readonly string[]).toContain(action)
    }
  })

  it('reuses the subscription model and row builder verbatim', () => {
    // Identity, not equality: if these ever diverge, the borrowed-scorer caveat in
    // docs/adr/0012 stops describing reality and the scenario needs its own evaluation.
    expect(CHECKOUT_SCENARIO.model).toBe(SUBSCRIPTION_SCENARIO.model)
    expect(CHECKOUT_SCENARIO.buildModelRow).toBe(SUBSCRIPTION_SCENARIO.buildModelRow)
    expect(CHECKOUT_SCENARIO.features).toBe(SUBSCRIPTION_SCENARIO.features)
  })

  it('prices a human and a nudge identically to the subscription scenario', () => {
    // Two prices for one agent-minute would make the scenarios' EV numbers incomparable.
    for (const action of CHECKOUT_ACTIONS) {
      expect(CHECKOUT_DEFAULT_POLICY.interventionCost[action]).toBe(
        SUBSCRIPTION_SCENARIO.defaultPolicy.interventionCost[action],
      )
    }
  })

  it('never returns a retry action from a real decide() call', () => {
    // The end-to-end guarantee, not just the constant. Swept across amounts, because the
    // argmax is amount-sensitive and a cheap ₹0 retry would win at the low end if present.
    for (const rupees of [50, 250, 1_000, 5_000, 50_000]) {
      const decision = decide(
        input({ amount: paise(rupees * 100) }),
        CHECKOUT_DEFAULT_POLICY,
        CHECKOUT_SCENARIO,
      )
      expect(decision.chosenAction).not.toBe('RETRY_NOW')
      expect(decision.chosenAction).not.toBe('RETRY_LATER')
      expect(CHECKOUT_ACTIONS as readonly string[]).toContain(decision.chosenAction)
      // Every action in the menu is priced on the audit record, none omitted.
      expect(decision.breakdown).toHaveLength(CHECKOUT_ACTIONS.length)
    }
  })

  it('still escalates when the risk gate fires', () => {
    // The gate forces escalation regardless of how cheap the alternatives look, which is
    // the one place this scenario must not differ from the others.
    const decision = decide(
      input({
        risk: {
          cardVelocityHigh: true,
          cardFirstSeenRecently: true,
          amountFarAboveHistory: true,
          geoMismatch: false,
        },
      }),
      CHECKOUT_DEFAULT_POLICY,
      CHECKOUT_SCENARIO,
    )
    expect(decision.riskGated).toBe(true)
    expect(decision.chosenAction).toBe('ESCALATE_HUMAN')
  })

  it('can still decline to act, so DO_NOTHING remains reachable', () => {
    // A tiny order where every contact costs more than the expected recovery.
    const decision = decide(
      input({ amount: paise(100), expectedLtv: paise(100) }),
      CHECKOUT_DEFAULT_POLICY,
      CHECKOUT_SCENARIO,
    )
    expect(decision.chosenAction).toBe('DO_NOTHING')
  })

  it('does not fire its own stopping rule on the first event', () => {
    // Regression: maxRetries was briefly 0, and the stopping rule is
    // `retryCount >= maxRetries`, so 0 >= 0 fired immediately and forced ESCALATE_HUMAN
    // at ₹40 on every abandoned checkout including a ₹1 one. A limit meant to stop
    // over-contacting instead mandated the most expensive action available, always.
    expect(CHECKOUT_DEFAULT_POLICY.maxRetries).toBeGreaterThan(0)
    const first = decide(input({ retryCount: 0 }), CHECKOUT_DEFAULT_POLICY, CHECKOUT_SCENARIO)
    expect(first.breakdown.filter((b) => b.allowed).length).toBeGreaterThan(1)

    // And it does still bind once the cart has been chased enough times.
    const exhausted = decide(
      input({ retryCount: CHECKOUT_DEFAULT_POLICY.maxRetries }),
      CHECKOUT_DEFAULT_POLICY,
      CHECKOUT_SCENARIO,
    )
    expect(exhausted.chosenAction).toBe('ESCALATE_HUMAN')

    expect(CHECKOUT_DEFAULT_POLICY.shockSuppressedActions).toEqual([])
  })

  it('names a null action and an escalation action that are both in its own menu', () => {
    // decide() throws at runtime if nullAction is absent from actions; this is the
    // cheaper place to find out.
    expect(CHECKOUT_ACTIONS as readonly string[]).toContain(CHECKOUT_SCENARIO.nullAction)
    expect(CHECKOUT_ACTIONS as readonly string[]).toContain(CHECKOUT_SCENARIO.escalationAction)
  })

  it('computes uplift against doing nothing, not against zero', () => {
    const decision = decide(input(), CHECKOUT_DEFAULT_POLICY, CHECKOUT_SCENARIO)
    const nothing = decision.breakdown.find((b) => b.action === 'DO_NOTHING')
    expect(nothing).toBeDefined()
    // EV(DO_NOTHING) is a real positive number here too — people return to a cart on
    // their own — so uplift must be measured from it.
    expect(nothing!.ev).not.toBe(milliPaise(0))
    expect(decision.uplift).toBe(decision.ev - nothing!.ev)
  })
})
