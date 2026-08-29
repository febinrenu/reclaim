/**
 * Validates a stored `recovery_audit.decision_input` JSONB blob back into the
 * exact `DecisionInput<SubscriptionAction, SubscriptionFeature>` shape
 * `decide()` needs — the read-side counterpart of the fact that
 * `DecisionInput` is persisted verbatim specifically so it can be replayed
 * later (`src/domain/scenario/types.ts`'s own docstring). Zod, not a cast: a
 * batch row is untrusted input at this boundary the same way any other stored
 * JSON is, even though this process itself wrote it.
 */
import { z } from 'zod'
import { SUBSCRIPTION_ACTIONS, SUBSCRIPTION_FEATURES } from '@/domain/scenario/subscription'
import { paise } from '@/domain/money'
import type { DecisionInput } from '@/domain/scenario/types'
import type { SubscriptionAction, SubscriptionFeature } from '@/domain/scenario/subscription'

const RiskInputSchema = z.object({
  geoMismatch: z.boolean(),
  cardVelocityHigh: z.boolean(),
  amountFarAboveHistory: z.boolean(),
  cardFirstSeenRecently: z.boolean(),
})

const FeaturesSchema = z.object(
  Object.fromEntries(SUBSCRIPTION_FEATURES.map((f) => [f, z.number()])) as Record<SubscriptionFeature, z.ZodNumber>,
)

const CapabilitySchema = z.object(
  Object.fromEntries(SUBSCRIPTION_ACTIONS.map((a) => [a, z.boolean()])) as Record<SubscriptionAction, z.ZodBoolean>,
)

const StoredDecisionInputSchema = z.object({
  transactionId: z.string(),
  eventId: z.string(),
  nowMs: z.number(),
  amount: z.number(),
  retryCount: z.number(),
  contactsLast7d: z.number(),
  expectedLtv: z.number(),
  features: FeaturesSchema,
  risk: RiskInputSchema,
  shockSuppressed: z.boolean(),
  optedOut: z.boolean(),
  capabilityAvailable: CapabilitySchema,
  // Optional, defaulting to false: every `recovery_audit` row written before
  // the escalation-budget constraint existed was in fact decided with no
  // budget in force, so replaying it unconstrained reproduces exactly what
  // happened rather than silently changing old decisions' meaning.
  escalationBudgetExhausted: z.boolean().optional().default(false),
})

export interface ParsedDecisionInput {
  readonly ok: true
  readonly value: DecisionInput<SubscriptionAction, SubscriptionFeature>
}
export interface UnparsedDecisionInput {
  readonly ok: false
  readonly transactionId: string | null
}

export function parseStoredDecisionInput(raw: unknown): ParsedDecisionInput | UnparsedDecisionInput {
  const result = StoredDecisionInputSchema.safeParse(raw)
  if (!result.success) {
    const transactionId =
      typeof raw === 'object' && raw !== null && 'transactionId' in raw && typeof raw.transactionId === 'string'
        ? raw.transactionId
        : null
    return { ok: false, transactionId }
  }
  return {
    ok: true,
    value: {
      ...result.data,
      amount: paise(result.data.amount),
      expectedLtv: paise(result.data.expectedLtv),
    },
  }
}
