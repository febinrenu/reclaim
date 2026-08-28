/**
 * The Razorpay webhook envelope (BUILD_PLAN.md §2.1 C9, confirmed fields): `entity`,
 * `account_id`, `event`, `contains`, `payload`, `created_at`.
 *
 * **`payload` does NOT always have exactly one key**, which this file assumed until it
 * was checked. A `subscription.charged` delivery carries `contains: ["subscription",
 * "payment"]` and a `payload` with BOTH keys — `subscription` first. The old
 * `Object.entries(payload)[0]` therefore picked the subscription entity, which has no
 * `amount` field at all, and the worker rejected the event as "missing id or amount".
 * That made the single most important subscription recovery signal unprocessable, since
 * `statusFromEvent` maps `.charged` to `'recovered'`. See `extractPrimaryEntity`.
 *
 * `error_reason` and `error_code` are deliberately typed as open strings with no
 * exhaustive enum — BUILD_PLAN.md C10: only `BAD_REQUEST_ERROR`, `GATEWAY_ERROR`,
 * and `SERVER_ERROR` are verifiable `error_code` values, and Razorpay's own
 * exhaustive reason list ships as a spreadsheet, not machine-readable docs.
 * Building an enum here would be asserting a completeness this project cannot back.
 */
import { z } from 'zod'

export const WebhookEnvelopeSchema = z.object({
  entity: z.string(),
  account_id: z.string().optional(),
  event: z.string(),
  contains: z.array(z.string()).optional(),
  payload: z.record(z.string(), z.object({ entity: z.record(z.string(), z.unknown()) })),
  created_at: z.unknown().optional(), // validated separately by checkReplayWindow, which
  // needs to see exactly what arrived — including absent or malformed — rather than
  // have zod coerce or reject it first (that check is the regression test for the
  // spec's own missing-timestamp bug; the schema must not pre-empt it).
})

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>

export interface PrimaryEntity {
  readonly kind: string
  readonly entity: Readonly<Record<string, unknown>>
}

/**
 * The entity this pipeline should decide on.
 *
 * When a payload carries more than one — `subscription.charged` carries both a
 * subscription and a payment — `payment` wins. Not an arbitrary tie-break: the payment
 * entity is the one holding `amount`, `error_code`, `bank`, and `card_id`, which is
 * everything `extractFacts` reads and everything `decide()` needs to price an action. A
 * subscription entity holds none of them. Preferring the first key in object order made
 * the choice depend on JSON key ordering, which is not something a webhook sender
 * guarantees and is not something this pipeline should depend on either.
 *
 * Falls back to the first key when there is no payment entity, so single-entity
 * payloads behave exactly as before.
 */
const PREFERRED_ENTITY_KINDS = ['payment'] as const

export function extractPrimaryEntity(envelope: WebhookEnvelope): PrimaryEntity | null {
  for (const preferred of PREFERRED_ENTITY_KINDS) {
    const wrapper = envelope.payload[preferred]
    if (wrapper !== undefined) return { kind: preferred, entity: wrapper.entity }
  }
  const [kind, wrapper] = Object.entries(envelope.payload)[0] ?? []
  if (kind === undefined || wrapper === undefined) return null
  return { kind, entity: wrapper.entity }
}

/**
 * Everything a Razorpay subscription entity actually carries that is useful here.
 *
 * Deliberately separate from `ExtractedFacts` rather than merged into it, because the
 * two entities have almost nothing in common: a subscription has no `amount`, no
 * `error_code`, no `bank`, no `card_id`. The recurring amount lives on the *plan*
 * (`plan_id`), not on the subscription, so it is not recoverable from the webhook body
 * at all — which is exactly why a subscription-only event cannot be priced by
 * `decide()` and is rejected at ingest with a stated reason instead of failing opaquely
 * in the worker. BUILD_PLAN.md C13's observation that `subscription.pending` is the
 * earlier and more actionable trigger is still true; acting on it needs an amount
 * source this project does not have yet.
 */
export interface SubscriptionFacts {
  readonly id: string | null
  readonly status: string | null
  readonly customerId: string | null
  readonly planId: string | null
  /** How many cycles have been paid — a real recovery-context signal. */
  readonly paidCount: number | null
  readonly remainingCount: number | null
  /** Failed authorisation attempts so far, Razorpay's own counter. */
  readonly authAttempts: number | null
  /** Unix seconds of the next scheduled charge, when one is scheduled. */
  readonly chargeAt: number | null
}

export function extractSubscriptionFacts(
  entity: Readonly<Record<string, unknown>>,
): SubscriptionFacts {
  return {
    id: stringField(entity, 'id'),
    status: stringField(entity, 'status'),
    customerId: stringField(entity, 'customer_id'),
    planId: stringField(entity, 'plan_id'),
    paidCount: numberField(entity, 'paid_count'),
    remainingCount: numberField(entity, 'remaining_count'),
    authAttempts: numberField(entity, 'auth_attempts'),
    chargeAt: numberField(entity, 'charge_at'),
  }
}

/**
 * Whether this pipeline can actually decide on the envelope, checked at ingest so an
 * unsupported shape is a stated rejection rather than an opaque worker failure three
 * steps later.
 *
 * A payload with a payment entity is supported whatever the event is called — that is
 * what makes `subscription.charged` work. A payload with only a subscription entity is
 * not: there is no amount anywhere in it (see `SubscriptionFacts`), and an EV
 * calculation without an amount is not a calculation.
 */
export function isDecidableEnvelope(envelope: WebhookEnvelope): boolean {
  return envelope.payload.payment !== undefined
}

function stringField(entity: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = entity[key]
  return typeof value === 'string' ? value : null
}

function numberField(entity: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = entity[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Everything the worker actually needs off an entity, extracted once and typed,
 * so nothing downstream re-parses `Record<string, unknown>` by hand. */
export interface ExtractedFacts {
  readonly id: string | null
  readonly amountPaise: number | null
  readonly currency: string | null
  readonly status: string | null
  readonly errorCode: string | null
  readonly errorDescription: string | null
  readonly customerId: string | null
  /** Present on real netbanking/UPI payment entities as a bank code (e.g.
   * `HDFC`); absent for card payments. D11's shock detector keys on
   * `bank ?? 'unknown'`, since a degraded shared upstream (a card network, not
   * a specific bank) is exactly the case this field being absent represents —
   * see src/app/worker/shock-detector.ts. */
  readonly bank: string | null
  /** Razorpay's real card payment entities carry `card_id` (e.g. `card_...`);
   * absent for netbanking/UPI. D11's live risk signals (cardVelocityHigh,
   * cardFirstSeenRecently — src/app/worker/live-risk-signals.ts) key on
   * `cardId ?? customerId`, since a non-card payment method still has a
   * meaningful "same payer, repeated failures" identity even without a card. */
  readonly cardId: string | null
}

export function extractFacts(entity: Readonly<Record<string, unknown>>): ExtractedFacts {
  return {
    id: stringField(entity, 'id'),
    amountPaise: numberField(entity, 'amount'),
    currency: stringField(entity, 'currency'),
    status: stringField(entity, 'status'),
    errorCode: stringField(entity, 'error_code'),
    errorDescription: stringField(entity, 'error_description'),
    customerId: stringField(entity, 'customer_id'),
    bank: stringField(entity, 'bank'),
    cardId: stringField(entity, 'card_id'),
  }
}
