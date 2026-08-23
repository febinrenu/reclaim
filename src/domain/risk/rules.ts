/**
 * The risk gate (SYSTEM_SPEC.md §11): a small, deterministic, weighted rule set,
 * independent of the recovery-value optimisation. Each rule inspects one boolean
 * signal and contributes a fixed weight if it fires; the sum is the risk score.
 *
 * BUILD_PLAN.md §6.1 correction 3 is why this returns `gated: boolean` rather than a
 * penalty alone: a *fixed* penalty can always be out-competed by a large enough
 * amount, and high-amount transactions are precisely the risky ones. The caller
 * (src/domain/decide.ts) treats `gated` as a hard feasibility constraint — it removes
 * every non-escalation action from the allowed set — rather than folding it into the
 * EV subtraction and hoping the arithmetic works out. Property P10 is what proves
 * this holds for every amount up to ₹50,00,000, not just typical ones.
 *
 * The four signals mirror the ones BUILD_PLAN.md §6.2's data generator emits for its
 * latent `is_truly_risky` flag: geo mismatch, card velocity, an amount far outside
 * the customer's own history, and a card seen for the first time very recently. That
 * generator is D4 work; this module only needs to know the signals exist as booleans
 * by the time a `RiskInput` reaches it — where they come from is the caller's problem.
 */

export interface RiskInput {
  readonly geoMismatch: boolean
  readonly cardVelocityHigh: boolean
  readonly amountFarAboveHistory: boolean
  readonly cardFirstSeenRecently: boolean
}

export interface RiskRule {
  readonly key: keyof RiskInput
  readonly weight: number
}

/**
 * Weights are hand-set and documented here rather than trained, because the risk
 * gate is deliberately not a model (SYSTEM_SPEC.md §11: "not ML, not an LLM"). Card
 * velocity and a very fresh card are weighted highest because BUILD_PLAN.md §6.2's
 * signal table gives them the widest gap between P(signal | risky) and
 * P(signal | benign) — they are the most discriminating signals available, even
 * though none of the four is anywhere near sufficient alone.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  { key: 'geoMismatch', weight: 0.2 },
  { key: 'cardVelocityHigh', weight: 0.35 },
  { key: 'amountFarAboveHistory', weight: 0.15 },
  { key: 'cardFirstSeenRecently', weight: 0.3 },
]

export interface RiskSignalResult {
  readonly key: keyof RiskInput
  readonly weight: number
  readonly present: boolean
}

export interface RiskAssessment {
  readonly score: number
  readonly gated: boolean
  readonly threshold: number
  readonly signals: readonly RiskSignalResult[]
}

/**
 * Property P9 (adding a risk signal never decreases the score) holds by
 * construction: every weight is non-negative and the score is a plain sum of the
 * weights of signals that are actually present, never a function of which other
 * signals are absent.
 */
export function evaluateRisk(
  input: RiskInput,
  threshold: number,
  rules: readonly RiskRule[] = DEFAULT_RISK_RULES,
): RiskAssessment {
  const signals = rules.map((rule) => ({
    key: rule.key,
    weight: rule.weight,
    present: input[rule.key],
  }))
  const score = signals.reduce((sum, s) => sum + (s.present ? s.weight : 0), 0)
  return { score, gated: score >= threshold, threshold, signals }
}
