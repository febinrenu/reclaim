import { describe, it, expect } from 'vitest'
import { scoreRow, RecoveryModelSchema } from '@/domain/scoring/recovery-model'

const MODEL = RecoveryModelSchema.parse({
  featureOrder: ['a', 'b'],
  intercept: -1,
  coefficients: [2, -0.5],
  plattA: 1,
  plattB: 0,
  goldenVectors: [],
})

describe('scoreRow', () => {
  it('matches a hand-computed sigmoid(intercept + dot(coefficients, row))', () => {
    // z = -1 + 2*1 + -0.5*2 = 0 -> sigmoid(0) = 0.5
    expect(scoreRow(MODEL, [1, 2])).toBeCloseTo(0.5, 12)
  })

  it('applies Platt scaling on top of the raw logit', () => {
    const scaled = RecoveryModelSchema.parse({ ...MODEL, plattA: 2, plattB: 1 })
    // raw z = -1 + 2*1 + -0.5*2 = 0; platt: 2*0 + 1 = 1 -> sigmoid(1)
    expect(scoreRow(scaled, [1, 2])).toBeCloseTo(1 / (1 + Math.exp(-1)), 12)
  })

  it('throws on a row length mismatch rather than silently ignoring extra or missing values', () => {
    expect(() => scoreRow(MODEL, [1])).toThrow(/row has 1 values, model expects 2/)
    expect(() => scoreRow(MODEL, [1, 2, 3])).toThrow(/row has 3 values, model expects 2/)
  })

  it('throws on a NaN value rather than propagating it into money arithmetic downstream', () => {
    expect(() => scoreRow(MODEL, [1, NaN])).toThrow(/missing or NaN/)
  })

  it('stays inside the open unit interval for a feature at the ±1e6 extreme (property P11, example case)', () => {
    expect(scoreRow(MODEL, [1e6, -1e6])).toBeGreaterThan(0)
    expect(scoreRow(MODEL, [1e6, -1e6])).toBeLessThan(1)
    expect(scoreRow(MODEL, [-1e6, 1e6])).toBeGreaterThan(0)
    expect(scoreRow(MODEL, [-1e6, 1e6])).toBeLessThan(1)
  })
})
