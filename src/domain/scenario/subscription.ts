/**
 * The subscription scenario (SYSTEM_SPEC.md §3–4): a merchant's recurring-payment
 * customer whose charge just failed. Six actions, thirteen shared features, five
 * action dummies, and seven hand-picked interactions (BUILD_PLAN.md §6.2) — the
 * exact design `scripts/data/model_spec.py` and `scripts/data/train_scorer.py`
 * fit against, and `subscription-model.ts` mirrors on this side of the parity
 * contract.
 *
 * D3's hand-set placeholder model is gone as of D5: `SUBSCRIPTION_RECOVERY_MODEL`
 * is the real, trained coefficients from `recovery_model.json`, validated at
 * import time. `hour_of_day_risk` is also gone, replaced by `hour_sin`/`hour_cos`
 * per BUILD_PLAN.md §6.7's correction — a scalar risk score for hour-of-day was
 * either arbitrary or fit on the label; the generator has emitted the sin/cos pair
 * since D4.
 */
import { milliFromRupees } from '@/domain/money'
import { DEFAULT_RISK_RULES } from '@/domain/risk/rules'
import type { EntitySnapshot } from '@/domain/scenario/snapshot'
import type { ExecutorCapability, Policy, ScenarioDefinition } from '@/domain/scenario/types'
import {
  SHARED_FEATURE_ORDER,
  buildModelRow,
  SUBSCRIPTION_RECOVERY_MODEL,
  type SharedFeature,
} from '@/domain/scenario/subscription-model'

export const SUBSCRIPTION_ACTIONS = [
  'RETRY_NOW',
  'RETRY_LATER',
  'PAYMENT_LINK',
  'WHATSAPP_NUDGE',
  'ESCALATE_HUMAN',
  'DO_NOTHING',
] as const
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number]

export const SUBSCRIPTION_FEATURES = SHARED_FEATURE_ORDER
export type SubscriptionFeature = SharedFeature

export function buildSubscriptionFeatures(
  s: EntitySnapshot,
): Readonly<Record<SubscriptionFeature, number>> {
  const hourAngle = (2 * Math.PI * s.hourOfDayUtc) / 24
  return {
    prior_success_rate: s.priorSuccessRate,
    days_since_last_failure: s.daysSinceLastFailure,
    amount_zscore: s.amountZscore,
    retry_count_so_far: s.retryCount,
    is_recurring_subscription: s.isRecurringSubscription ? 1 : 0,
    hour_sin: Math.sin(hourAngle),
    hour_cos: Math.cos(hourAngle),
    bank_recent_fail_rate: s.bankRecentFailRate,
    contacts_last_7d: s.contactsLast7d,
    ltv_zscore: s.ltvZscore,
    customer_tenure_days: s.customerTenureDays,
    is_soft_decline: s.isSoftDecline ? 1 : 0,
    is_insufficient_funds: s.isInsufficientFunds ? 1 : 0,
  }
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
 * has not called an LLM yet. There is no `liftLogit` any more: each action's own
 * effect on recovery odds now lives inside the trained model's dummy and
 * interaction coefficients (BUILD_PLAN.md §6.2), not as a separate policy lever.
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
  riskThreshold: 0.5,
  riskRules: DEFAULT_RISK_RULES,
  maxRetries: 3,
  contactFatigueActions: ['WHATSAPP_NUDGE', 'PAYMENT_LINK'],
  shockSuppressedActions: ['RETRY_NOW'],
  escalationDailyBudget: null,
}

export const SUBSCRIPTION_SCENARIO: ScenarioDefinition<SubscriptionAction, SubscriptionFeature> = {
  id: 'subscription',
  actions: SUBSCRIPTION_ACTIONS,
  nullAction: 'DO_NOTHING',
  escalationAction: 'ESCALATE_HUMAN',
  features: SUBSCRIPTION_FEATURES,
  model: SUBSCRIPTION_RECOVERY_MODEL,
  buildModelRow,
  capabilityOf: CAPABILITY_OF,
  requiresContact,
  defaultPolicy: SUBSCRIPTION_DEFAULT_POLICY,
}
