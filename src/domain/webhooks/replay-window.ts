/**
 * The replay window check (BUILD_PLAN.md §5.5 step 4, §6.10). Two real bugs in the
 * spec's own snippet, both fixed here:
 *
 *   1. `payload.created_at` may be absent or malformed. The spec computes
 *      `Date.now()/1000 - undefined`, which is `NaN`, and `NaN > MAX_AGE` is
 *      **`false`** in JavaScript — so a missing timestamp silently *passes* the
 *      staleness check instead of failing it. Fixed by an explicit
 *      `Number.isFinite` guard before any comparison.
 *   2. The spec's check is one-sided — it only rejects an event that is too old,
 *      never one dated implausibly far in the *future*. A validly-signed event
 *      with a forged future timestamp would pass forever. Fixed with a symmetric
 *      window: too old is rejected the same way too new is.
 *
 * Pure, and takes `nowMs` as an argument rather than reading the clock — an
 * ordinary function outside src/domain would just call `Date.now()`, but this one
 * lives here because BUILD_PLAN.md §6.10 names it as a manufactured-incident
 * candidate, and a pure, unit-testable version is what makes both historical bugs
 * demonstrable with a fixed clock rather than a flaky real-time test.
 */
export type ReplayWindowReason = 'stale' | 'future' | 'invalid_timestamp'

export interface ReplayWindowResult {
  readonly ok: boolean
  readonly reason: ReplayWindowReason | null
  readonly ageSeconds: number | null
}

export interface ReplayWindowOptions {
  readonly maxAgeSeconds: number
  readonly maxSkewSeconds: number
}

export const DEFAULT_REPLAY_WINDOW: ReplayWindowOptions = {
  maxAgeSeconds: 300,
  maxSkewSeconds: 60,
}

export function checkReplayWindow(
  eventCreatedAtSeconds: unknown,
  nowMs: number,
  opts: ReplayWindowOptions = DEFAULT_REPLAY_WINDOW,
): ReplayWindowResult {
  if (typeof eventCreatedAtSeconds !== 'number' || !Number.isFinite(eventCreatedAtSeconds)) {
    return { ok: false, reason: 'invalid_timestamp', ageSeconds: null }
  }

  const ageSeconds = nowMs / 1000 - eventCreatedAtSeconds

  if (ageSeconds > opts.maxAgeSeconds) {
    return { ok: false, reason: 'stale', ageSeconds }
  }
  if (ageSeconds < -opts.maxSkewSeconds) {
    return { ok: false, reason: 'future', ageSeconds }
  }
  return { ok: true, reason: null, ageSeconds }
}
