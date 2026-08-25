/**
 * The one JSON shape both the plain-JSON status route and the SSE stream send
 * (BUILD_PLAN.md D9 exit test: "force polling and the numbers are identical").
 * Money stays in paise/millipaise on the wire — the dashboard formats it, this
 * layer never rounds to rupees, so a client re-summing figures gets exact
 * integers rather than float drift.
 */
import type { BatchReportWithRow } from './run-batch'

export function serializeBatchReport(report: BatchReportWithRow) {
  const { batch, metrics, doNothing, naiveBaseline } = report
  return {
    batch:
      batch === null
        ? null
        : {
            id: batch.id,
            scenario: batch.scenario,
            kind: batch.kind,
            status: batch.status,
            total: batch.total,
            claimed: batch.claimed,
            done: batch.done,
            failed: batch.failed,
            startedAt: batch.startedAt.toISOString(),
            finishedAt: batch.finishedAt === null ? null : batch.finishedAt.toISOString(),
          },
    metrics: {
      count: metrics.count,
      revenueAtRiskPaise: metrics.revenueAtRisk,
      revenueRecoveredPaise: metrics.revenueRecovered,
      recoveryRate: metrics.recoveryRate,
      countByAction: Object.fromEntries(metrics.countByAction),
      escalatedCount: metrics.escalatedCount,
      llmCostTotalMilli: metrics.llmCostTotalMilli,
      latencyP50Ms: metrics.latencyP50Ms,
      latencyP95Ms: metrics.latencyP95Ms,
    },
    doNothing: {
      count: doNothing.count,
      valuePaise: doNothing.value,
      negativeEvCount: doNothing.negativeEvCount,
      negativeEvValuePaise: doNothing.negativeEvValue,
      riskGateOverrideCount: doNothing.riskGateOverrideCount,
      riskGateOverrideValuePaise: doNothing.riskGateOverrideValue,
    },
    naiveBaseline: {
      revenueRecoveredPaise: naiveBaseline.revenueRecovered,
      costPaise: naiveBaseline.cost,
      count: naiveBaseline.count,
    },
  }
}

export type SerializedBatchReport = ReturnType<typeof serializeBatchReport>
