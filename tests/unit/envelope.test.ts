import { describe, it, expect } from 'vitest'
import { WebhookEnvelopeSchema, extractPrimaryEntity, extractFacts } from '@/domain/webhooks/envelope'

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
