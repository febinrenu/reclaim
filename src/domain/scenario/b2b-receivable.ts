/**
 * The B2B receivables chaser (SYSTEM_SPEC.md §16): a fictional B2B merchant's
 * overdue invoices, instead of failed card payments — proving `decide()`,
 * `computeEv`, `evaluateRisk`, and the audit schema generalize to a second
 * scenario built from the same shared types (`src/domain/scenario/types.ts`),
 * not a one-off script wearing an equation as a costume. Everything reused
 * here is imported, never copied: `computeEv`, `evaluateRisk`, `decide()`, and
 * `RiskInput`'s own four-field shape (BUILD_PLAN.md §5.9's "share by type,
 * not by convention").
 *
 * `RiskInput`'s four fields are fixed by `src/domain/risk/rules.ts` — reused
 * here with their literal meaning reinterpreted for receivables rather than
 * renamed, since the interface itself is not scenario-specific:
 *   geoMismatch            -> billing-address mismatch on the invoice
 *   cardVelocityHigh       -> unusually many large invoices from this
 *                             customer in a short window
 *   amountFarAboveHistory  -> unchanged: this invoice is far above this
 *                             customer's own historical average
 *   cardFirstSeenRecently  -> this is a newly onboarded customer relationship
 *
 * This scenario is exercised through the policy simulator and offline
 * training/evaluation only, not the live webhook path — SYSTEM_SPEC.md §16's
 * own framing ("half a day to a day, instantiating an architecture") and
 * BUILD_PLAN.md's D12 exit test (no file touched outside the
 * scenario/features/risk/templates/seeds directories) both point the same
 * way: wiring a second scenario into `process-event.ts`/`container.ts` is
 * explicitly out of scope for this pass.
 */
import { milliFromRupees } from '@/domain/money'
import { DEFAULT_RISK_RULES } from '@/domain/risk/rules'
import type { Policy, ScenarioDefinition, ExecutorCapability } from '@/domain/scenario/types'
import {
  SHARED_FEATURE_ORDER,
  buildModelRow,
  B2B_RECEIVABLE_RECOVERY_MODEL,
  type SharedFeature,
} from '@/domain/scenario/b2b-receivable-model'

export const B2B_ACTIONS = ['SEND_REMINDER', 'OFFER_PAYMENT_PLAN', 'ESCALATE_COLLECTIONS', 'WRITE_OFF'] as const
export type B2bAction = (typeof B2B_ACTIONS)[number]

export const B2B_FEATURES = SHARED_FEATURE_ORDER
export type B2bFeature = SharedFeature

const CAPABILITY_OF: Readonly<Record<B2bAction, ExecutorCapability>> = {
  SEND_REMINDER: 'requires_contact',
  OFFER_PAYMENT_PLAN: 'requires_contact',
  ESCALATE_COLLECTIONS: 'requires_human',
  WRITE_OFF: 'silent',
}

function requiresContact(action: B2bAction): boolean {
  return CAPABILITY_OF[action] === 'requires_contact'
}

/**
 * Intervention costs, defensible-estimate style matching SYSTEM_SPEC.md §4's
 * subscription cost table: a reminder is cheap automated correspondence
 * (≈₹0.20), a payment-plan offer needs more setup/paperwork (≈₹0.75), an
 * escalation to a collections agency is the most expensive step (≈₹75 —
 * pricier than subscription's human-agent cost, reflecting a genuinely more
 * involved collections handoff), and WRITE_OFF, the null action, costs
 * nothing to choose. `ComputeCost` is zero everywhere for the same reason
 * `subscription.ts`'s is: no LLM call is scenario-specific, and the language
 * layer's own cost accounting (D7) is scenario-agnostic already.
 */
export const B2B_DEFAULT_POLICY: Policy<B2bAction> = {
  interventionCost: {
    SEND_REMINDER: milliFromRupees(0.2),
    OFFER_PAYMENT_PLAN: milliFromRupees(0.75),
    ESCALATE_COLLECTIONS: milliFromRupees(75),
    WRITE_OFF: milliFromRupees(0),
  },
  computeCost: {
    SEND_REMINDER: milliFromRupees(0),
    OFFER_PAYMENT_PLAN: milliFromRupees(0),
    ESCALATE_COLLECTIONS: milliFromRupees(0),
    WRITE_OFF: milliFromRupees(0),
  },
  riskThreshold: 0.5,
  riskRules: DEFAULT_RISK_RULES,
  // scripts/data_b2b/dgp.py's own MAX_CHASE_ROUNDS: at most one automated
  // follow-up round (chase_rounds_so_far in {0, 1}) before the stopping rule
  // forces ESCALATE_COLLECTIONS — a shorter, slower-moving cadence than
  // subscription's 3-attempt limit, matching how infrequently a B2B
  // relationship is actually chased.
  maxRetries: 2,
  contactFatigueActions: ['SEND_REMINDER', 'OFFER_PAYMENT_PLAN'],
  // No shock-suppressed actions: the systemic-shock detector's premise (a
  // shared payment-gateway outage) has no obvious receivables analogue, and
  // building one is out of scope for this pass — left empty rather than
  // populated with a mechanism that was never actually built or tested here.
  shockSuppressedActions: [],
}

export const B2B_RECEIVABLE_SCENARIO: ScenarioDefinition<B2bAction, B2bFeature> = {
  id: 'b2b_receivable',
  actions: B2B_ACTIONS,
  nullAction: 'WRITE_OFF',
  escalationAction: 'ESCALATE_COLLECTIONS',
  features: B2B_FEATURES,
  model: B2B_RECEIVABLE_RECOVERY_MODEL,
  buildModelRow,
  capabilityOf: CAPABILITY_OF,
  requiresContact,
  defaultPolicy: B2B_DEFAULT_POLICY,
}
