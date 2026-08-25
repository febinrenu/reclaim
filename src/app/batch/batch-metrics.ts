/**
 * Turns a batch's `recovery_audit` rows into everything the D9 dashboard and
 * SYSTEM_SPEC.md §13 ask for: `computeBatchMetrics`/`computeDoNothingBreakdown`
 * (src/domain/metrics.ts, D3, zero I/O) plus the naive-baseline comparison
 * (naive-baseline.ts). This is the one function both the SSE stream and the
 * plain JSON status route call, so the two transports can never disagree.
 */
import { milliPaise, paise, ZERO_MILLI } from '@/domain/money'
import { computeBatchMetrics, computeDoNothingBreakdown, type BatchMetrics, type DoNothingBreakdown } from '@/domain/metrics'
import { SUBSCRIPTION_SCENARIO, type SubscriptionAction } from '@/domain/scenario/subscription'
import type { RecoveryAuditRow } from '@/repositories/recovery-audit.repo'
import { computeNaiveBaseline, type NaiveBaselineMetrics } from './naive-baseline'

export interface BatchReport {
  readonly metrics: BatchMetrics<SubscriptionAction>
  readonly doNothing: DoNothingBreakdown
  readonly naiveBaseline: NaiveBaselineMetrics
}

function amountOf(row: RecoveryAuditRow): number {
  const input = row.decisionInput as { amount?: unknown }
  return typeof input.amount === 'number' ? input.amount : 0
}

export function buildBatchReport(rows: readonly RecoveryAuditRow[]): BatchReport {
  const metrics = computeBatchMetrics(
    rows.map((r) => ({
      amount: paise(amountOf(r)),
      chosenAction: r.chosenAction as SubscriptionAction,
      outcome: r.outcome ?? 'unknown',
      llmCostMilli: r.llmCostMilli === null ? ZERO_MILLI : milliPaise(r.llmCostMilli),
      decisionLatencyMs: r.decisionLatencyMs ?? 0,
    })),
    SUBSCRIPTION_SCENARIO.escalationAction,
  )

  const doNothing = computeDoNothingBreakdown(
    rows
      .filter((r) => r.chosenAction === 'DO_NOTHING')
      .map((r) => ({
        amount: paise(amountOf(r)),
        // decide() never lets the risk gate force DO_NOTHING — a gate firing
        // forces ESCALATE_HUMAN instead (src/domain/decide.ts) — so this bucket
        // is structurally always empty; kept explicit rather than assumed away.
        wasEscalationForced: false,
      })),
  )

  const naiveBaseline = computeNaiveBaseline(rows)

  return { metrics, doNothing, naiveBaseline }
}
