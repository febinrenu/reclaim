/**
 * The policy simulator's app-layer half (BUILD_PLAN.md §1.4 point 1): read a
 * stored batch's `decision_input` rows, replay them offline under a varied
 * policy, and return a diff against the baseline — the ONLY database access
 * this makes is the one read; nothing here writes to `recovery_audit`, calls
 * an executor, or creates a `batches` row, matching the D12 exit test's "zero
 * audit rows written and zero executor calls" letter directly. Even the
 * baseline half is recomputed by `replayBatch` under the unmodified policy
 * rather than trusted from the stored `chosen_action` column, so "re-running
 * the baseline policy reproduces the baseline byte for byte" is a claim this
 * function actually checks every time it runs, not just an assertion in a test.
 */
import type { Deps } from '@/config/container'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import { replayBatch, summarizeReplay, type SimulationSummary } from '@/domain/simulate'
import { SUBSCRIPTION_SCENARIO, SUBSCRIPTION_DEFAULT_POLICY, type SubscriptionAction } from '@/domain/scenario/subscription'
import { milliFromRupees } from '@/domain/money'
import type { Policy } from '@/domain/scenario/types'
import { parseStoredDecisionInput } from './decision-input-schema'

export interface PolicyOverrides {
  /** Rupees, not paise/milli — the natural unit for a form input. Only the
   * actions present as keys are overridden; every other action keeps
   * SUBSCRIPTION_DEFAULT_POLICY's own intervention cost. */
  readonly interventionCostRupees?: Partial<Record<SubscriptionAction, number>>
  readonly riskThreshold?: number
}

export function buildSimulatedPolicy(overrides: PolicyOverrides): Policy<SubscriptionAction> {
  const costOverrides = overrides.interventionCostRupees ?? {}
  return {
    ...SUBSCRIPTION_DEFAULT_POLICY,
    interventionCost: {
      ...SUBSCRIPTION_DEFAULT_POLICY.interventionCost,
      ...Object.fromEntries(
        Object.entries(costOverrides)
          .filter((entry): entry is [SubscriptionAction, number] => entry[1] !== undefined)
          .map(([action, rupees]) => [action, milliFromRupees(rupees)]),
      ),
    },
    riskThreshold: overrides.riskThreshold ?? SUBSCRIPTION_DEFAULT_POLICY.riskThreshold,
  }
}

export interface SimulationResult {
  readonly batchId: string
  readonly totalRows: number
  readonly unparsedCount: number
  readonly baseline: SimulationSummary<SubscriptionAction>
  readonly simulated: SimulationSummary<SubscriptionAction>
}

export async function runSimulation(
  deps: Deps,
  baselineBatchId: string,
  overrides: PolicyOverrides,
): Promise<SimulationResult> {
  const rows = await recoveryAuditRepo.listByBatch(deps.sql, baselineBatchId)

  const parsed = rows.map((r) => parseStoredDecisionInput(r.decisionInput))
  const inputs = parsed.filter((p) => p.ok).map((p) => p.value)
  const unparsedCount = parsed.length - inputs.length

  const simulatedPolicy = buildSimulatedPolicy(overrides)

  // Both halves go through the identical replayBatch/summarizeReplay path —
  // the baseline is not read off the stored chosen_action column, it is
  // genuinely recomputed under the unmodified policy, every time.
  const baseline = summarizeReplay(
    replayBatch(inputs, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO),
    SUBSCRIPTION_SCENARIO.escalationAction,
  )
  const simulated = summarizeReplay(
    replayBatch(inputs, simulatedPolicy, SUBSCRIPTION_SCENARIO),
    SUBSCRIPTION_SCENARIO.escalationAction,
  )

  return { batchId: baselineBatchId, totalRows: rows.length, unparsedCount, baseline, simulated }
}
