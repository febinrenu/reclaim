/**
 * Reads `docs/escalation_budget_results.json` (`scripts/data/escalation_budget_sweep.py`,
 * `npm run escalation:sweep`) the same way `app/model/model-data.ts` reads
 * `recovery_model.json` — a committed build artifact, validated at the read
 * boundary rather than cast, so a stale or hand-edited file fails loudly
 * instead of rendering garbage numbers.
 */
import { z } from 'zod'
import escalationBudgetJson from '../../docs/escalation_budget_results.json'

const SweepPointSchema = z.object({
  budget: z.number(),
  escalated_count: z.number(),
  escalated_share_of_split: z.number(),
  net_recovery_inr_per_txn: z.number(),
  pct_of_unconstrained_gap_closed: z.number().nullable(),
})

const CapacityDataSchema = z.object({
  n_events: z.number(),
  n_events_wanting_escalation_unconstrained: z.number(),
  unconstrained_escalation_share: z.number(),
  zero_budget_net_recovery_inr_per_txn: z.number(),
  unconstrained_net_recovery_inr_per_txn: z.number(),
  sweep: z.array(SweepPointSchema),
  knee_thresholds: z.object({
    budget_for_90pct_of_gap: z.number().nullable(),
    budget_for_95pct_of_gap: z.number().nullable(),
    budget_for_99pct_of_gap: z.number().nullable(),
  }),
})

export type SweepPoint = z.infer<typeof SweepPointSchema>
export type CapacityData = z.infer<typeof CapacityDataSchema>

export const CAPACITY_DATA: CapacityData = CapacityDataSchema.parse(escalationBudgetJson)
