import { describe, it, expect } from 'vitest'
import {
  computeBatchMetrics,
  computeDoNothingBreakdown,
  countByDisallowedReason,
  type DecisionRecord,
} from '@/domain/metrics'
import { fromRupees, milliPaise, ZERO_MILLI } from '@/domain/money'

type A = 'DO_NOTHING' | 'ESCALATE_HUMAN' | 'RETRY_NOW'

function record(overrides: Partial<DecisionRecord<A>>): DecisionRecord<A> {
  return {
    amount: fromRupees(1000),
    chosenAction: 'RETRY_NOW',
    outcome: 'failed',
    llmCostMilli: ZERO_MILLI,
    decisionLatencyMs: 50,
    ...overrides,
  }
}

describe('computeBatchMetrics', () => {
  it('is all zero, not NaN, for an empty batch (property P1 boundary case)', () => {
    const m = computeBatchMetrics<A>([], 'ESCALATE_HUMAN')
    expect(m.count).toBe(0)
    expect(m.revenueAtRisk).toBe(0)
    expect(m.revenueRecovered).toBe(0)
    expect(m.recoveryRate).toBe(0)
    expect(Number.isNaN(m.recoveryRate)).toBe(false)
  })

  it('revenue recovered never exceeds revenue at risk (property P1, as a direct example)', () => {
    const records = [
      record({ amount: fromRupees(500), outcome: 'success' }),
      record({ amount: fromRupees(300), outcome: 'failed' }),
      record({ amount: fromRupees(200), outcome: 'success' }),
    ]
    const m = computeBatchMetrics(records, 'ESCALATE_HUMAN')
    expect(m.revenueAtRisk).toBe(fromRupees(1000))
    expect(m.revenueRecovered).toBe(fromRupees(700))
    expect(m.revenueRecovered).toBeLessThanOrEqual(m.revenueAtRisk)
    expect(m.recoveryRate).toBeCloseTo(0.7, 12)
  })

  it('counts escalations by the caller-supplied escalation action, not a hardcoded string', () => {
    const records = [
      record({ chosenAction: 'ESCALATE_HUMAN' }),
      record({ chosenAction: 'ESCALATE_HUMAN' }),
      record({ chosenAction: 'RETRY_NOW' }),
    ]
    const m = computeBatchMetrics(records, 'ESCALATE_HUMAN')
    expect(m.escalatedCount).toBe(2)
    expect(m.countByAction.get('RETRY_NOW')).toBe(1)
  })

  it('reports p50 and p95 latency, not an average that would hide the tail', () => {
    const latencies = [10, 20, 30, 40, 200]
    const records = latencies.map((ms) => record({ decisionLatencyMs: ms }))
    const m = computeBatchMetrics(records, 'ESCALATE_HUMAN')
    expect(m.latencyP50Ms).toBe(30)
    expect(m.latencyP95Ms).toBe(200)
  })

  it('every monetary total is an integer (property P12, as a direct example)', () => {
    const m = computeBatchMetrics(
      [record({ amount: fromRupees(33.33), llmCostMilli: milliPaise(7) })],
      'ESCALATE_HUMAN',
    )
    expect(Number.isInteger(m.revenueAtRisk)).toBe(true)
    expect(Number.isInteger(m.llmCostTotalMilli)).toBe(true)
  })
})

describe('computeDoNothingBreakdown', () => {
  it('buckets by whether escalation was forced, and the gate-override bucket is honestly reported as zero under the hard-gate design', () => {
    const b = computeDoNothingBreakdown([
      { amount: fromRupees(100), wasEscalationForced: false },
      { amount: fromRupees(200), wasEscalationForced: false },
    ])
    expect(b.count).toBe(2)
    expect(b.negativeEvCount).toBe(2)
    expect(b.riskGateOverrideCount).toBe(0)
    expect(b.value).toBe(fromRupees(300))
  })
})

describe('countByDisallowedReason', () => {
  it('counts every non-null reason and ignores allowed (null) entries', () => {
    const counts = countByDisallowedReason(['opted_out', 'opted_out', 'stopping_rule', null])
    expect(counts.get('opted_out')).toBe(2)
    expect(counts.get('stopping_rule')).toBe(1)
    expect(counts.has('shock_suppressed')).toBe(false)
  })
})
