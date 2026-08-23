import { describe, it, expect } from 'vitest'
import { sigmoid, logit, scoreLogistic, applyActionLift } from '@/domain/scoring/logistic'

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

const MODEL = {
  intercept: -1,
  coefficients: { a: 2, b: -0.5 },
} as const

describe('scoreLogistic', () => {
  it('matches a hand-computed sigmoid(intercept + sum(coef * feature))', () => {
    const p = scoreLogistic(MODEL, { a: 1, b: 2 })
    // z = -1 + 2*1 + -0.5*2 = -1 + 2 - 1 = 0 -> sigmoid(0) = 0.5
    expect(p).toBeCloseTo(0.5, 12)
  })

  it('throws on a missing feature rather than silently treating it as zero', () => {
    expect(() => scoreLogistic(MODEL, { a: 1 } as never)).toThrow(/missing feature/)
  })

  it('throws on a NaN feature rather than propagating it into the linear combination', () => {
    expect(() => scoreLogistic(MODEL, { a: NaN, b: 0 })).toThrow(/NaN/)
  })

  it('stays inside the open unit interval for a feature vector at the ±1e6 extreme (property P11, example case)', () => {
    const high = scoreLogistic(MODEL, { a: 1e6, b: -1e6 })
    const low = scoreLogistic(MODEL, { a: -1e6, b: 1e6 })
    expect(high).toBeGreaterThan(0)
    expect(high).toBeLessThan(1)
    expect(low).toBeGreaterThan(0)
    expect(low).toBeLessThan(1)
  })
})

describe('applyActionLift', () => {
  it('is an identity at liftLogit = 0 — the null action is the reference level', () => {
    expect(applyActionLift(0.71, 0)).toBeCloseTo(0.71, 12)
  })

  it('increases the probability for a positive lift, decreases it for a negative one', () => {
    expect(applyActionLift(0.5, 1)).toBeGreaterThan(0.5)
    expect(applyActionLift(0.5, -1)).toBeLessThan(0.5)
  })

  it('never leaves the open unit interval even under a very large lift', () => {
    expect(applyActionLift(0.99, 50)).toBeLessThan(1)
    expect(applyActionLift(0.01, -50)).toBeGreaterThan(0)
  })
})
