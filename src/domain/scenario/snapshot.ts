/**
 * The raw, pre-feature facts a scenario's `buildFeatures` turns into a numeric
 * vector. Deliberately not the same shape as `DecisionInput` — a snapshot is "what
 * do we know about this customer and transaction right now", closer to a database
 * read; `DecisionInput` is "what decide() actually needs", already reduced to
 * numbers and booleans and safe to persist verbatim.
 *
 * Every field here is already computed as-of the decision instant (BUILD_PLAN.md
 * §6.7's leakage discipline) — turning a raw ledger into these values is a
 * repository concern (D6), not this type's job. This module only shapes what
 * `buildSubscriptionFeatures` needs into src/domain/scenario/subscription-model.ts's
 * `SharedFeature` record.
 */
export interface EntitySnapshot {
  readonly priorSuccessRate: number
  readonly daysSinceLastFailure: number
  readonly amountZscore: number
  readonly retryCount: number
  readonly isRecurringSubscription: boolean
  readonly hourOfDayUtc: number
  readonly bankRecentFailRate: number
  readonly contactsLast7d: number
  readonly ltvZscore: number
  readonly customerTenureDays: number
  readonly isSoftDecline: boolean
  readonly isInsufficientFunds: boolean
}
