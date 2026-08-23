/**
 * The generic half of the shipped recovery scorer (BUILD_PLAN.md §6.8's parity
 * contract). Nothing here knows about any particular scenario's feature list,
 * action dummies, or interactions — that structure is scenario-specific (see
 * `src/domain/scenario/subscription-model.ts`) because a future scenario (the D12
 * B2B receivables chaser) trains its own model on its own features
 * (SYSTEM_SPEC.md §16: "the same scorer architecture retrained on different
 * features"). This module is just "given a model and a row, produce a probability."
 *
 * Two fixes from BUILD_PLAN.md §6.8, both present because the spec's own inference
 * snippet has these bugs:
 *
 *   1. `scoreRow` takes a dense `readonly number[]`, never a
 *      `feature -> value` map a caller could partially fill in, and throws on a
 *      length mismatch or a NaN rather than silently imputing.
 *   2. The scaler was already folded into `coefficients` in Python (§6.8's
 *      algebra), so this file does a raw dot product with no scaler at all —
 *      there is nothing left here to forget.
 */
import { z } from 'zod'
import { sigmoid } from './logistic'

const GoldenVectorSchema = z.object({
  action: z.string(),
  features: z.record(z.string(), z.number()),
  row: z.array(z.number()),
  expectedProbability: z.number(),
})

export const RecoveryModelSchema = z.object({
  featureOrder: z.array(z.string()),
  intercept: z.number(),
  coefficients: z.array(z.number()),
  plattA: z.number(),
  plattB: z.number(),
  goldenVectors: z.array(GoldenVectorSchema),
})

export type RecoveryModel = z.infer<typeof RecoveryModelSchema>

export function scoreRow(model: RecoveryModel, row: readonly number[]): number {
  if (row.length !== model.coefficients.length) {
    throw new RangeError(
      `scoreRow: row has ${row.length} values, model expects ${model.coefficients.length}`,
    )
  }
  let z = model.intercept
  for (let i = 0; i < row.length; i++) {
    const value = row[i]
    const coefficient = model.coefficients[i]
    if (value === undefined || coefficient === undefined || Number.isNaN(value)) {
      throw new RangeError(`scoreRow: row[${i}] is missing or NaN`)
    }
    z += coefficient * value
  }
  // Platt scaling, fit on logged_calibration only — never on the demo split whose
  // numbers are the only ones that appear anywhere (BUILD_PLAN.md §6.6).
  return sigmoid(model.plattA * z + model.plattB)
}
