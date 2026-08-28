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

/**
 * The batch comparison is a PROJECTION, not an experiment, and this block exists so
 * that fact lives in the test suite rather than only in a comment someone can delete.
 *
 * Mechanism: `src/app/worker/process-event.ts` settles a batch event with
 * `mulberry32(hashSeed(eventId)).next() < pRecover(chosen action)`, and
 * `computeNaiveBaseline` uses the identical seeded draw against RETRY_NOW's own
 * `pRecover`. One uniform `u` per event, two thresholds. So the winner is decided by
 * which action has the larger MODELLED probability — and an argmax-EV policy picks
 * higher-`p` actions essentially by construction.
 *
 * These tests assert that dominance directly. If one ever fails, the coupling has
 * changed and the honest-labelling in README.md, docs/RESULTS.md, and
 * app/dashboard/batch-runner.tsx needs to change with it.
 *
 * The measured comparison — every policy scored against per-action outcomes from the
 * generator, which the model never saw — is `scripts/data/run_ope.py` and
 * `docs/RESULTS.md`'s "Measured recovery, on oracle truth" section. That one is an
 * experiment. This one is arithmetic on a prediction.
 */
describe('the naive comparison is model-conditional by construction', () => {
  /** The exact draw both sides use. Kept local so the test never imports the worker. */
  const drawFor = (id: string): number => mulberry32(hashSeed(id)).next()

  it('a chosen action with higher modelled p can never lose to RETRY_NOW on the same event', () => {
    // 400 events, so this is a property over the real hash, not three hand-picked ids.
    for (let i = 0; i < 400; i++) {
      const id = `evt_dominance_${i}`
      const u = drawFor(id)
      const pRetryNow = 0.4
      const pChosen = 0.7 // strictly greater, as an argmax-EV pick typically is

      const naiveRecovers = u < pRetryNow
      const reclaimRecovers = u < pChosen

      // The whole point: naive recovering implies Reclaim recovers. Never the reverse.
      if (naiveRecovers) expect(reclaimRecovers).toBe(true)
    }
  })

  it("so on a batch where every chosen p exceeds RETRY_NOW's, Reclaim cannot lose — before any batch runs", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `evt_batch_proof_${i}`)
    const AMOUNT = 500_00
    const pRetryNow = 0.2
    const pChosen = 0.5

    const naiveRecovered = ids.filter((id) => drawFor(id) < pRetryNow).length * AMOUNT
    const reclaimRecovered = ids.filter((id) => drawFor(id) < pChosen).length * AMOUNT

    expect(reclaimRecovered).toBeGreaterThanOrEqual(naiveRecovered)
    // And it is not a coincidence of this seed: the outcome is a deterministic
    // consequence of pChosen > pRetryNow, which is what makes it a tautology.
    expect(pChosen).toBeGreaterThan(pRetryNow)
  })

  it('computeNaiveBaseline really does use that exact draw, so the coupling is not hypothetical', () => {
    // p = 1 recovers on every draw; p = 0 recovers on none. If the function used any
    // other source of randomness these two would not be exactly total and exactly zero.
    const ids = Array.from({ length: 50 }, (_, i) => `evt_coupling_${i}`)
    const AMOUNT = 100_00

    const always = computeNaiveBaseline(ids.map((id) => row(id, AMOUNT, 1)))
    const never = computeNaiveBaseline(ids.map((id) => row(id, AMOUNT, 0)))

    expect(always.revenueRecovered).toBe(ids.length * AMOUNT)
    expect(never.revenueRecovered).toBe(0)

    // And a mid probability lands strictly between, matching the draw distribution
    // rather than a coin flip the function invented for itself.
    const half = computeNaiveBaseline(ids.map((id) => row(id, AMOUNT, 0.5)))
    const expected = ids.filter((id) => drawFor(id) < 0.5).length * AMOUNT
    expect(half.revenueRecovered).toBe(expected)
  })
})
