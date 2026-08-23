/**
 * The subscription scenario (SYSTEM_SPEC.md §3–4): a merchant's recurring-payment
 * customer whose charge just failed. The six actions and six features are taken
 * directly from the spec's own training script (§10) so the feature list here is
 * the one D5's `train_scorer.py` will actually fit against.
 *
 * The model below is a **hand-set placeholder**, not a trained one. D5 trains the
 * real coefficients on the D4 generator's synthetic history and overwrites this
 * object's `model` field from the committed `recovery_model.json` — everything else
 * here (actions, policy shape, risk wiring) is stable across that swap. Marked
 * clearly rather than presented as if it were already the real thing, for the same
 * reason docs/INCIDENTS.md gives for not padding a threshold to fake a result: a
 * placeholder that looks finished is a worse trap than one that says so.
 */
import { milliFromRupees } from '@/domain/money'
import type { LogisticModel } from '@/domain/scoring/logistic'
import { DEFAULT_RISK_RULES } from '@/domain/risk/rules'
import type { EntitySnapshot } from '@/domain/scenario/snapshot'
import type { ExecutorCapability, Policy, ScenarioDefinition } from '@/domain/scenario/types'

export const SUBSCRIPTION_ACTIONS = [
  'RETRY_NOW',
  'RETRY_LATER',
  'PAYMENT_LINK',
  'WHATSAPP_NUDGE',
  'ESCALATE_HUMAN',
  'DO_NOTHING',
] as const
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number]

export const SUBSCRIPTION_FEATURES = [
  'priorSuccessRate',
  'daysSinceLastFailure',
  'amountZscore',
  'retryCountSoFar',
  'isRecurringSubscription',
  'hourOfDayRisk',
] as const
export type SubscriptionFeature = (typeof SUBSCRIPTION_FEATURES)[number]

export function buildSubscriptionFeatures(
  s: EntitySnapshot,
): Readonly<Record<SubscriptionFeature, number>> {
  return {
    priorSuccessRate: s.priorSuccessRate,
    daysSinceLastFailure: s.daysSinceLastFailure,
    amountZscore: s.amountZscore,
    retryCountSoFar: s.retryCount,
    isRecurringSubscription: s.isRecurringSubscription ? 1 : 0,
    hourOfDayRisk: s.hourOfDayRisk,
  }
}

/**
 * Hand-set, not trained — see the module docstring. Signs only: prior success and
 * being a recurring subscription raise recovery odds; time since the last failure,
 * a large amount z-score, more retries already spent, and a risky hour all lower it.
 * `DO_NOTHING`'s organic recovery rate of roughly 0.11 (BUILD_PLAN.md §6.1) is what
 * the intercept is set to reproduce at the feature vector's mean (all zeros).
 */
const PLACEHOLDER_MODEL: LogisticModel<SubscriptionFeature> = {
  intercept: -2.09, // sigmoid(-2.09) ≈ 0.11
  coefficients: {
    priorSuccessRate: 1.6,
    daysSinceLastFailure: -0.05,
    amountZscore: -0.2,
    retryCountSoFar: -0.35,
    isRecurringSubscription: 0.4,
    hourOfDayRisk: -0.5,
  },
}

const CAPABILITY_OF: Readonly<Record<SubscriptionAction, ExecutorCapability>> = {
  RETRY_NOW: 'silent',
  RETRY_LATER: 'silent',
  PAYMENT_LINK: 'requires_contact',
  WHATSAPP_NUDGE: 'requires_contact',
  ESCALATE_HUMAN: 'requires_human',
  DO_NOTHING: 'silent',
}

function requiresContact(action: SubscriptionAction): boolean {
  return CAPABILITY_OF[action] === 'requires_contact'
}

/**
 * Intervention costs from SYSTEM_SPEC.md §4: a nudge ≈ ₹0.35, escalation ≈ ₹40 of
 * agent time, a silent retry ≈ ₹0. `ComputeCost` is zero for every action here — it
 * becomes a real, checkable number once the language layer exists (D7/D8); logging
 * zero rather than inventing a placeholder is the honest state for a scenario that
 * has not called an LLM yet.
 */
export const SUBSCRIPTION_DEFAULT_POLICY: Policy<SubscriptionAction> = {
  interventionCost: {
    RETRY_NOW: milliFromRupees(0),
    RETRY_LATER: milliFromRupees(0),
    PAYMENT_LINK: milliFromRupees(0.35),
    WHATSAPP_NUDGE: milliFromRupees(0.35),
    ESCALATE_HUMAN: milliFromRupees(40),
    DO_NOTHING: milliFromRupees(0),
  },
  computeCost: {
    RETRY_NOW: milliFromRupees(0),
    RETRY_LATER: milliFromRupees(0),
    PAYMENT_LINK: milliFromRupees(0),
    WHATSAPP_NUDGE: milliFromRupees(0),
    ESCALATE_HUMAN: milliFromRupees(0),
    DO_NOTHING: milliFromRupees(0),
  },
  // In logit space. DO_NOTHING is the reference level: zero lift, by definition.
  // ESCALATE_HUMAN gets the largest lift (a human agent is the most effective single
  // channel) which is exactly why it can win the ordinary argmax on a high-value,
  // non-gated transaction, not only when a stopping rule forces it.
  liftLogit: {
    RETRY_NOW: 0.35,
    RETRY_LATER: 0.5,
    PAYMENT_LINK: 0.9,
    WHATSAPP_NUDGE: 0.6,
    ESCALATE_HUMAN: 1.5,
    DO_NOTHING: 0,
  },
  riskThreshold: 0.5,
  riskRules: DEFAULT_RISK_RULES,
  maxRetries: 3,
  contactFatigueActions: ['WHATSAPP_NUDGE', 'PAYMENT_LINK'],
  shockSuppressedActions: ['RETRY_NOW'],
}

export const SUBSCRIPTION_SCENARIO: ScenarioDefinition<SubscriptionAction, SubscriptionFeature> = {
  id: 'subscription',
  actions: SUBSCRIPTION_ACTIONS,
  nullAction: 'DO_NOTHING',
  escalationAction: 'ESCALATE_HUMAN',
  features: SUBSCRIPTION_FEATURES,
  model: PLACEHOLDER_MODEL,
  capabilityOf: CAPABILITY_OF,
  requiresContact,
  defaultPolicy: SUBSCRIPTION_DEFAULT_POLICY,
}
