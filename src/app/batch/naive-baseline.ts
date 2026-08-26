/**
 * SYSTEM_SPEC.md §13's naive-baseline comparison — "what a retry-everything-
 * immediately system would have recovered and at what cost, computed on the
 * same batch" — reusing D8's own B1 definition (`docs/EVALUATION.md`'s D8
 * section): RETRY_NOW for every transaction, ₹0 intervention plus a real ₹2
 * gateway fee per attempt.
 *
 * Recomputed here from what is already stored on each `recovery_audit` row
 * (`ev_breakdown` carries every action's own `pRecover`, including RETRY_NOW's,
 * whether or not it was the chosen action — BUILD_PLAN.md §11: the EV
 * calculation runs in full for every action, always) rather than persisted
 * separately, and coupled to the SAME synthetic ground-truth draw
 * `src/app/worker/process-event.ts` used for the real Reclaim outcome via
 * `mulberry32(hashSeed(eventId))` — the identical seeded-RNG call, so both
 * policies are compared under common random numbers on the exact same
 * simulated coin flip per transaction, not independent noise.
 */
import { mulberry32, hashSeed } from '@/domain/rng'
import { addPaise, addMilli, paise, milliPaise, type Paise, type MilliPaise, ZERO_PAISE, ZERO_MILLI } from '@/domain/money'
import type { RecoveryAuditRow } from '@/repositories/recovery-audit.repo'

const B1_GATEWAY_FEE_PAISE = 200 // ₹2, D8's own documented assumption for B1

export interface NaiveBaselineMetrics {
  readonly revenueRecovered: Paise
  readonly cost: Paise
  readonly count: number
}

interface EvBreakdownEntry {
  readonly action?: unknown
  readonly pRecover?: unknown
}

function retryNowPRecover(evBreakdown: unknown): number {
  if (!Array.isArray(evBreakdown)) return 0
  const entry = (evBreakdown as EvBreakdownEntry[]).find((b) => b.action === 'RETRY_NOW')
  return typeof entry?.pRecover === 'number' ? entry.pRecover : 0
}

function amountOf(row: RecoveryAuditRow): Paise {
  const input = row.decisionInput as { amount?: unknown }
  return paise(typeof input.amount === 'number' ? input.amount : 0)
}

export function computeNaiveBaseline(rows: readonly RecoveryAuditRow[]): NaiveBaselineMetrics {
  let recovered = ZERO_PAISE
  for (const row of rows) {
    const p = retryNowPRecover(row.evBreakdown)
    const wouldSucceed = mulberry32(hashSeed(row.eventId)).next() < p
    if (wouldSucceed) recovered = addPaise(recovered, amountOf(row))
  }
  return {
    revenueRecovered: recovered,
    cost: paise(rows.length * B1_GATEWAY_FEE_PAISE),
    count: rows.length,
  }
}

/**
 * What Reclaim itself actually spent on this batch — a genuine number, not a
 * placeholder, closing the literal `—` the dashboard used to show in this cell.
 * Split into two parts because they come from different places: `interventionMilli`
 * is the CHOSEN action's own stored cost from its `ev_breakdown` (the same figure
 * `decide()` priced it at — reading it back rather than recomputing a policy table
 * in the UI), and `gatewayFeePaise` applies B1's own ₹2-per-attempt assumption
 * symmetrically, since `SUBSCRIPTION_DEFAULT_POLICY` prices RETRY_NOW/RETRY_LATER's
 * `interventionCost` at ₹0 specifically because B1 books that cost as the gateway
 * fee instead (BUILD_PLAN.md §6.5's B1 definition) — so leaving it out here would
 * silently omit the retry actions' real cost rather than reporting it as ₹0.
 */
export interface PolicySpendMetrics {
  readonly interventionMilli: MilliPaise
  readonly gatewayFeePaise: Paise
  readonly attempts: number
  readonly touched: number
}

interface EvBreakdownCostEntry {
  readonly action?: unknown
  readonly interventionCost?: unknown
  readonly computeCost?: unknown
}

function chosenActionCost(evBreakdown: unknown, chosenAction: string): MilliPaise {
  if (!Array.isArray(evBreakdown)) return ZERO_MILLI
  const entry = (evBreakdown as EvBreakdownCostEntry[]).find((b) => b.action === chosenAction)
  const intervention = typeof entry?.interventionCost === 'number' ? entry.interventionCost : 0
  const compute = typeof entry?.computeCost === 'number' ? entry.computeCost : 0
  return milliPaise(intervention + compute)
}

export function computePolicySpend(
  rows: readonly RecoveryAuditRow[],
  gatewayActions: ReadonlySet<string>,
): PolicySpendMetrics {
  let interventionMilli = ZERO_MILLI
  let attempts = 0
  let touched = 0
  for (const row of rows) {
    interventionMilli = addMilli(interventionMilli, chosenActionCost(row.evBreakdown, row.chosenAction))
    if (gatewayActions.has(row.chosenAction)) attempts++
    if (row.chosenAction !== 'DO_NOTHING') touched++
  }
  return {
    interventionMilli,
    gatewayFeePaise: paise(attempts * B1_GATEWAY_FEE_PAISE),
    attempts,
    touched,
  }
}
