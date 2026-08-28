import { describe, it, expect } from 'vitest'
import {
  WebhookEnvelopeSchema,
  extractPrimaryEntity,
  extractFacts,
  extractSubscriptionFacts,
  isDecidableEnvelope,
} from '@/domain/webhooks/envelope'

const PAYMENT_FAILED = {
  entity: 'event',
  account_id: 'acc_test',
  event: 'payment.failed',
  contains: ['payment'],
  payload: {
    payment: {
      entity: {
        id: 'pay_test123',
        amount: 50000,
        currency: 'INR',
        status: 'failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'something went wrong',
        customer_id: 'cust_test',
      },
    },
  },
  created_at: 1735689600,
}

describe('WebhookEnvelopeSchema', () => {
  it('parses a real payment.failed envelope', () => {
    expect(() => WebhookEnvelopeSchema.parse(PAYMENT_FAILED)).not.toThrow()
  })

  it('parses a subscription.pending envelope with a different top-level payload key', () => {
    const envelope = {
      ...PAYMENT_FAILED,
      event: 'subscription.pending',
      payload: { subscription: { entity: { id: 'sub_test', status: 'pending' } } },
    }
    expect(() => WebhookEnvelopeSchema.parse(envelope)).not.toThrow()
  })

  it('accepts a missing created_at without throwing — checkReplayWindow decides, not the schema', () => {
    const { created_at: _created_at, ...rest } = PAYMENT_FAILED
    expect(() => WebhookEnvelopeSchema.parse(rest)).not.toThrow()
  })

  it('rejects a payload whose entity is missing entirely', () => {
    expect(() => WebhookEnvelopeSchema.parse({ ...PAYMENT_FAILED, payload: { payment: {} } })).toThrow()
  })
})

describe('extractPrimaryEntity', () => {
  it('finds the single payment entity', () => {
    const envelope = WebhookEnvelopeSchema.parse(PAYMENT_FAILED)
    const primary = extractPrimaryEntity(envelope)
    expect(primary?.kind).toBe('payment')
    expect(primary?.entity.id).toBe('pay_test123')
  })

  it('returns null for an empty payload', () => {
    const envelope = WebhookEnvelopeSchema.parse({ ...PAYMENT_FAILED, payload: {} })
    expect(extractPrimaryEntity(envelope)).toBeNull()
  })
})

describe('extractFacts', () => {
  it('extracts every known field with the right type', () => {
    const envelope = WebhookEnvelopeSchema.parse(PAYMENT_FAILED)
    const primary = extractPrimaryEntity(envelope)!
    const facts = extractFacts(primary.entity)
    expect(facts).toEqual({
      id: 'pay_test123',
      amountPaise: 50000,
      currency: 'INR',
      status: 'failed',
      errorCode: 'BAD_REQUEST_ERROR',
      errorDescription: 'something went wrong',
      customerId: 'cust_test',
      bank: null,
      cardId: null,
    })
  })

  it('extracts a bank code when the entity carries one, as a real netbanking payment does', () => {
    const facts = extractFacts({ id: 'pay_x', amount: 1000, bank: 'HDFC' })
    expect(facts.bank).toBe('HDFC')
  })

  it('extracts a card id when the entity carries one, as a real card payment does', () => {
    const facts = extractFacts({ id: 'pay_x', amount: 1000, card_id: 'card_abc123' })
    expect(facts.cardId).toBe('card_abc123')
  })

  it('returns null for fields of the wrong type rather than coercing', () => {
    const facts = extractFacts({ id: 123, amount: 'not a number' })
    expect(facts.id).toBeNull()
    expect(facts.amountPaise).toBeNull()
  })
})

/**
 * Real Razorpay shapes for the subscription family, which this file previously had no
 * fixture for at all -- and that absence is exactly why the multi-entity bug below
 * survived. `subscription.charged` carries BOTH entities, with `subscription` first;
 * `subscription.pending` and `subscription.halted` carry only the subscription.
 *
 * Note what a subscription entity does NOT have: no `amount`, no `error_code`, no
 * `bank`, no `card_id`. The recurring amount lives on the plan (`plan_id`), so it is
 * not present anywhere in the body.
 */
const SUBSCRIPTION_ENTITY = {
  id: 'sub_test123',
  entity: 'subscription',
  plan_id: 'plan_test123',
  customer_id: 'cust_sub_test',
  status: 'active',
  total_count: 12,
  paid_count: 3,
  remaining_count: 9,
  auth_attempts: 1,
  quantity: 1,
  charge_at: 1735689600,
  payment_method: 'card',
}

/** `subscription` FIRST in the payload, as Razorpay actually sends it. */
const SUBSCRIPTION_CHARGED = {
  entity: 'event',
  account_id: 'acc_test',
  event: 'subscription.charged',
  contains: ['subscription', 'payment'],
  payload: {
    subscription: { entity: SUBSCRIPTION_ENTITY },
    payment: {
      entity: {
        id: 'pay_sub_charge_1',
        amount: 129900,
        currency: 'INR',
        status: 'captured',
        customer_id: 'cust_sub_test',
        card_id: 'card_test123',
      },
    },
  },
  created_at: 1735689600,
}

const SUBSCRIPTION_PENDING = {
  entity: 'event',
  account_id: 'acc_test',
  event: 'subscription.pending',
  contains: ['subscription'],
  payload: {
    subscription: { entity: { ...SUBSCRIPTION_ENTITY, status: 'pending', auth_attempts: 2 } },
  },
  created_at: 1735689600,
}

describe('extractPrimaryEntity, on a multi-entity payload', () => {
  it('picks the payment entity out of a subscription.charged payload, not the subscription', () => {
    const envelope = WebhookEnvelopeSchema.parse(SUBSCRIPTION_CHARGED)
    const primary = extractPrimaryEntity(envelope)

    // The bug this asserts against: `Object.entries(payload)[0]` returned the
    // subscription, which has no amount, so the worker rejected the event as "missing
    // id or amount" -- and `.charged` is the signal that maps to 'recovered'. The most
    // important subscription recovery event was unprocessable.
    expect(primary?.kind).toBe('payment')
    expect(primary?.entity.id).toBe('pay_sub_charge_1')
  })

  it('so the facts it yields are the priceable ones', () => {
    const envelope = WebhookEnvelopeSchema.parse(SUBSCRIPTION_CHARGED)
    const facts = extractFacts(extractPrimaryEntity(envelope)!.entity)
    expect(facts.id).toBe('pay_sub_charge_1')
    expect(facts.amountPaise).toBe(129900)
    expect(facts.status).toBe('captured')
    expect(facts.cardId).toBe('card_test123')
  })

  it('does not depend on payload key order, in either direction', () => {
    // Same two entities, payment first. A webhook sender guarantees nothing about JSON
    // key order, so the result must not change with it.
    const reordered = {
      ...SUBSCRIPTION_CHARGED,
      payload: {
        payment: SUBSCRIPTION_CHARGED.payload.payment,
        subscription: SUBSCRIPTION_CHARGED.payload.subscription,
      },
    }
    const a = extractPrimaryEntity(WebhookEnvelopeSchema.parse(SUBSCRIPTION_CHARGED))
    const b = extractPrimaryEntity(WebhookEnvelopeSchema.parse(reordered))
    expect(a?.kind).toBe(b?.kind)
    expect(a?.entity.id).toBe(b?.entity.id)
  })

  it('still returns the only entity when a payload carries just one', () => {
    // The single-entity path must behave exactly as it did before.
    const payment = extractPrimaryEntity(WebhookEnvelopeSchema.parse(PAYMENT_FAILED))
    expect(payment?.kind).toBe('payment')

    const subscription = extractPrimaryEntity(WebhookEnvelopeSchema.parse(SUBSCRIPTION_PENDING))
    expect(subscription?.kind).toBe('subscription')
  })
})

describe('isDecidableEnvelope', () => {
  it('accepts anything carrying a payment entity, whatever the event is named', () => {
    expect(isDecidableEnvelope(WebhookEnvelopeSchema.parse(PAYMENT_FAILED))).toBe(true)
    // The point: a subscription-named event IS decidable when it brings a payment along.
    expect(isDecidableEnvelope(WebhookEnvelopeSchema.parse(SUBSCRIPTION_CHARGED))).toBe(true)
  })

  it('rejects a subscription-only payload, because there is no amount to price against', () => {
    expect(isDecidableEnvelope(WebhookEnvelopeSchema.parse(SUBSCRIPTION_PENDING))).toBe(false)
  })

  it('rejects an empty payload rather than throwing', () => {
    const empty = WebhookEnvelopeSchema.parse({ ...PAYMENT_FAILED, payload: {} })
    expect(isDecidableEnvelope(empty)).toBe(false)
  })
})

describe('extractSubscriptionFacts', () => {
  it('reads the fields a subscription entity actually carries', () => {
    const envelope = WebhookEnvelopeSchema.parse(SUBSCRIPTION_PENDING)
    const facts = extractSubscriptionFacts(extractPrimaryEntity(envelope)!.entity)
    expect(facts.id).toBe('sub_test123')
    expect(facts.status).toBe('pending')
    expect(facts.customerId).toBe('cust_sub_test')
    expect(facts.planId).toBe('plan_test123')
    expect(facts.paidCount).toBe(3)
    expect(facts.remainingCount).toBe(9)
    expect(facts.authAttempts).toBe(2)
    expect(facts.chargeAt).toBe(1735689600)
  })

  it('returns nulls rather than throwing on a payment entity, which has none of them', () => {
    const envelope = WebhookEnvelopeSchema.parse(PAYMENT_FAILED)
    const facts = extractSubscriptionFacts(extractPrimaryEntity(envelope)!.entity)
    expect(facts.planId).toBeNull()
    expect(facts.paidCount).toBeNull()
    expect(facts.authAttempts).toBeNull()
    // `id` and `status` exist on both entity kinds, so those do come through -- which is
    // why the two extractors are separate functions and not one merged shape.
    expect(facts.id).toBe('pay_test123')
    expect(facts.status).toBe('failed')
  })

  it('confirms a subscription entity carries no amount anywhere', () => {
    // The whole reason subscription-only events cannot be priced. If Razorpay ever adds
    // an amount to the subscription entity, this assertion is where that shows up.
    const envelope = WebhookEnvelopeSchema.parse(SUBSCRIPTION_PENDING)
    const entity = extractPrimaryEntity(envelope)!.entity
    expect(extractFacts(entity).amountPaise).toBeNull()
    expect(entity.amount).toBeUndefined()
  })
})
