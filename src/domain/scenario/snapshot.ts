/**
 * The raw, pre-feature facts a scenario's `buildFeatures` turns into a numeric
 * vector (BUILD_PLAN.md §5.9's `buildFeatures: (s: EntitySnapshot) => ...`).
 *
 * Deliberately not the same shape as `DecisionInput` — a snapshot is "what do we
 * know about this customer and transaction right now", closer to a database read;
 * `DecisionInput` is "what decide() actually needs", already reduced to numbers and
 * booleans and safe to persist verbatim. Keeping them distinct is what lets a
 * snapshot carry things `decide()` has no business seeing (like which bank issued
 * the card) without widening the pure function's own input type.
 */
export interface EntitySnapshot {
  readonly priorSuccessRate: number
  readonly daysSinceLastFailure: number
  readonly amountZscore: number
  readonly retryCount: number
  readonly isRecurringSubscription: boolean
  readonly hourOfDayRisk: number
}
