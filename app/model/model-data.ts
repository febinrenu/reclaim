/**
 * The D10 model page's own read of `recovery_model.json` — separate from
 * `src/domain/scenario/subscription-model.ts`'s import, which validates only
 * the fields `scoreRow` actually needs (`RecoveryModelSchema` strips unknown
 * keys, including `metrics`). This module reads the same file for its
 * `metrics`/`calibration_bins`/`prediction_histogram` fields instead, which
 * `train_scorer.py` writes but the pure domain scorer has no use for. Two
 * readers of one committed artifact, not two artifacts.
 */
import { z } from 'zod'
import recoveryModelJson from '../../data/synthetic/subscription/recovery_model.json'

const CalibrationBinSchema = z.object({
  n: z.number(),
  meanPredicted: z.number(),
  observedRate: z.number(),
  wilsonLow: z.number(),
  wilsonHigh: z.number(),
})

const MetricsSchema = z.object({
  n_demo: z.number(),
  n_train: z.number(),
  train_base_rate: z.number(),
  brier_ref: z.number(),
  brier_before_platt: z.number(),
  brier_after_platt: z.number(),
  bss: z.number(),
  roc_auc: z.number(),
  ece: z.record(z.string(), z.number()),
  mce_k10: z.number(),
  murphy_decomposition: z.object({ reliability: z.number(), resolution: z.number(), uncertainty: z.number() }),
  scaler_fold_parity_max_diff: z.number(),
  calibration_bins: z.array(CalibrationBinSchema),
  prediction_histogram: z.object({ counts: z.array(z.number()), binEdges: z.array(z.number()) }),
})

const ModelDataSchema = z.object({
  featureOrder: z.array(z.string()),
  intercept: z.number(),
  coefficients: z.array(z.number()),
  plattA: z.number(),
  plattB: z.number(),
  goldenVectors: z.array(z.unknown()),
  metrics: MetricsSchema,
  trainedOn: z.object({ nTrain: z.number(), nCalibration: z.number(), nDemo: z.number() }),
})

export type CalibrationBin = z.infer<typeof CalibrationBinSchema>
export type ModelMetrics = z.infer<typeof MetricsSchema>

export const MODEL_DATA = ModelDataSchema.parse(recoveryModelJson)
