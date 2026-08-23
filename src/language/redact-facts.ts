/**
 * Turns a decision's context into the plain, bucketed facts both the model and
 * the cache key ever see. Two separate jobs, both load-bearing:
 *
 *   1. Redaction: nothing PII-shaped (a name, a phone number, a card fingerprint)
 *      crosses into `facts`. The model gets an amount, a bucket, an action, a
 *      count — never anything that identifies a person.
 *   2. Bucketing (BUILD_PLAN.md §5.8 point 2): amount into six bands, days
 *      overdue into four, error code into roughly eight classes. This is what
 *      collapses a few hundred events into a few dozen distinct cache keys —
 *      see cache-key.ts, which hashes these bucketed facts rather than the raw
 *      transaction.
 */
import type { Jsonish } from '@/domain/json'

export type AmountBand = 'under_200' | '200_1000' | '1000_5000' | '5000_20000' | '20000_100000' | 'over_100000'
export type OverdueBand = 'same_day' | 'within_week' | 'within_month' | 'over_month'

const AMOUNT_BAND_CEILINGS: readonly [number, AmountBand][] = [
  [200_00, 'under_200'],
  [1_000_00, '200_1000'],
  [5_000_00, '1000_5000'],
  [20_000_00, '5000_20000'],
  [100_000_00, '20000_100000'],
]

export function amountBand(amountPaise: number): AmountBand {
  for (const [ceiling, band] of AMOUNT_BAND_CEILINGS) {
    if (amountPaise < ceiling) return band
  }
  return 'over_100000'
}

export function overdueBand(daysOverdue: number): OverdueBand {
  if (daysOverdue <= 0) return 'same_day'
  if (daysOverdue <= 7) return 'within_week'
  if (daysOverdue <= 30) return 'within_month'
  return 'over_month'
}

/** Razorpay's own error_reason list is an open string (BUILD_PLAN.md §2.1 C10) —
 * this is deliberately a small, defensible bucketing of the codes this project
 * actually sees, with an explicit default branch, never an exhaustive enum. */
export function errorClass(errorCode: string | null): string {
  if (errorCode === null) return 'unknown'
  const known = ['BAD_REQUEST_ERROR', 'GATEWAY_ERROR', 'SERVER_ERROR']
  return known.includes(errorCode) ? errorCode.toLowerCase() : 'other'
}

export interface RedactFactsInput {
  readonly amountPaise: number
  readonly daysOverdue: number
  readonly errorCode: string | null
  readonly retryCount: number
  readonly isRecurring: boolean
}

/** The plain, bucketed object both the model prompt and the cache key are built
 * from. Every field here is safe to log, safe to send to Groq, and safe to hash
 * into a cache key shared across many different customers' transactions. */
export function redactFacts(input: RedactFactsInput): Jsonish {
  return {
    amountBand: amountBand(input.amountPaise),
    overdueBand: overdueBand(input.daysOverdue),
    errorClass: errorClass(input.errorCode),
    retryCount: Math.min(input.retryCount, 3),
    isRecurring: input.isRecurring,
  }
}
