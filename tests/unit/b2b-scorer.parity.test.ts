/**
 * The B2B receivables scorer's own parity contract (BUILD_PLAN.md §6.8),
 * independent of subscription's — the second instance of the exact same
 * discipline `tests/unit/scorer.parity.test.ts` checks, proving the *parity
 * mechanism* generalizes, not just the scorer architecture.
 */
import { describe, it, expect } from 'vitest'
import { scoreRow } from '@/domain/scoring/recovery-model'
import {
  MODEL_FEATURE_ORDER,
  buildModelRow,
  B2B_RECEIVABLE_RECOVERY_MODEL,
  type SharedFeature,
} from '@/domain/scenario/b2b-receivable-model'

const TOLERANCE = 1e-12

describe('B2B scorer parity: TypeScript reproduces every golden vector from scripts/data_b2b/train_scorer.py', () => {
  it('has at least sixteen golden vectors committed', () => {
    expect(B2B_RECEIVABLE_RECOVERY_MODEL.goldenVectors.length).toBeGreaterThanOrEqual(16)
  })

  it('MODEL_FEATURE_ORDER matches the trained model exactly', () => {
    expect(MODEL_FEATURE_ORDER).toEqual(B2B_RECEIVABLE_RECOVERY_MODEL.featureOrder)
  })

  for (const [i, vector] of B2B_RECEIVABLE_RECOVERY_MODEL.goldenVectors.entries()) {
    it(`golden vector ${i} (${vector.action}) matches to ${TOLERANCE}`, () => {
      const row = buildModelRow(vector.features as Readonly<Record<SharedFeature, number>>, vector.action)
      expect(row).toEqual(vector.row)

      const p = scoreRow(B2B_RECEIVABLE_RECOVERY_MODEL, row)
      expect(Math.abs(p - vector.expectedProbability)).toBeLessThan(TOLERANCE)
    })
  }
})
