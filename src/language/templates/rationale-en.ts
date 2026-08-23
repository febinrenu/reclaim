/**
 * The other language task SYSTEM_SPEC.md §12 names: "producing a one- or
 * two-sentence human-readable rationale for `recovery_audit.rationale` from the
 * already-computed decision." Internal/audit-facing, not customer-facing — no
 * Hinglish variant, since nobody reads this aloud to a customer. `{{action}}`
 * and `{{pRecoverPercent}}` are filled in after selection, same mechanism as the
 * nudge banks (src/language/amount-slot.ts's pattern, generalised in
 * template-engine.ts).
 */
export const RATIONALE_EN: readonly string[] = [
  "Chose {{action}} because the model puts recovery odds at about {{pRecoverPercent}}%, which clears the cost of acting.",
  "{{action}} was the highest-value option on record — a modelled {{pRecoverPercent}}% recovery chance outweighs its cost.",
  "At roughly {{pRecoverPercent}}% predicted recovery, {{action}} was worth more than doing nothing once its cost is subtracted.",
  "The decision engine selected {{action}}: predicted recovery near {{pRecoverPercent}}% justified the intervention cost.",
  "{{action}} won the comparison across all allowed actions, driven by a {{pRecoverPercent}}% recovery estimate.",
  "With recovery odds estimated around {{pRecoverPercent}}%, {{action}} had the best expected value of the options considered.",
  "Selected {{action}} on the strength of a {{pRecoverPercent}}% modelled recovery probability relative to its cost.",
  "{{action}} came out ahead in the expected-value comparison, with predicted recovery near {{pRecoverPercent}}%.",
]

/** Used when the risk gate or the retry limit forced escalation regardless of the
 * modelled economics — the rationale should say so plainly rather than quoting a
 * probability the decision did not actually act on. */
export const RATIONALE_FORCED_ESCALATION_EN: readonly string[] = [
  "Escalated to a human: the risk gate flagged this transaction, so every other action was ruled out regardless of its modelled value.",
  "Routed to escalation because the automated retry limit was reached — no further silent attempts are allowed.",
  "Forced escalation: this transaction cleared the risk threshold, which structurally rules out every action but ESCALATE_HUMAN.",
  "Sent to a human reviewer after exhausting the automated retry attempts allowed for this transaction.",
]
