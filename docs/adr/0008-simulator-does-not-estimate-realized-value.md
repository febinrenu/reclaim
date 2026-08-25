# ADR 0008 — The policy simulator reports the decision distribution and stated EV, never a realized-value estimate

**Status:** Accepted. **Date:** 2026-08-26 (D12).

## Context

BUILD_PLAN.md §1.4 point 1 describes the policy simulator as replaying "a stored batch
through the decision engine offline... and diff the resulting metrics against the
baseline run." A natural reading of "metrics" includes revenue recovered — the
headline number the live dashboard shows. But a stored batch's `outcome` was realized
under whichever action was *actually* chosen at decide-time; a simulated run under a
different policy may choose a different action for the same row, and that row's
`outcome` says nothing about what would have happened under the different action.

## Decision

`src/domain/simulate.ts`'s `summarizeReplay` reports the chosen-action distribution and
the model's own stated EV (`decision.ev`, `decision.uplift`, summed) for both the
baseline and the simulated run. It never reuses a stored row's `outcome` for a
simulated decision that chose a different action, and it never attempts its own
counterfactual-outcome estimate.

## Rationale

Reusing the stored `outcome` under a changed action would silently misattribute a
result that was never actually realized under that action — exactly the same
correctness problem D8's off-policy estimator exists to solve *properly*, with known
propensities and importance weighting. Building a second, cruder version of that
machinery inside the simulator (or worse, skipping the correction entirely and treating
`outcome` as if it transferred) would either duplicate D8's real work or produce a
number that looks like a value estimate but is not one. The honest scope for a same-day
diff tool is the two things it can state without estimating anything: which action
argmax picked, and what the model itself believes that action is worth in expectation
— both directly computable from `decide()`'s own output, with no statistical estimation
step to get wrong.

## Consequence

A simulator user cannot ask "how much more would this policy have recovered" and get an
answer from this tool — only "how would the decisions have shifted, and by the model's
own reckoning, in which direction did the economics move." `docs/EVALUATION.md`'s D12
section states this limitation plainly next to the real finding it produced: on the
model actually shipped, a plausible cost tweak (halving `WHATSAPP_NUDGE`'s cost) never
moves the argmax at all, while a risk-threshold change reliably does — a claim about
*decisions*, which is exactly what this tool is scoped to answer.
