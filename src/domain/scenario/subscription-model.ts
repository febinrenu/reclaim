/**
 * The subscription scenario's trained recovery model — a hand port of
 * `scripts/data/model_spec.py`, whose `MODEL_FEATURE_ORDER` and `build_row` this
 * file's `MODEL_FEATURE_ORDER` and `buildModelRow` mirror exactly. The port being
 * correct is what `tests/unit/scorer.parity.test.ts` checks, against every golden
 * vector `scripts/data/train_scorer.py` computed and committed alongside the
 * coefficients — not something this file gets to assert about itself.
 *
 * `recovery_model.json` is imported directly from the data generator's output
 * directory rather than copied into `src/`: it is one artifact with one owner
 * (`scripts/data/train_scorer.py`), and a copy would just be a second place for
 * the two to silently drift apart. A static JSON import is resolved by the
 * bundler at build time, not read from disk at runtime, so this does not violate
 * src/domain's no-I/O purity rule (ESLint boundary rule 1) — see SYSTEM_SPEC.md
 * §10's own inference snippet, which does the same thing.
 */
import recoveryModelJson from '../../../data/synthetic/subscription/recovery_model.json'
import { RecoveryModelSchema, type RecoveryModel } from '@/domain/scoring/recovery-model'

/** The 13 features every row shares, in the exact order the model was trained on. */
export const SHARED_FEATURE_ORDER = [
  'prior_success_rate',
  'days_since_last_failure',
  'amount_zscore',
  'retry_count_so_far',
  'is_recurring_subscription',
  'hour_sin',
  'hour_cos',
  'bank_recent_fail_rate',
  'contacts_last_7d',
  'ltv_zscore',
  'customer_tenure_days',
  'is_soft_decline',
  'is_insufficient_funds',
] as const

export type SharedFeature = (typeof SHARED_FEATURE_ORDER)[number]

/** DO_NOTHING is the reference level and gets no dummy — scripts/data/model_spec.py. */
export const MODEL_ACTION_DUMMIES = [
  'RETRY_NOW',
  'RETRY_LATER',
  'PAYMENT_LINK',
  'WHATSAPP_NUDGE',
  'ESCALATE_HUMAN',
] as const

/** The seven hand-picked action interactions, verbatim from scripts/data/model_spec.py. */
export const MODEL_INTERACTIONS: readonly { readonly action: string; readonly feature: SharedFeature }[] = [
  { action: 'RETRY_NOW', feature: 'is_soft_decline' },
  { action: 'RETRY_LATER', feature: 'is_insufficient_funds' },
  { action: 'PAYMENT_LINK', feature: 'amount_zscore' },
  { action: 'WHATSAPP_NUDGE', feature: 'contacts_last_7d' },
  { action: 'ESCALATE_HUMAN', feature: 'retry_count_so_far' },
  { action: 'RETRY_NOW', feature: 'bank_recent_fail_rate' },
  { action: 'PAYMENT_LINK', feature: 'prior_success_rate' },
]

/** The full 25-name column order `buildModelRow` produces. Property P15 asserts
 * this equals `SUBSCRIPTION_RECOVERY_MODEL.featureOrder` exactly — the parity
 * contract's highest-consequence guard, because a silent order mismatch would
 * still produce a number in [0, 1] rather than an error. */
export const MODEL_FEATURE_ORDER: readonly string[] = [
  ...SHARED_FEATURE_ORDER,
  ...MODEL_ACTION_DUMMIES.map((a) => `action_${a}`),
  ...MODEL_INTERACTIONS.map(({ action, feature }) => `${action}_x_${feature}`),
]

export function buildModelRow(
  features: Readonly<Record<SharedFeature, number>>,
  action: string,
): readonly number[] {
  const row: number[] = SHARED_FEATURE_ORDER.map((f) => features[f])
  for (const dummyAction of MODEL_ACTION_DUMMIES) {
    row.push(action === dummyAction ? 1 : 0)
  }
  for (const { action: interactionAction, feature } of MODEL_INTERACTIONS) {
    row.push(action === interactionAction ? features[feature] : 0)
  }
  return row
}

/** Parsed once, at module load, so a malformed or stale committed JSON fails
 * loudly at import time rather than producing a wrong score later. */
export const SUBSCRIPTION_RECOVERY_MODEL: RecoveryModel = RecoveryModelSchema.parse(recoveryModelJson)
