/**
 * Parses `recovery_audit`'s stored `ev_breakdown`/`decision_input` jsonb back
 * into typed shapes for the D10 EV explorer and audit table — the same
 * `EvBreakdown`/`DecisionInput` interfaces `src/domain/decide.ts` produced them
 * from, read back at the presentation boundary rather than trusted blindly:
 * `Jsonish` at rest, validated on the way out.
 */
import { z } from 'zod'

const DisallowedReasonSchema = z.enum([
  'stopping_rule',
  'shock_suppressed',
  'no_contact',
  'opted_out',
  'capability_missing',
  'escalation_budget_exhausted',
])

const EvBreakdownEntrySchema = z.object({
  action: z.string(),
  allowed: z.boolean(),
  disallowedReason: DisallowedReasonSchema.nullable(),
  pBase: z.number(),
  pRecover: z.number(),
  expectedGain: z.number(),
  interventionCost: z.number(),
  computeCost: z.number(),
  riskPenalty: z.number(),
  contactFatigueCost: z.number(),
  ev: z.number(),
})

export type EvBreakdownEntry = z.infer<typeof EvBreakdownEntrySchema>

const EvBreakdownArraySchema = z.array(EvBreakdownEntrySchema)

export function parseEvBreakdown(raw: unknown): readonly EvBreakdownEntry[] | null {
  const result = EvBreakdownArraySchema.safeParse(raw)
  return result.success ? result.data : null
}

export const DISALLOWED_REASON_LABELS: Record<string, string> = {
  stopping_rule: 'Retry limit reached, or the risk gate fired',
  shock_suppressed: 'Suppressed — a systemic shock is in progress',
  no_contact: 'No channel can reach this customer',
  opted_out: 'Customer opted out of contact',
  capability_missing: 'This specific channel is unavailable',
  escalation_budget_exhausted: "Today's escalation capacity is already spent",
}

export function parseAmountPaise(decisionInput: unknown): number | null {
  if (typeof decisionInput !== 'object' || decisionInput === null) return null
  const amount = (decisionInput as { amount?: unknown }).amount
  return typeof amount === 'number' ? amount : null
}
