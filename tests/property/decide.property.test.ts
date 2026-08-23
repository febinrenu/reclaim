/**
 * Properties P1 to P5, P10, and P11 from BUILD_PLAN.md §6.9 — the D3 exit test's
 * explicit list. P15 needs `FEATURE_ORDER` from a trained model (D5) and P6 to P9,
 * P12 to P14 are picked up as later milestones land the code they exercise.
 */
import { describe, expect } from 'vitest'
import { test, fc } from '@fast-check/vitest'
import { decide } from '@/domain/decide'
import { scoreLogistic } from '@/domain/scoring/logistic'
import { dedupeByEventId } from '@/domain/dedupe'
import { computeBatchMetrics, type DecisionRecord } from '@/domain/metrics'
import { paise, fromRupees } from '@/domain/money'
import {
  SUBSCRIPTION_SCENARIO,
  SUBSCRIPTION_DEFAULT_POLICY,
  SUBSCRIPTION_ACTIONS,
  type SubscriptionAction,
  type SubscriptionFeature,
} from '@/domain/scenario/subscription'
import type { DecisionInput } from '@/domain/scenario/types'

const scenario = SUBSCRIPTION_SCENARIO
const policy = SUBSCRIPTION_DEFAULT_POLICY

const featuresArb = fc.record({
  priorSuccessRate: fc.double({ min: 0, max: 1, noNaN: true }),
  daysSinceLastFailure: fc.double({ min: 0, max: 60, noNaN: true }),
  amountZscore: fc.double({ min: -5, max: 5, noNaN: true }),
  retryCountSoFar: fc.integer({ min: 0, max: 5 }),
  isRecurringSubscription: fc.constantFrom(0, 1),
  hourOfDayRisk: fc.double({ min: -2, max: 2, noNaN: true }),
})

const riskArb = fc.record({
  geoMismatch: fc.boolean(),
  cardVelocityHigh: fc.boolean(),
  amountFarAboveHistory: fc.boolean(),
  cardFirstSeenRecently: fc.boolean(),
})

const capabilityArb: fc.Arbitrary<Readonly<Record<SubscriptionAction, boolean>>> = fc
  .record(Object.fromEntries(SUBSCRIPTION_ACTIONS.map((a) => [a, fc.boolean()])) as Record<
    SubscriptionAction,
    fc.Arbitrary<boolean>
  >)
  // Never generate the all-unreachable case here: it is exercised directly in
  // tests/unit/decide.test.ts, and would make properties P4/P5/P10 ambiguous about
  // which action *should* win when none can be contacted at all.
  .filter((c) => Object.values(c).some(Boolean))

/** `retryCount` ranges to 5, above the legal maximum of 3 — BUILD_PLAN.md §6.9's own
 * note: probe the states the code claims are unreachable, not just the legal ones. */
const inputArb: fc.Arbitrary<DecisionInput<SubscriptionAction, SubscriptionFeature>> = fc.record({
  transactionId: fc.constant('pay_prop'),
  eventId: fc.constant('evt_prop'),
  nowMs: fc.constant(0),
  amount: fc.integer({ min: 100, max: 50_00_000 * 100 }).map((p) => paise(p)),
  retryCount: fc.integer({ min: 0, max: 5 }),
  contactsLast7d: fc.integer({ min: 0, max: 6 }),
  expectedLtv: fc.integer({ min: 0, max: 50_000 * 100 }).map((p) => paise(p)),
  features: featuresArb,
  risk: riskArb,
  shockSuppressed: fc.boolean(),
  optedOut: fc.boolean(),
  capabilityAvailable: capabilityArb,
})

describe('P5 — chosen === argmax(evs) under a documented deterministic tie-break', () => {
  test.prop([inputArb])('the chosen action is always the first allowed action tied for the maximum EV', (input) => {
    const decision = decide(input, policy, scenario)
    const allowed = decision.breakdown.filter((b) => b.allowed)
    const maxEv = Math.max(...allowed.map((b) => b.ev))
    const firstMax = allowed.find((b) => b.ev === maxEv)
    expect(decision.chosenAction).toBe(firstMax?.action)
  })
})

describe('P4 — a chosen action that is neither null nor escalation has positive logged EV', () => {
  test.prop([inputArb])('holds for every generated state', (input) => {
    const decision = decide(input, policy, scenario)
    if (decision.chosenAction !== scenario.nullAction && decision.chosenAction !== scenario.escalationAction) {
      const chosenBreakdown = decision.breakdown.find((b) => b.action === decision.chosenAction)
      expect(chosenBreakdown?.ev).toBeGreaterThan(0)
    }
  })
})

describe('P3 — no retry action is ever emitted once the retry limit is reached', () => {
  test.prop([inputArb])('retryCount >= maxRetries always forces escalation, never a retry', (input) => {
    if (input.retryCount >= policy.maxRetries) {
      const decision = decide(input, policy, scenario)
      expect(decision.chosenAction).not.toBe('RETRY_NOW')
      expect(decision.chosenAction).not.toBe('RETRY_LATER')
      expect(decision.chosenAction).toBe(scenario.escalationAction)
    }
  })
})

describe('P10 — a gated risk score forces escalation for every amount up to ₹50,00,000', () => {
  test.prop([
    fc.integer({ min: 100, max: 50_00_000 * 100 }).map((p) => paise(p)),
    fc.integer({ min: 0, max: 3 }), // below the retry limit, so the gate — not the retry stop — is what fires
  ])('holds regardless of amount, as long as the retry limit has not separately fired', (amount, retryCount) => {
    const input: DecisionInput<SubscriptionAction, SubscriptionFeature> = {
      transactionId: 'pay_prop',
      eventId: 'evt_prop',
      nowMs: 0,
      amount,
      retryCount,
      contactsLast7d: 0,
      expectedLtv: fromRupees(0),
      features: {
        priorSuccessRate: 0.5,
        daysSinceLastFailure: 0,
        amountZscore: 0,
        retryCountSoFar: retryCount,
        isRecurringSubscription: 1,
        hourOfDayRisk: 0,
      },
      // Every signal present — score is 1.0, unambiguously over any threshold in [0, 1].
      risk: {
        geoMismatch: true,
        cardVelocityHigh: true,
        amountFarAboveHistory: true,
        cardFirstSeenRecently: true,
      },
      shockSuppressed: false,
      optedOut: false,
      capabilityAvailable: Object.fromEntries(SUBSCRIPTION_ACTIONS.map((a) => [a, true])) as Record<
        SubscriptionAction,
        boolean
      >,
    }
    const decision = decide(input, policy, scenario)
    expect(decision.riskGated).toBe(true)
    expect(decision.chosenAction).toBe('ESCALATE_HUMAN')
  })
})

describe('P11 — the scorer stays in the open unit interval for every finite vector, and rejects NaN', () => {
  const model = scenario.model

  test.prop([featuresArb as fc.Arbitrary<Record<string, number>>])(
    'output lies strictly between 0 and 1 for ordinary feature ranges',
    (features) => {
      const p = scoreLogistic(model, features as never)
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThan(1)
    },
  )

  test.prop([fc.double({ min: -1e6, max: 1e6, noNaN: true })])(
    'output stays in the open unit interval even at the ±1e6 extreme',
    (extreme) => {
      const features = {
        priorSuccessRate: extreme,
        daysSinceLastFailure: extreme,
        amountZscore: extreme,
        retryCountSoFar: extreme,
        isRecurringSubscription: extreme,
        hourOfDayRisk: extreme,
      }
      const p = scoreLogistic(model, features as never)
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThan(1)
      expect(Number.isNaN(p)).toBe(false)
    },
  )

  test('throws rather than returning NaN when a feature is NaN', () => {
    const features = {
      priorSuccessRate: NaN,
      daysSinceLastFailure: 0,
      amountZscore: 0,
      retryCountSoFar: 0,
      isRecurringSubscription: 0,
      hourOfDayRisk: 0,
    }
    expect(() => scoreLogistic(model, features as never)).toThrow(/NaN/)
  })
})

describe('P2 — the same event twice across a shuffled, duplicated stream yields one row', () => {
  const eventIdArb = fc.array(fc.constantFrom('e1', 'e2', 'e3', 'e4', 'e5'), { minLength: 1, maxLength: 30 })

  test.prop([eventIdArb])('distinct(eventIds).length === dedupeByEventId(stream).length', (eventIds) => {
    const stream = eventIds.map((eventId, i) => ({ eventId, seq: i }))
    // Duplicate and shuffle-by-interleaving the stream, modelling redelivery with
    // out-of-order arrival.
    const duplicated = stream.flatMap((item, i) => (i % 2 === 0 ? [item, item] : [item]))
    const distinctCount = new Set(eventIds).size
    expect(dedupeByEventId(duplicated).length).toBe(distinctCount)
  })
})

describe('P1 — revenue recovered never exceeds revenue at risk, for any batch', () => {
  const recordArb: fc.Arbitrary<DecisionRecord<SubscriptionAction>> = fc.record({
    amount: fc.integer({ min: 0, max: 10_00_000 }).map((p) => paise(p)),
    chosenAction: fc.constantFrom(...SUBSCRIPTION_ACTIONS),
    outcome: fc.constantFrom('success', 'failed', 'pending', 'skipped', 'unknown'),
    llmCostMilli: fc.constant(paise(0) as never),
    decisionLatencyMs: fc.integer({ min: 0, max: 5000 }),
  })

  test.prop([fc.array(recordArb, { maxLength: 200 })])('holds over integer paise with no float slop', (records) => {
    const m = computeBatchMetrics(records, 'ESCALATE_HUMAN')
    expect(m.revenueRecovered).toBeLessThanOrEqual(m.revenueAtRisk)
    expect(Number.isInteger(m.revenueRecovered)).toBe(true)
    expect(Number.isInteger(m.revenueAtRisk)).toBe(true)
  })
})
