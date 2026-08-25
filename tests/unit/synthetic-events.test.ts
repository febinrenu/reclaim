import { describe, it, expect } from 'vitest'
import { makeSyntheticEvents } from '@/app/batch/synthetic-events'

interface SyntheticPayload {
  readonly payload: { readonly payment: { readonly entity: { readonly customer_id: string } } }
}

function customerIdOf(rawBody: string): string {
  return (JSON.parse(rawBody) as SyntheticPayload).payload.payment.entity.customer_id
}

describe('makeSyntheticEvents', () => {
  it('gives every event a distinct customer id within one batch', () => {
    const events = makeSyntheticEvents('batch_a', 40, Date.now())
    const customerIds = events.map((e) => customerIdOf(e.rawBody))
    expect(new Set(customerIds).size).toBe(40)
  })

  it('never reuses a customer id across two different batches — the exact regression that once', () => {
    // silently tripped the live risk gate's cardVelocityHigh signal for every
    // event in every batch after the first few, once real risk signals
    // replaced the hardcoded `false` — see docs/INCIDENTS.md.
    const batchA = makeSyntheticEvents('batch_a', 20, Date.now()).map((e) => customerIdOf(e.rawBody))
    const batchB = makeSyntheticEvents('batch_b', 20, Date.now()).map((e) => customerIdOf(e.rawBody))
    const overlap = batchA.filter((id) => batchB.includes(id))
    expect(overlap).toEqual([])
  })
})
