import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SubscriptionAction } from '@/domain/scenario/subscription'

/**
 * The runtime half of the domain-purity guarantee.
 *
 * ESLint boundary rule 1 forbids Date.now(), new Date(), and Math.random() inside
 * src/domain. A lint rule can be disabled with a comment, so this test enforces the
 * same property from the other direction: it replaces both ambient sources of
 * non-determinism with functions that throw, then exercises the domain. Any module
 * that secretly reaches for the clock or a random source fails here, loudly, with a
 * stack trace pointing at the offender.
 *
 * Why this matters beyond tidiness. decide() must be replayable: the policy
 * simulator re-runs a stored batch under a different policy and diffs the result
 * against the baseline. If any part of that path reads the clock or a random source,
 * the diff measures noise instead of the policy change, and the simulator silently
 * becomes a liar rather than obviously breaking.
 *
 * As the domain grows, add each new module to DOMAIN_EXERCISES below. A module that
 * is never exercised here is a module whose purity is merely assumed.
 */

const realDateNow = Date.now
const realMathRandom = Math.random
const RealDate = globalThis.Date

function poison(): void {
  Date.now = () => {
    throw new Error(
      'PURITY VIOLATION: src/domain read the clock. Inject a Clock instead. ' +
        'See src/domain/clock.ts and BUILD_PLAN.md 5.1 commitment A3.',
    )
  }
  Math.random = () => {
    throw new Error(
      'PURITY VIOLATION: src/domain used Math.random. Use the seeded Rng instead. ' +
        'See src/domain/rng.ts.',
    )
  }
  // `new Date()` with no argument reads the clock just as surely as Date.now() does.
  // Built via a Proxy rather than a subclass so that `prototype`, which is
  // non-writable on a function, does not have to be reassigned.
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) {
        throw new Error('PURITY VIOLATION: src/domain constructed new Date() with no argument.')
      }
      return Reflect.construct(target, args) as object
    },
  })
}

function restore(): void {
  Date.now = realDateNow
  Math.random = realMathRandom
  globalThis.Date = RealDate
}

/**
 * Every pure domain module gets an entry. Each entry must exercise real behaviour,
 * not merely import the module, because a module can be import-clean and still read
 * the clock inside the function you actually call.
 */
const DOMAIN_EXERCISES: ReadonlyArray<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'money',
    run: async () => {
      const m = await import('@/domain/money')
      const amount = m.fromRupees(2000)
      const gain = m.expectedValueOf(amount, 0.71)
      const cost = m.milliFromRupees(0.35)
      const ev = m.subMilli(gain, cost)
      m.formatMilli(ev)
      m.toPaise(ev)
      m.addMilli(gain, cost, m.milliPaise(0))
      m.scaleMilli(gain, 0.5)
    },
  },
  {
    name: 'ids',
    run: async () => {
      const ids = await import('@/domain/ids')
      ids.transactionId('pay_QK2f1a')
      ids.eventId('evt_QK2f1a')
      ids.customerId('cust_1')
      ids.batchId('batch_7')
    },
  },
  {
    name: 'rng',
    run: async () => {
      const r = await import('@/domain/rng')
      const gen = r.mulberry32(20260905)
      gen.next()
      gen.int(0, 10)
      gen.bool(0.5)
      gen.pick(['a', 'b'])
      r.hashSeed('pay_QK2f1a')
      r.stableBucket('pay_QK2f1a')
    },
  },
  {
    name: 'clock',
    run: async () => {
      const c = await import('@/domain/clock')
      // The domain may construct a pinned clock. It may not read the host clock.
      expect(c.fixedClock(1_756_000_000_000).nowMs()).toBe(1_756_000_000_000)
      const mc = c.manualClock(0)
      mc.advance(1000)
      expect(mc.nowMs()).toBe(1000)
    },
  },
  {
    name: 'json',
    run: async () => {
      const { assertPlain, isPlain } = await import('@/domain/json')
      // Bound to a plain function type: an assertion signature cannot be invoked
      // through a namespace member without an explicit annotation.
      const check: (v: unknown) => void = assertPlain
      check({ a: 1, b: [true, null, 'x'] })
      isPlain({ a: 1 })
    },
  },
  {
    name: 'scoring/logistic',
    run: async () => {
      const { sigmoid, logit } = await import('@/domain/scoring/logistic')
      sigmoid(0.5)
      logit(0.5)
    },
  },
  {
    name: 'scoring/recovery-model',
    run: async () => {
      const { scoreRow, RecoveryModelSchema } = await import('@/domain/scoring/recovery-model')
      const model = RecoveryModelSchema.parse({
        featureOrder: ['a'],
        intercept: 0,
        coefficients: [1],
        plattA: 1,
        plattB: 0,
        goldenVectors: [],
      })
      scoreRow(model, [0.5])
    },
  },
  {
    name: 'risk/rules',
    run: async () => {
      const { evaluateRisk } = await import('@/domain/risk/rules')
      evaluateRisk(
        { geoMismatch: true, cardVelocityHigh: false, amountFarAboveHistory: false, cardFirstSeenRecently: false },
        0.5,
      )
    },
  },
  {
    name: 'ev',
    run: async () => {
      const { computeEv } = await import('@/domain/ev')
      const { SUBSCRIPTION_DEFAULT_POLICY } = await import('@/domain/scenario/subscription')
      const { fromRupees } = await import('@/domain/money')
      computeEv(
        {
          action: 'DO_NOTHING',
          pBase: 0.5,
          pRecover: 0.5,
          amount: fromRupees(1000),
          contactsLast7d: 0,
          expectedLtv: fromRupees(1000),
          allowed: true,
          disallowedReason: null,
        },
        SUBSCRIPTION_DEFAULT_POLICY,
      )
    },
  },
  {
    name: 'decide',
    run: async () => {
      const { decide } = await import('@/domain/decide')
      const { SUBSCRIPTION_SCENARIO, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_ACTIONS } = await import(
        '@/domain/scenario/subscription'
      )
      const { fromRupees } = await import('@/domain/money')
      decide(
        {
          transactionId: 'pay_purity',
          eventId: 'evt_purity',
          nowMs: 0,
          amount: fromRupees(1000),
          retryCount: 0,
          contactsLast7d: 0,
          expectedLtv: fromRupees(1000),
          features: {
            prior_success_rate: 0.5,
            days_since_last_failure: 1,
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
          risk: {
            geoMismatch: false,
            cardVelocityHigh: false,
            amountFarAboveHistory: false,
            cardFirstSeenRecently: false,
          },
          shockSuppressed: false,
          optedOut: false,
          capabilityAvailable: Object.fromEntries(
            SUBSCRIPTION_ACTIONS.map((a: string) => [a, true]),
          ) as Record<SubscriptionAction, boolean>,
        },
        SUBSCRIPTION_DEFAULT_POLICY,
        SUBSCRIPTION_SCENARIO,
      )
    },
  },
  {
    name: 'dedupe',
    run: async () => {
      const { dedupeByEventId } = await import('@/domain/dedupe')
      dedupeByEventId([{ eventId: 'a' }, { eventId: 'a' }])
    },
  },
  {
    name: 'metrics',
    run: async () => {
      const { computeBatchMetrics, computeDoNothingBreakdown, countByDisallowedReason } = await import(
        '@/domain/metrics'
      )
      const { fromRupees, ZERO_MILLI } = await import('@/domain/money')
      computeBatchMetrics(
        [
          {
            amount: fromRupees(100),
            chosenAction: 'DO_NOTHING',
            outcome: 'success',
            llmCostMilli: ZERO_MILLI,
            decisionLatencyMs: 10,
          },
        ],
        'ESCALATE_HUMAN',
      )
      computeDoNothingBreakdown([{ amount: fromRupees(100), wasEscalationForced: false }])
      countByDisallowedReason(['opted_out', null])
    },
  },
  {
    name: 'webhooks/verify-signature',
    run: async () => {
      const { computeWebhookSignature, verifyWebhookSignature } = await import(
        '@/domain/webhooks/verify-signature'
      )
      const sig = computeWebhookSignature('{"a":1}', 'secret')
      verifyWebhookSignature('{"a":1}', sig, 'secret')
    },
  },
  {
    name: 'webhooks/replay-window',
    run: async () => {
      const { checkReplayWindow } = await import('@/domain/webhooks/replay-window')
      checkReplayWindow(1_735_689_600, 1_735_689_600_000)
    },
  },
  {
    name: 'webhooks/envelope',
    run: async () => {
      const { WebhookEnvelopeSchema, extractPrimaryEntity, extractFacts } = await import(
        '@/domain/webhooks/envelope'
      )
      const envelope = WebhookEnvelopeSchema.parse({
        entity: 'event',
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_x' } } },
      })
      const primary = extractPrimaryEntity(envelope)
      if (primary !== null) extractFacts(primary.entity)
    },
  },
]

describe('src/domain is pure', () => {
  beforeEach(poison)
  afterEach(restore)

  it('the poison harness actually works', () => {
    // A guard that cannot fail is not a guard. Prove the trap fires before trusting
    // the assertions that depend on it.
    expect(() => Date.now()).toThrow(/PURITY VIOLATION/)
    expect(() => Math.random()).toThrow(/PURITY VIOLATION/)
    expect(() => new Date()).toThrow(/PURITY VIOLATION/)
    // A Date built from an explicit value is still allowed, since it reads no clock.
    expect(new Date(0).getTime()).toBe(0)
  })

  for (const { name, run } of DOMAIN_EXERCISES) {
    it(`${name} touches neither the clock nor a random source`, async () => {
      await run()
    })
  }
})

describe('the seeded rng is genuinely independent of Math.random', () => {
  it('produces the same stream whether Math.random is poisoned or not', async () => {
    const { mulberry32 } = await import('@/domain/rng')

    const clean = Array.from({ length: 50 }, () => mulberry32(42).next())

    poison()
    let poisoned: number[]
    try {
      poisoned = Array.from({ length: 50 }, () => mulberry32(42).next())
    } finally {
      restore()
    }

    expect(poisoned).toEqual(clean)
  })
})
