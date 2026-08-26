/**
 * Closes a real gap named and deliberately deferred on D11 (BUILD_PLAN.md): a
 * RETRY_NOW/RETRY_LATER decision was decided and audited but nothing ever drove a
 * second real cycle for it — the stopping rule's three-slot ladder
 * (SYSTEM_SPEC.md §14: "at most 3 automated attempts, minimum-spaced immediate,
 * +2h, +24h") had no mechanism behind slots 2 and 3.
 *
 * No new table. `job_queue.available_at` (db/migrations/0002) already lets a job
 * sit unclaimed until a future instant — `claimNext` only picks up rows where
 * `available_at <= now()`. So a follow-up is just another `process_event` job,
 * scheduled ahead, backed by a synthetic-but-real-shaped `webhook_events` row —
 * the exact same idempotency authority and the exact same `processEvent` path a
 * live Razorpay delivery goes through. "Internal" describes who created the row,
 * not a different code path.
 */
import type { SqlExecutor } from '@/ports/sql'
import { eventId as toEventId } from '@/domain/ids'
import type { Jsonish } from '@/domain/json'
import * as webhookEventsRepo from '@/repositories/webhook-events.repo'
import * as jobQueueRepo from '@/repositories/job-queue.repo'
import type { ExtractedFacts } from '@/domain/webhooks/envelope'

/** Gap to the NEXT attempt, keyed by that attempt's retry index. Attempt 0 is
 * "immediate" — this decision cycle itself — so there is no entry for it. Bounded
 * by SUBSCRIPTION_DEFAULT_POLICY.maxRetries (3): indices past 2 never occur, since
 * decide() routes to ESCALATE_HUMAN/DO_NOTHING once retryCount hits the limit and
 * never returns RETRY_NOW/RETRY_LATER for this caller to schedule from. */
const RETRY_DELAY_MS: Readonly<Record<number, number>> = {
  1: 2 * 60 * 60 * 1000, // +2h
  2: 24 * 60 * 60 * 1000, // +24h
}

export interface ScheduleFollowupInput {
  readonly tx: SqlExecutor
  readonly originalEventId: string
  /** The retry index the NEXT attempt will carry, i.e. retryCount after this
   * settle's own increment. */
  readonly nextRetryIndex: number
  readonly nowMs: number
  readonly facts: ExtractedFacts
}

/**
 * Deterministic id (`<original>_retry<n>`), not random: `insertIfAbsent`'s UNIQUE
 * constraint then makes this call idempotent under a T4 reclaim exactly the way
 * every other write in this transaction already is — a crash after this insert
 * but before the transaction commits simply retries the identical insert on
 * replay, and `insertIfAbsent` returning false is "already scheduled," not an
 * error.
 */
export async function scheduleFollowupRetry(input: ScheduleFollowupInput): Promise<void> {
  const delayMs = RETRY_DELAY_MS[input.nextRetryIndex]
  if (delayMs === undefined) return

  const followupEventId = `${input.originalEventId}_retry${input.nextRetryIndex}`
  // Descriptive only, for the synthetic envelope's own `created_at` field — the
  // actual scheduling below is relative to the database's own clock (see
  // job-queue.repo.ts's `availableInSec`), never to this app-clock value, so a
  // fixed/manual clock in tests can never disagree with what `claimNext` compares
  // against.
  const dueAt = new Date(input.nowMs + delayMs)

  // Reuses the identical envelope shape a live payment.failed delivery carries,
  // so processEvent needs no branch to handle this: extractPrimaryEntity and
  // extractFacts work unmodified. `event: 'payment.failed'` is what makes
  // `statusFromEvent` (process-event.ts) resolve 'failed' rather than
  // 'recovered' when this job fires — process-event.ts separately guards against
  // overwriting a transaction a REAL webhook already resolved in the meantime
  // (see `isFollowup` there), so this hardcoded event name never clobbers a
  // genuine recovery.
  const envelope: Jsonish = {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: input.facts.id,
          amount: input.facts.amountPaise,
          currency: input.facts.currency ?? 'INR',
          status: 'failed',
          error_code: input.facts.errorCode,
          error_description: input.facts.errorDescription,
          customer_id: input.facts.customerId,
          bank: input.facts.bank,
          card_id: input.facts.cardId,
        },
      },
    },
    created_at: Math.floor(dueAt.getTime() / 1000),
  }

  const inserted = await webhookEventsRepo.insertIfAbsent(input.tx, {
    eventId: toEventId(followupEventId),
    eventType: 'internal.retry_due',
    payload: envelope,
  })
  if (!inserted) return

  await jobQueueRepo.enqueue(input.tx, {
    kind: 'process_event',
    dedupeKey: `evt:${followupEventId}`,
    payload: { eventId: followupEventId, isFollowup: true },
    availableInSec: Math.round(delayMs / 1000),
  })
}
