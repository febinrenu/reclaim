/**
 * All money in Reclaim is an integer. This is not fastidiousness, it is a
 * correctness requirement with three separate causes:
 *
 *  1. Floats put `12.399999999999998` on screen. On camera, in a fintech demo,
 *     that single artifact undoes the impression the whole project is trying to make.
 *
 *  2. Float addition is not associative. The policy simulator compares a baseline
 *     run against a variant run by diffing aggregates. With floats, reordering alone
 *     produces phantom deltas, so the simulator could report a difference where the
 *     policy change had no effect at all.
 *
 *  3. A reviewer must be able to regenerate our exact numbers. Integer sums are
 *     bit-identical across runs, machines, and architectures. Float sums are not.
 *
 * Two units, both integers:
 *   Paise      1/100 rupee.    The unit money actually arrives in.
 *   MilliPaise 1/100000 rupee. The unit expected-value arithmetic happens in.
 *
 * MilliPaise exists because a single language-model call costs on the order of
 * 0.02 paise. Rounding that to Paise would floor it to zero and silently delete
 * the compute term from the EV formula.
 */

declare const PAISE: unique symbol
declare const MILLI: unique symbol

export type Paise = number & { readonly [PAISE]: true }
export type MilliPaise = number & { readonly [MILLI]: true }

/** MilliPaise per Paise. */
export const MILLI_PER_PAISA = 1_000

/** Paise per Rupee. */
export const PAISE_PER_RUPEE = 100

/** MilliPaise per Rupee. */
export const MILLI_PER_RUPEE = MILLI_PER_PAISA * PAISE_PER_RUPEE

function assertSafeInt(n: number, unit: string): void {
  if (!Number.isFinite(n)) {
    throw new RangeError(`${unit} must be finite, received ${n}`)
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `${unit} must be a safe integer, received ${n}. ` +
        `Money is never fractional in this codebase. See src/domain/money.ts.`,
    )
  }
}

/** Construct Paise from an integer. Throws on anything fractional or unsafe. */
export function paise(n: number): Paise {
  assertSafeInt(n, 'Paise')
  return n as Paise
}

/** Construct MilliPaise from an integer. Throws on anything fractional or unsafe. */
export function milliPaise(n: number): MilliPaise {
  assertSafeInt(n, 'MilliPaise')
  return n as MilliPaise
}

export const ZERO_PAISE: Paise = 0 as Paise
export const ZERO_MILLI: MilliPaise = 0 as MilliPaise

/**
 * Rupees to Paise, at the input boundary only.
 *
 * Rounding is half-away-from-zero and is stated explicitly rather than inherited
 * from Math.round, whose behaviour on negatives (-0.5 rounds to -0) is a trap.
 * A cost table written as 0.35 rupees must land on exactly 35 paise every time.
 */
export function fromRupees(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new RangeError(`rupees must be finite, received ${rupees}`)
  }
  const scaled = rupees * PAISE_PER_RUPEE
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return paise(rounded)
}

/** Rupees to MilliPaise. Used by cost tables, where sub-paise precision matters. */
export function milliFromRupees(rupees: number): MilliPaise {
  if (!Number.isFinite(rupees)) {
    throw new RangeError(`rupees must be finite, received ${rupees}`)
  }
  const scaled = rupees * MILLI_PER_RUPEE
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return milliPaise(rounded)
}

/** Widen Paise into the arithmetic unit. Always exact, never lossy. */
export function toMilli(p: Paise): MilliPaise {
  return milliPaise(p * MILLI_PER_PAISA)
}

/**
 * Narrow MilliPaise back to Paise. Lossy by nature, so rounding is explicit.
 * Only call this at a display or persistence boundary, never mid-calculation.
 */
export function toPaise(m: MilliPaise): Paise {
  const q = m / MILLI_PER_PAISA
  const rounded = q < 0 ? -Math.round(-q) : Math.round(q)
  return paise(rounded)
}

export function addMilli(...xs: readonly MilliPaise[]): MilliPaise {
  let total = 0
  for (const x of xs) total += x
  return milliPaise(total)
}

export function subMilli(a: MilliPaise, b: MilliPaise): MilliPaise {
  return milliPaise(a - b)
}

export function addPaise(...xs: readonly Paise[]): Paise {
  let total = 0
  for (const x of xs) total += x
  return paise(total)
}

/**
 * Scale MilliPaise by a real factor, which is how a probability becomes an
 * expected value. Rounds once, here, at the term boundary. Every EV component
 * rounds exactly once so that a sum of components is a sum of integers.
 */
export function scaleMilli(m: MilliPaise, factor: number): MilliPaise {
  if (!Number.isFinite(factor)) {
    throw new RangeError(`scale factor must be finite, received ${factor}`)
  }
  const scaled = m * factor
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return milliPaise(rounded)
}

/** Multiply an amount by a probability, yielding the expected-gain term. */
export function expectedValueOf(amount: Paise, probability: number): MilliPaise {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError(`probability must lie in [0, 1], received ${probability}`)
  }
  return scaleMilli(toMilli(amount), probability)
}

const INR_GROUPER = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Format for display, with Indian digit grouping, so 842150 rupees reads as
 * 8,42,150.00 rather than 842,150.00. Getting this wrong is an immediate tell
 * to anyone who actually works with rupee figures.
 */
export function formatMilli(m: MilliPaise): string {
  return `${INR_GROUPER.format(m / MILLI_PER_RUPEE)}`
}

export function formatPaise(p: Paise): string {
  return `${INR_GROUPER.format(p / PAISE_PER_RUPEE)}`
}
