import { describe, it, expect } from 'vitest'
import { computeNaiveBaseline } from '@/app/batch/naive-baseline'
import { mulberry32, hashSeed } from '@/domain/rng'
import type { RecoveryAuditRow } from '@/repositories/recovery-audit.repo'
import { eventId } from '@/domain/ids'

function row(id: string, amountPaise: number, retryNowPRecover: number): RecoveryAuditRow {
  return {
    id: 'audit_x' as never,
    eventId: eventId(id),
    attemptGeneration: 1,
    transactionId: null,
    batchId: 'batch_x',
    decisionInput: { amount: amountPaise },
    pRecover: null,
    riskScore: null,
    evBreakdown: [
      { action: 'RETRY_NOW', pRecover: retryNowPRecover },
      { action: 'DO_NOTHING', pRecover: 0.01 },
    ],
    chosenAction: 'DO_NOTHING',
    rationale: null,
    evMilli: null,
    upliftMilli: null,
    llmSource: null,
    llmPromptTokens: null,
    llmCompletionTokens: null,
    llmCostMilli: null,
    decisionLatencyMs: null,
    executionMode: 'dry_run',
    outcome: 'pending',
    reconciliationRequired: false,
    createdAt: new Date(0),
  }
}

describe('computeNaiveBaseline', () => {
  it('counts every row toward the ₹2-per-attempt gateway fee, regardless of outcome', () => {
    const rows = [row('evt_1', 100_00, 0), row('evt_2', 200_00, 0)]
    const result = computeNaiveBaseline(rows)
    expect(result.cost).toBe(400) // 2 rows * 200 paise
    expect(result.count).toBe(2)
  })

  it('a row with RETRY_NOW pRecover of 0 never counts as recovered', () => {
    const result = computeNaiveBaseline([row('evt_never', 500_00, 0)])
    expect(result.revenueRecovered).toBe(0)
  })

  it('a row with RETRY_NOW pRecover of 1 always counts as recovered', () => {
    const result = computeNaiveBaseline([row('evt_always', 500_00, 1)])
    expect(result.revenueRecovered).toBe(500_00)
  })

  it('is deterministic — the same event id always draws the same outcome', () => {
    const a = computeNaiveBaseline([row('evt_stable', 300_00, 0.5)])
    const b = computeNaiveBaseline([row('evt_stable', 300_00, 0.5)])
    expect(a.revenueRecovered).toBe(b.revenueRecovered)
  })

  it('is coupled to the exact draw process-event.ts uses for the real outcome', () => {
    // src/app/worker/process-event.ts's synthetic-outcome draw is
    // `mulberry32(hashSeed(evtId)).next() < pRecoverChosen` — this must be the
    // identical call this module makes against RETRY_NOW's own pRecover, so a
    // dashboard's naive-baseline comparison is under common random numbers,
    // not independent noise.
    const p = 0.5
    const expectedDraw = mulberry32(hashSeed('evt_coupled')).next() < p
    const result = computeNaiveBaseline([row('evt_coupled', 700_00, p)])
    expect(result.revenueRecovered).toBe(expectedDraw ? 700_00 : 0)
  })

  it('returns zero revenue for an empty batch', () => {
    const result = computeNaiveBaseline([])
    expect(result).toEqual({ revenueRecovered: 0, cost: 0, count: 0 })
  })
})
