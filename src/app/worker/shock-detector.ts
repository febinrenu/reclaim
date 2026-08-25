/**
 * The systemic-shock detector (SYSTEM_SPEC.md §15, BUILD_PLAN.md §6.10). A
 * rolling 5-minute failure counter per (bank, errorCode) pair; crossing the
 * threshold sets a 15-minute suppression flag that routes `RETRY_NOW` to
 * `RETRY_LATER` with a systemic rationale, via `DecisionInput.shockSuppressed`
 * (already wired into `decide()`/`SUBSCRIPTION_DEFAULT_POLICY.shockSuppressedActions`
 * since D3 — this module is what finally sets that flag from something real).
 *
 * **The spec's snippet has the TTL bug BUILD_PLAN.md §6.10 names explicitly**:
 * `INCR` then `EXPIRE` as two separate calls means a crash between them leaves a
 * key with no expiry — that bank stays suppressed (or its counter stays
 * inflated) forever. This module never does that: it calls `KvPort.incrWithTtl`,
 * whose own contract (src/ports/kv.ts) is a single atomic operation that sets the
 * TTL on creation and never as a second step — every adapter (`postgres.ts`,
 * `memory.ts`) implements it as one statement, so there is no window for a crash
 * to land in between.
 *
 * Key granularity is deliberate, not accidental: `failrate:{bank}:{errorCode}`,
 * never a bare `failrate:{errorCode}`. A single error code (e.g. a generic
 * gateway timeout) spread evenly across many banks is background noise, not one
 * outage — see the "35 events across 4 banks must not trip a per-bank key" decoy
 * in `tests/unit/shock-detector.test.ts`.
 */
import type { KvPort } from '@/ports/kv'

/** 5-minute rolling window, per SYSTEM_SPEC.md §15's own snippet. */
export const FAILRATE_WINDOW_SECONDS = 300
/** 15-minute suppression, per SYSTEM_SPEC.md §15's own snippet. */
export const SUPPRESS_TTL_SECONDS = 900
/**
 * Trips between the two decoys BUILD_PLAN.md §6.10 names: a 12-event
 * sub-threshold cluster (must never trip) and a 30-40-event single-bank burst
 * (must trip, and quickly — the demo fires it "in quick succession"). 20 sits
 * with real margin on both sides.
 */
export const SHOCK_THRESHOLD = 20

const UNKNOWN_BANK = 'unknown'
const UNKNOWN_ERROR_CODE = 'unknown'

function failRateKey(bank: string, errorCode: string): string {
  return `failrate:${bank}:${errorCode}`
}
function suppressKey(bank: string, errorCode: string): string {
  return `suppress:${bank}:${errorCode}`
}

export interface ShockRecordResult {
  readonly failCount: number
  /** True only on the exact call that crosses the threshold — for the burst
   * script's own "trips" counter, distinct from every later call that finds
   * suppression already active. */
  readonly justTripped: boolean
}

/** Call once per genuinely *failed* event — SYSTEM_SPEC.md §15's scenario is
 * "40 payments against one bank's degraded service," and a successful payment
 * carries no information about that. The caller (process-event.ts) is
 * responsible for only calling this on a `status === 'failed'` event. */
export async function recordFailure(
  kv: KvPort,
  bank: string | null,
  errorCode: string | null,
): Promise<ShockRecordResult> {
  const failCount = await kv.incrWithTtl(failRateKey(bank ?? UNKNOWN_BANK, errorCode ?? UNKNOWN_ERROR_CODE), FAILRATE_WINDOW_SECONDS)
  const justTripped = failCount === SHOCK_THRESHOLD + 1
  if (failCount > SHOCK_THRESHOLD) {
    await kv.set(suppressKey(bank ?? UNKNOWN_BANK, errorCode ?? UNKNOWN_ERROR_CODE), '1', SUPPRESS_TTL_SECONDS)
  }
  return { failCount, justTripped }
}

/** Call on every event, failed or not, before deciding — suppression must be
 * checked regardless of this event's own outcome, since it reflects the state
 * of the shared upstream, not this one transaction. */
export async function isShockSuppressed(
  kv: KvPort,
  bank: string | null,
  errorCode: string | null,
): Promise<boolean> {
  const value = await kv.get(suppressKey(bank ?? UNKNOWN_BANK, errorCode ?? UNKNOWN_ERROR_CODE))
  return value !== null
}
