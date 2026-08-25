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
import { addPaise, paise, type Paise, ZERO_PAISE } from '@/domain/money'
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
