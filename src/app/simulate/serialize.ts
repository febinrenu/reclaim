import type { SimulationResult } from './run-simulation'

export function serializeSimulationResult(result: SimulationResult) {
  const summarize = (s: SimulationResult['baseline']) => ({
    count: s.count,
    countByAction: Object.fromEntries(s.countByAction),
    evMilliTotal: s.evMilliTotal,
    upliftMilliTotal: s.upliftMilliTotal,
    escalatedCount: s.escalatedCount,
  })
  return {
    batchId: result.batchId,
    totalRows: result.totalRows,
    unparsedCount: result.unparsedCount,
    baseline: summarize(result.baseline),
    simulated: summarize(result.simulated),
  }
}

export type SerializedSimulationResult = ReturnType<typeof serializeSimulationResult>
