/**
 * The B2B receivables chaser's trained recovery model — a hand port of
 * `scripts/data_b2b/model_spec.py`, whose `MODEL_FEATURE_ORDER` and `build_row`
 * this file's `MODEL_FEATURE_ORDER` and `buildModelRow` mirror exactly. SYSTEM_SPEC.md
 * §16: "the same scorer architecture retrained on different features" — this is
 * the second, independent instance of `subscription-model.ts`'s own pattern,
 * proving the port discipline (not just the scorer) generalizes. The port being
 * correct is what `tests/unit/b2b-scorer.parity.test.ts` checks, against every
 * golden vector `scripts/data_b2b/train_scorer.py` computed and committed.
 */
import recoveryModelJson from '../../../data/synthetic/b2b_receivable/recovery_model.json'
import { RecoveryModelSchema, type RecoveryModel } from '@/domain/scoring/recovery-model'

/** The nine features every row shares, in the exact order the model was trained on. */
export const SHARED_FEATURE_ORDER = [
  'days_overdue',
  'customer_ontime_rate',
  'invoice_size_zscore',
  'chase_rounds_so_far',
  'is_repeat_overdue_this_quarter',
  'quarter_sin',
  'quarter_cos',
  'contacts_last_14d',
  'customer_relationship_days',
] as const

export type SharedFeature = (typeof SHARED_FEATURE_ORDER)[number]

/** WRITE_OFF is the reference level and gets no dummy — scripts/data_b2b/model_spec.py. */
export const MODEL_ACTION_DUMMIES = ['SEND_REMINDER', 'OFFER_PAYMENT_PLAN', 'ESCALATE_COLLECTIONS'] as const

/** The three hand-picked action interactions, verbatim from scripts/data_b2b/model_spec.py. */
export const MODEL_INTERACTIONS: readonly { readonly action: string; readonly feature: SharedFeature }[] = [
  { action: 'SEND_REMINDER', feature: 'days_overdue' },
  { action: 'OFFER_PAYMENT_PLAN', feature: 'customer_ontime_rate' },
  { action: 'ESCALATE_COLLECTIONS', feature: 'chase_rounds_so_far' },
]

/** The full 15-name column order `buildModelRow` produces — the B2B parity
 * contract's own highest-consequence guard, mirroring property P15 for a
 * second scenario. */
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
export const B2B_RECEIVABLE_RECOVERY_MODEL: RecoveryModel = RecoveryModelSchema.parse(recoveryModelJson)
