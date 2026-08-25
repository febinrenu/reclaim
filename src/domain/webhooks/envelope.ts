/**
 * The Razorpay webhook envelope (BUILD_PLAN.md §2.1 C9, confirmed fields): `entity`,
 * `account_id`, `event`, `contains`, `payload`, `created_at`. `payload` always has
 * exactly one top-level key (`payment`, `subscription`, ...) wrapping `{ entity }`,
 * so `extractPrimaryEntity` needs no per-event-type branching to find it.
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

/** The single `{ kind: { entity } }` pair every real Razorpay payload carries. */
export function extractPrimaryEntity(envelope: WebhookEnvelope): PrimaryEntity | null {
  const [kind, wrapper] = Object.entries(envelope.payload)[0] ?? []
  if (kind === undefined || wrapper === undefined) return null
  return { kind, entity: wrapper.entity }
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
