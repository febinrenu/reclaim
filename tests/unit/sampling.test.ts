import { describe, it, expect } from 'vitest'
import { shouldSample, createCallCeiling } from '@/language/sampling'

describe('shouldSample', () => {
  it('always returns true for mode "always"', () => {
    for (let i = 0; i < 50; i++) expect(shouldSample(`txn_${i}`, 'always', 8)).toBe(true)
  })

  it('always returns false for mode "never"', () => {
    for (let i = 0; i < 50; i++) expect(shouldSample(`txn_${i}`, 'never', 8)).toBe(false)
  })

  it('is deterministic: the same transactionId always samples the same way', () => {
    const a = shouldSample('pay_stable_id', 'sampled', 8)
    const b = shouldSample('pay_stable_id', 'sampled', 8)
    expect(a).toBe(b)
  })

  it('samples roughly the configured rate over many distinct ids', () => {
    const n = 5000
    const rate = 8
    let sampled = 0
    for (let i = 0; i < n; i++) {
      if (shouldSample(`pay_${i}`, 'sampled', rate)) sampled++
    }
    const actualPercent = (sampled / n) * 100
    expect(actualPercent).toBeGreaterThan(rate - 3)
    expect(actualPercent).toBeLessThan(rate + 3)
  })
})

describe('createCallCeiling', () => {
  it('allows exactly maxCalls reservations, then refuses', () => {
    const ceiling = createCallCeiling(3)
    expect(ceiling.tryReserve()).toBe(true)
    expect(ceiling.tryReserve()).toBe(true)
    expect(ceiling.tryReserve()).toBe(true)
    expect(ceiling.tryReserve()).toBe(false)
    expect(ceiling.used).toBe(3)
  })

  it('a ceiling of 0 refuses immediately', () => {
    const ceiling = createCallCeiling(0)
    expect(ceiling.tryReserve()).toBe(false)
  })
})
