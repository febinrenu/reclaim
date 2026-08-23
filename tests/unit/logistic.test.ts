import { describe, it, expect } from 'vitest'
import { sigmoid, logit } from '@/domain/scoring/logistic'

describe('sigmoid', () => {
  it('is 0.5 at z = 0', () => {
    expect(sigmoid(0)).toBe(0.5)
  })

  it('stays strictly inside the open unit interval for extreme finite input', () => {
    expect(sigmoid(1e6)).toBeLessThan(1)
    expect(sigmoid(1e6)).toBeGreaterThan(0)
    expect(sigmoid(-1e6)).toBeGreaterThan(0)
    expect(sigmoid(-1e6)).toBeLessThan(1)
  })

  it('throws rather than returning NaN on NaN input', () => {
    expect(() => sigmoid(NaN)).toThrow(/NaN/)
  })

  it('is monotonically increasing', () => {
    expect(sigmoid(-1)).toBeLessThan(sigmoid(0))
    expect(sigmoid(0)).toBeLessThan(sigmoid(1))
  })
})

describe('logit', () => {
  it('inverts sigmoid at ordinary values', () => {
    expect(logit(sigmoid(1.23))).toBeCloseTo(1.23, 9)
  })

  it('rejects the closed interval boundary and anything outside (0, 1)', () => {
    expect(() => logit(0)).toThrow(/open interval/)
    expect(() => logit(1)).toThrow(/open interval/)
    expect(() => logit(-0.1)).toThrow(/open interval/)
    expect(() => logit(1.1)).toThrow(/open interval/)
    expect(() => logit(NaN)).toThrow(/open interval/)
  })
})
