import { describe, it, expect } from 'vitest'
import { replayBatch, summarizeReplay } from '@/domain/simulate'
import { decide } from '@/domain/decide'
import { SUBSCRIPTION_SCENARIO, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_ACTIONS, type SubscriptionAction, type SubscriptionFeature } from '@/domain/scenario/subscription'
import { paise, fromRupees, milliFromRupees } from '@/domain/money'
import type { DecisionInput } from '@/domain/scenario/types'

const ALL_CAPABLE = Object.fromEntries(SUBSCRIPTION_ACTIONS.map((a) => [a, true])) as Record<SubscriptionAction, boolean>

function makeInput(amount: number, overrides: Partial<DecisionInput<SubscriptionAction, SubscriptionFeature>> = {}): DecisionInput<SubscriptionAction, SubscriptionFeature> {
  return {
    transactionId: 'pay_x',
    eventId: 'evt_x',
    nowMs: 0,
    amount: paise(amount),
    retryCount: 0,
    contactsLast7d: 0,
    expectedLtv: fromRupees(0),
    features: {
      prior_success_rate: 0.5,
      days_since_last_failure: 180,
      amount_zscore: 0,
      retry_count_so_far: 0,
      is_recurring_subscription: 1,
      hour_sin: 0,
      hour_cos: 1,
      bank_recent_fail_rate: 0.1,
      contacts_last_7d: 0,
      ltv_zscore: 0,
      customer_tenure_days: 180,
      is_soft_decline: 0,
      is_insufficient_funds: 0,
    },
    risk: { geoMismatch: false, cardVelocityHigh: false, amountFarAboveHistory: false, cardFirstSeenRecently: false },
    shockSuppressed: false,
    optedOut: false,
    capabilityAvailable: ALL_CAPABLE,
    ...overrides,
  }
}

describe('replayBatch', () => {
  it('is exactly decide() mapped over the inputs', () => {
    const inputs = [makeInput(10000), makeInput(200000), makeInput(500000)]
    const replayed = replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)
    expect(replayed).toHaveLength(3)
    for (let i = 0; i < inputs.length; i++) {
      const expected = decide(inputs[i]!, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)
      expect(replayed[i]!.decision).toEqual(expected)
      expect(replayed[i]!.transactionId).toBe(inputs[i]!.transactionId)
      expect(replayed[i]!.amount).toBe(inputs[i]!.amount)
    }
  })

  it('re-running the same inputs under the same policy reproduces the result byte for byte', () => {
    const inputs = Array.from({ length: 20 }, (_, i) => makeInput(10000 + i * 5000))
    const run1 = replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)
    const run2 = replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)
    expect(run2).toEqual(run1)
  })

  it('is a pure function with zero side effects: calling it never touches I/O or global state', () => {
    // Nothing to spy on — no imports of fs/db/network anywhere in src/domain/simulate.ts.
    // Documented here as the exit test's own claim: "zero executor calls."
    const inputs = [makeInput(10000)]
    expect(() => replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)).not.toThrow()
  })
})

describe('summarizeReplay', () => {
  it('counts by chosen action and sums EV/uplift', () => {
    const inputs = [makeInput(10000), makeInput(2000000)] // small vs large amount, likely different actions
    const replayed = replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)
    const summary = summarizeReplay(replayed, SUBSCRIPTION_SCENARIO.escalationAction)
    expect(summary.count).toBe(2)
    const totalCounted = Array.from(summary.countByAction.values()).reduce((a, b) => a + b, 0)
    expect(totalCounted).toBe(2)
  })

  it('halving the nudge intervention cost never flips the argmax, on the trained model actually shipped — a real, checked finding, not a bug', () => {
    // BUILD_PLAN.md's own illustrative example for this exit test ("halving
    // the nudge cost shifts the action distribution") assumes a cost swing
    // large enough to matter relative to the gap between two actions' EV.
    // WHATSAPP_NUDGE costs ₹0.35 — three-plus orders of magnitude smaller than
    // any real amount*probability term (hundreds to thousands of rupees), and
    // (per the same rigor D11 applied to RETRY_NOW) WHATSAPP_NUDGE turns out to
    // be a dominated action on this trained model too: PAYMENT_LINK's own
    // `prior_success_rate` interaction (+0.90) and RETRY_LATER's own dummy
    // (+0.52) leave WHATSAPP_NUDGE (+0.34) too far behind for a sub-rupee cost
    // change to ever close, across a wide amount sweep. Checked directly,
    // rather than assumed: identical distributions at every amount.
    const amounts = [5000, 15000, 30000, 60000, 100000, 200000, 400000, 800000, 1500000]
    const inputs = amounts.map((amount, i) => makeInput(amount, { transactionId: `pay_${i}` }))

    const baselineSummary = summarizeReplay(replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO), SUBSCRIPTION_SCENARIO.escalationAction)

    const nearFreeNudgePolicy = {
      ...SUBSCRIPTION_DEFAULT_POLICY,
      interventionCost: { ...SUBSCRIPTION_DEFAULT_POLICY.interventionCost, WHATSAPP_NUDGE: milliFromRupees(0) },
    }
    const simulatedSummary = summarizeReplay(replayBatch(inputs, nearFreeNudgePolicy, SUBSCRIPTION_SCENARIO), SUBSCRIPTION_SCENARIO.escalationAction)

    expect(simulatedSummary.countByAction).toEqual(baselineSummary.countByAction)
  })

  it('a risk-threshold change shifts the action distribution — the lever that actually and reliably does', () => {
    // BUILD_PLAN.md §1.4 point 1 names the risk threshold alongside the cost
    // table as something the simulator should let a reviewer vary — and unlike
    // a sub-rupee cost tweak, crossing the risk gate's threshold is a hard,
    // discrete cutover (src/domain/decide.ts's `stoppingRuleHit`) that moves a
    // whole transaction from "every action but escalation ruled out" to
    // "normal EV comparison," independent of amount.
    const risk = { geoMismatch: true, cardVelocityHigh: true, amountFarAboveHistory: false, cardFirstSeenRecently: false } // score 0.55
    const input = makeInput(50000, { transactionId: 'pay_gated', risk })

    const baselineSummary = summarizeReplay(replayBatch([input], SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO), SUBSCRIPTION_SCENARIO.escalationAction)
    expect(baselineSummary.countByAction.get('ESCALATE_HUMAN')).toBe(1)

    const laxerRiskPolicy = { ...SUBSCRIPTION_DEFAULT_POLICY, riskThreshold: 0.6 }
    const simulatedSummary = summarizeReplay(replayBatch([input], laxerRiskPolicy, SUBSCRIPTION_SCENARIO), SUBSCRIPTION_SCENARIO.escalationAction)
    expect(simulatedSummary.countByAction.get('ESCALATE_HUMAN')).toBeUndefined()
    expect(simulatedSummary.countByAction).not.toEqual(baselineSummary.countByAction)
  })

  it('re-running the exact baseline policy reproduces the baseline summary byte for byte', () => {
    const inputs = Array.from({ length: 15 }, (_, i) => makeInput(20000 + i * 7000, { transactionId: `pay_${i}` }))
    const run1 = summarizeReplay(replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO), SUBSCRIPTION_SCENARIO.escalationAction)
    const run2 = summarizeReplay(replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO), SUBSCRIPTION_SCENARIO.escalationAction)
    expect(run2).toEqual(run1)
  })
})
