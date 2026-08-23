import { describe, it, expect } from 'vitest'
import { evaluateRisk, DEFAULT_RISK_RULES, type RiskInput } from '@/domain/risk/rules'

const CLEAN: RiskInput = {
  geoMismatch: false,
  cardVelocityHigh: false,
  amountFarAboveHistory: false,
  cardFirstSeenRecently: false,
}

describe('evaluateRisk', () => {
  it('scores a clean transaction at zero and does not gate it', () => {
    const result = evaluateRisk(CLEAN, 0.5)
    expect(result.score).toBe(0)
    expect(result.gated).toBe(false)
  })

  it('sums exactly the weights of the signals actually present', () => {
    const result = evaluateRisk({ ...CLEAN, geoMismatch: true, cardVelocityHigh: true }, 0.5)
    const expected =
      DEFAULT_RISK_RULES.find((r) => r.key === 'geoMismatch')!.weight +
      DEFAULT_RISK_RULES.find((r) => r.key === 'cardVelocityHigh')!.weight
    expect(result.score).toBeCloseTo(expected, 12)
  })

  it('gates when the score meets or exceeds the threshold, not only when it exceeds it', () => {
    const gated = evaluateRisk({ ...CLEAN, cardVelocityHigh: true, cardFirstSeenRecently: true }, 0.5)
    expect(gated.score).toBeGreaterThanOrEqual(0.5)
    expect(gated.gated).toBe(true)
  })

  it('reports every signal, present or not, so the counterfactual is on record', () => {
    const result = evaluateRisk(CLEAN, 0.5)
    expect(result.signals).toHaveLength(DEFAULT_RISK_RULES.length)
    expect(result.signals.every((s) => s.present === false)).toBe(true)
  })

  it('property P9, as a direct example: adding a signal never decreases the score', () => {
    const base = evaluateRisk(CLEAN, 0.5).score
    const withOne = evaluateRisk({ ...CLEAN, geoMismatch: true }, 0.5).score
    expect(withOne).toBeGreaterThanOrEqual(base)
  })
})
