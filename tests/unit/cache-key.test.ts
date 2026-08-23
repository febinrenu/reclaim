import { describe, it, expect } from 'vitest'
import { cacheKeyFor } from '@/language/cache-key'

const BASE = { scenario: 'subscription', action: 'WHATSAPP_NUDGE', locale: 'en-IN' as const, tone: 'neutral' as const }

describe('cacheKeyFor', () => {
  it('is deterministic for identical input', () => {
    const facts = { amountBand: '1000_5000', retryCount: 1 }
    expect(cacheKeyFor({ ...BASE, facts })).toBe(cacheKeyFor({ ...BASE, facts }))
  })

  it('does not depend on key insertion order in facts', () => {
    const a = cacheKeyFor({ ...BASE, facts: { amountBand: '1000_5000', retryCount: 1 } })
    const b = cacheKeyFor({ ...BASE, facts: { retryCount: 1, amountBand: '1000_5000' } })
    expect(a).toBe(b)
  })

  it('differs when the action differs', () => {
    const facts = { amountBand: '1000_5000' }
    const a = cacheKeyFor({ ...BASE, action: 'WHATSAPP_NUDGE', facts })
    const b = cacheKeyFor({ ...BASE, action: 'PAYMENT_LINK', facts })
    expect(a).not.toBe(b)
  })

  it('differs when the tone differs', () => {
    const facts = { amountBand: '1000_5000' }
    const a = cacheKeyFor({ ...BASE, tone: 'neutral', facts })
    const b = cacheKeyFor({ ...BASE, tone: 'urgent', facts })
    expect(a).not.toBe(b)
  })

  it('differs when the bucketed facts differ, but two different exact amounts in the same band collide (the whole point)', () => {
    const same = cacheKeyFor({ ...BASE, facts: { amountBand: '1000_5000' } })
    const differentBand = cacheKeyFor({ ...BASE, facts: { amountBand: '5000_20000' } })
    expect(same).not.toBe(differentBand)
    // Two calls with the identical bucketed representation (the realistic case of
    // two different customers' exact amounts landing in the same band) collide —
    // this is BUILD_PLAN.md §5.8 point 2's "300 events collapse to about 30
    // distinct keys" in miniature.
    expect(cacheKeyFor({ ...BASE, facts: { amountBand: '1000_5000' } })).toBe(same)
  })
})
