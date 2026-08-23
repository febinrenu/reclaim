/**
 * Pure batch-level aggregation, over whatever the worker eventually writes to
 * `recovery_audit` (D6 onward). SYSTEM_SPEC.md §13 lists what a batch report must
 * show; this module computes each of those numbers from an array of records with
 * zero I/O, so the dashboard (D9) and any report script can share one
 * implementation instead of recomputing the same sums twice.
 *
 * Money in, money out: every sum stays in `Paise`/`MilliPaise`, never a float, so a
 * batch total is exact regardless of how many rows fed it — property P12 (every
 * monetary output is an integer) and property P1 (recovered can never exceed
 * at-risk) both hold as inspectable facts about this module rather than by
 * convention.
 */
import { addPaise, addMilli, type Paise, type MilliPaise, ZERO_PAISE } from '@/domain/money'
import type { DisallowedReason } from '@/domain/scenario/types'

export type Outcome = 'success' | 'failed' | 'pending' | 'skipped' | 'unknown'

export interface DecisionRecord<A extends string> {
  readonly amount: Paise
  readonly chosenAction: A
  readonly outcome: Outcome
  readonly llmCostMilli: MilliPaise
  readonly decisionLatencyMs: number
}

export interface BatchMetrics<A extends string> {
  readonly count: number
  readonly revenueAtRisk: Paise
  readonly revenueRecovered: Paise
  /** `revenueRecovered / revenueAtRisk`, or 0 for an empty batch — never NaN. */
  readonly recoveryRate: number
  readonly countByAction: ReadonlyMap<A, number>
  readonly escalatedCount: number
  readonly llmCostTotalMilli: MilliPaise
  readonly latencyP50Ms: number
  readonly latencyP95Ms: number
}

/**
 * Every record's own `outcome === 'success'` is what counts as recovered — this
 * function does not re-derive it, so a record can never be "recovered" for an
 * amount it did not actually recover. That is what makes `revenueRecovered <=
 * revenueAtRisk` (property P1) true by construction rather than something this
 * function has to separately enforce.
 */
export function computeBatchMetrics<A extends string>(
  records: readonly DecisionRecord<A>[],
  escalationAction: A,
): BatchMetrics<A> {
  const revenueAtRisk = addPaise(...records.map((r) => r.amount))
  const revenueRecovered = addPaise(
    ...records.filter((r) => r.outcome === 'success').map((r) => r.amount),
  )

  const countByAction = new Map<A, number>()
  for (const r of records) {
    countByAction.set(r.chosenAction, (countByAction.get(r.chosenAction) ?? 0) + 1)
  }

  const llmCostTotalMilli = addMilli(...records.map((r) => r.llmCostMilli))
  const latencies = records.map((r) => r.decisionLatencyMs).slice().sort((a, b) => a - b)

  return {
    count: records.length,
    revenueAtRisk,
    revenueRecovered,
    recoveryRate: revenueAtRisk === ZERO_PAISE ? 0 : revenueRecovered / revenueAtRisk,
    countByAction,
    escalatedCount: countByAction.get(escalationAction) ?? 0,
    llmCostTotalMilli,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  const value = sorted[idx]
  if (value === undefined) throw new Error('unreachable: idx clamped to array bounds')
  return value
}

/**
 * SYSTEM_SPEC.md §13: "Count and value of DO_NOTHING decisions, broken down by
 * reason." Under BUILD_PLAN.md §6.1 correction 3's hard risk gate, `DO_NOTHING`
 * itself is never the *forced* outcome of a gate firing — a gate firing forces
 * escalation instead (src/domain/decide.ts). So the only real reason `DO_NOTHING`
 * is ever chosen is that it was economically the best allowed action. The
 * `riskGateOverrideCount` bucket is kept, and reported as always zero under this
 * design, rather than removed — "this bucket is structurally empty and here is
 * why" is a stronger, more checkable claim than silently deleting the question
 * SYSTEM_SPEC.md §13 asks.
 */
export interface DoNothingRecord {
  readonly amount: Paise
  readonly wasEscalationForced: boolean
}

export interface DoNothingBreakdown {
  readonly count: number
  readonly value: Paise
  readonly negativeEvCount: number
  readonly negativeEvValue: Paise
  readonly riskGateOverrideCount: number
  readonly riskGateOverrideValue: Paise
}

export function computeDoNothingBreakdown(records: readonly DoNothingRecord[]): DoNothingBreakdown {
  const gateForced = records.filter((r) => r.wasEscalationForced)
  const negativeEv = records.filter((r) => !r.wasEscalationForced)

  return {
    count: records.length,
    value: addPaise(...records.map((r) => r.amount)),
    negativeEvCount: negativeEv.length,
    negativeEvValue: addPaise(...negativeEv.map((r) => r.amount)),
    riskGateOverrideCount: gateForced.length,
    riskGateOverrideValue: addPaise(...gateForced.map((r) => r.amount)),
  }
}

/** For the same table, the reason distribution across every disallowed action —
 * not just `DO_NOTHING` — since the audit trail records the counterfactual for
 * every action, not only the chosen one (SYSTEM_SPEC.md §11). */
export function countByDisallowedReason(
  reasons: readonly (DisallowedReason | null)[],
): ReadonlyMap<DisallowedReason, number> {
  const counts = new Map<DisallowedReason, number>()
  for (const reason of reasons) {
    if (reason === null) continue
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return counts
}
