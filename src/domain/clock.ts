/**
 * Time is injected, never read ambiently.
 *
 * Two reasons, both load-bearing:
 *
 *  1. Every time-dependent rule in this system - the replay window, the retry
 *     backoff rungs, the rolling shock window - is untestable if the code calls
 *     Date.now() inline. The spec's own snippet does exactly that, which is why
 *     its replay-window bug went unnoticed.
 *
 *  2. decide() must be pure so that a stored decision can be replayed under a new
 *     policy and produce a deterministic result. A function that reads the clock is
 *     not replayable.
 *
 * Business logic receives the captured instant as data. ESLint forbids Date.now()
 * and `new Date()` inside src/domain, and tests/unit/purity.test.ts stubs both to
 * throw so the rule cannot be quietly bypassed.
 *
 * The real clock lives in src/adapters/clock/system.ts, because reading the host
 * clock is I/O and therefore an adapter concern. The lint rule below caught that
 * distinction when this file first tried to export it.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number
}

/** A clock pinned to one instant, for tests and for replaying a stored batch. */
export function fixedClock(atMs: number): Clock {
  if (!Number.isFinite(atMs)) {
    throw new RangeError(`fixedClock needs a finite epoch millisecond, received ${atMs}`)
  }
  return { nowMs: () => atMs }
}

/** A clock the test drives by hand, for exercising backoff rungs and window expiry. */
export function manualClock(startMs: number): Clock & { advance(byMs: number): void } {
  let now = startMs
  return {
    nowMs: () => now,
    advance(byMs: number) {
      if (byMs < 0) throw new RangeError('manualClock cannot move backwards')
      now += byMs
    },
  }
}
