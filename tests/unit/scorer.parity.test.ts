/**
 * BUILD_PLAN.md §6.8's parity contract, checked for real: every golden vector
 * `scripts/data/train_scorer.py` computed from the Python-side pipeline must match
 * this file's hand-ported `buildModelRow` + `scoreRow` to 1e-12, not 1e-6. That
 * tolerance is deliberate — summing in the same order in both languages is
 * bit-identical in float64, so a failure at 1e-12 means a real ordering or scaling
 * difference, not noise.
 *
 * This is also property P15 in effect: if `MODEL_FEATURE_ORDER` here ever drifted
 * from `SUBSCRIPTION_RECOVERY_MODEL.featureOrder`, the row this file builds would
 * be misaligned with the model's own coefficients, and the golden vectors —
 * computed from the *correct* alignment on the Python side — would fail to
 * reproduce. A silent order mismatch cannot pass this test by accident.
 */
import { describe, it, expect } from 'vitest'
import { scoreRow } from '@/domain/scoring/recovery-model'
import {
  MODEL_FEATURE_ORDER,
  buildModelRow,
  SUBSCRIPTION_RECOVERY_MODEL,
  type SharedFeature,
} from '@/domain/scenario/subscription-model'

const TOLERANCE = 1e-12

describe('scorer parity: TypeScript reproduces every golden vector from train_scorer.py', () => {
  it('has at least sixteen golden vectors committed', () => {
    expect(SUBSCRIPTION_RECOVERY_MODEL.goldenVectors.length).toBeGreaterThanOrEqual(16)
  })

  it('MODEL_FEATURE_ORDER matches the trained model exactly (property P15)', () => {
    expect(MODEL_FEATURE_ORDER).toEqual(SUBSCRIPTION_RECOVERY_MODEL.featureOrder)
  })

  for (const [i, vector] of SUBSCRIPTION_RECOVERY_MODEL.goldenVectors.entries()) {
    it(`golden vector ${i} (${vector.action}) matches to ${TOLERANCE}`, () => {
      const row = buildModelRow(vector.features as Readonly<Record<SharedFeature, number>>, vector.action)
      expect(row).toEqual(vector.row)

      const p = scoreRow(SUBSCRIPTION_RECOVERY_MODEL, row)
      expect(Math.abs(p - vector.expectedProbability)).toBeLessThan(TOLERANCE)
    })
  }
})
