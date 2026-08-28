/**
 * The webhook route's testable core (BUILD_PLAN.md §5.5 steps 3-5): signature
 * verification, envelope parsing, the replay window, and T1's single
 * insert-then-enqueue transaction. Split out of `app/api/webhooks/razorpay/route.ts`
 * specifically so it can be tested directly — that route also calls Next's
 * `after()`, which throws ("called outside a request scope") anywhere but inside a
 * real Next.js request, making the route itself untestable without a running
 * server. This function has no such dependency.
 */
import type { Deps } from '@/config/container'
import { verifyWebhookSignature } from '@/domain/webhooks/verify-signature'
import { checkReplayWindow } from '@/domain/webhooks/replay-window'
import { WebhookEnvelopeSchema, isDecidableEnvelope } from '@/domain/webhooks/envelope'
import { eventId as toEventId } from '@/domain/ids'
import * as webhookEventsRepo from '@/repositories/webhook-events.repo'
import * as jobQueueRepo from '@/repositories/job-queue.repo'

export interface IngestRequest {
  readonly rawBody: string
  readonly signatureHeader: string | null
  readonly eventIdHeader: string | null
  /** Set only by the in-app batch runner (D9), never by a real webhook delivery.
   * Threaded into the job payload so `process-event.ts` can tell a synthetic
   * demo event from a real one — `resolveExecutionMode`'s `source: 'batch_replay'`
   * (src/ports/executor.ts) structurally forces `dry_run` regardless of
   * credentials, and the worker simulates a synthetic ground-truth outcome only
   * for this source, never for a real delivery. */
  readonly batchId?: string
}

export type IngestResult =
  | { readonly kind: 'invalid_signature' }
  | { readonly kind: 'malformed_body' }
  | { readonly kind: 'invalid_envelope' }
  /** Correctly signed, well-formed, in-window — but this pipeline has no way to
   * price it. See `isDecidableEnvelope`. */
  | { readonly kind: 'undecidable_entity'; readonly entityKinds: readonly string[] }
  | { readonly kind: 'no_event_id' }
  | { readonly kind: 'replay_rejected'; readonly reason: string }
  | { readonly kind: 'duplicate'; readonly eventId: string }
  | { readonly kind: 'accepted'; readonly eventId: string; readonly jobId: string }

export async function ingestRazorpayEvent(deps: Deps, req: IngestRequest): Promise<IngestResult> {
  if (!verifyWebhookSignature(req.rawBody, req.signatureHeader, deps.webhookSecret)) {
    return { kind: 'invalid_signature' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(req.rawBody)
  } catch {
    return { kind: 'malformed_body' }
  }

  const envelopeResult = WebhookEnvelopeSchema.safeParse(parsed)
  if (!envelopeResult.success) {
    return { kind: 'invalid_envelope' }
  }
  const envelope = envelopeResult.data

  const bodyEventId =
    typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string'
      ? parsed.id
      : null
  const rawEventId = req.eventIdHeader ?? bodyEventId
  if (rawEventId === null) {
    return { kind: 'no_event_id' }
  }

  const replay = checkReplayWindow(envelope.created_at, deps.clock.nowMs())
  if (!replay.ok) {
    return { kind: 'replay_rejected', reason: replay.reason ?? 'unknown' }
  }

  // Checked HERE, before anything is enqueued, rather than discovered by the worker
  // three steps later. A `subscription.pending` or `subscription.halted` delivery is
  // genuine, correctly signed, and in-window — and carries no amount anywhere in its
  // body, because the recurring amount lives on the plan and not on the subscription.
  // `decide()` cannot price an action without one. Rejecting it by name beats
  // enqueuing a job that will throw "missing id or amount", which costs a queue slot,
  // a retry cycle, and an operator's time working out that nothing is actually broken.
  if (!isDecidableEnvelope(envelope)) {
    const entityKinds = Object.keys(envelope.payload)
    deps.logger.info(
      { event: 'undecidable_entity', eventType: envelope.event, entityKinds },
      'webhook carried no payment entity, so there is no amount to price an action against',
    )
    return { kind: 'undecidable_entity', entityKinds }
  }

  const eventId = toEventId(rawEventId)

  // T1 — ONE transaction, ONE commit. This INSERT's UNIQUE constraint is the
  // idempotency authority, never a lock in a second datastore (BUILD_PLAN.md §5.1 A1).
  const result = await deps.sql.transaction(async (tx) => {
    const inserted = await webhookEventsRepo.insertIfAbsent(tx, {
      eventId,
      eventType: envelope.event,
      payload: envelope as never,
    })
    if (!inserted) return { duplicate: true as const }

    const { jobId } = await jobQueueRepo.enqueue(tx, {
      kind: 'process_event',
      dedupeKey: `evt:${rawEventId}`,
      payload: req.batchId === undefined ? { eventId: rawEventId } : { eventId: rawEventId, batchId: req.batchId },
    })
    return { duplicate: false as const, jobId }
  })

  if (result.duplicate) {
    return { kind: 'duplicate', eventId: rawEventId }
  }
  return { kind: 'accepted', eventId: rawEventId, jobId: result.jobId }
}
