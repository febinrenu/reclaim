/**
 * The policy gate (BUILD_PLAN.md §5.8 point 1): batch runs sample at 8%, capped
 * at 24 calls per run; the live demo path calls every time. Sampling is
 * deterministic — `stableBucket` (src/domain/rng.ts) hashes the transaction id,
 * so the same 24-ish events get model-drafted copy on every re-run of the same
 * batch. Reviewer reproducibility, not luck.
 */
import { stableBucket } from '@/domain/rng'

export type SamplingMode = 'always' | 'sampled' | 'never'

export function shouldSample(transactionId: string, mode: SamplingMode, ratePercent: number): boolean {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return stableBucket(transactionId) < ratePercent
}

/** Tracks the hard per-run ceiling (BUILD_PLAN.md §5.8 point 1: "a hard ceiling
 * of 24 calls per run"). One instance per batch run — a live single-event path
 * can just use a ceiling of `Infinity`. */
export function createCallCeiling(maxCalls: number): { tryReserve(): boolean; readonly used: number } {
  let used = 0
  return {
    tryReserve(): boolean {
      if (used >= maxCalls) return false
      used++
      return true
    },
    get used() {
      return used
    },
  }
}
