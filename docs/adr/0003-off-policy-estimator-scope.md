# ADR 0003 — DR/SNIPS/DM only; cross-fitting, learned propensities, and DML rejected

**Status:** Accepted. **Date:** 2026-08-25 (D8).

## Context

BUILD_PLAN.md §6.4 calls off-policy evaluation "the highest credibility-per-hour item
in the project" and is explicit that it should be built cheaply: "the expensive part of
off-policy evaluation is propensity estimation, and here it is free because we
generate it." A wide menu of more sophisticated estimators exists in the causal-ML
literature — cross-fitted doubly-robust estimation, double machine learning, learned
(rather than known) propensities, online bandit updating, conformal intervals, isotonic
regression on the weights, Bayesian logistic regression via MCMC — and a submission
could reach for any of them to look more sophisticated.

## Decision

Implement exactly three estimators (`scripts/data/ope.py`): the direct method (DM),
self-normalised importance sampling (SNIPS), and doubly-robust (DR), each against
`q̂` from the recovery scorer already fit on a disjoint split, and known-exact
propensities from `scripts/data/logging_policy.py`. Confidence intervals by 2,000-row
percentile bootstrap. Every more sophisticated technique named above is explicitly
rejected and recorded here, not silently omitted.

## Rationale

Cross-fitted DR and double ML exist to reduce bias from *overfitting the same data*
`q̂` is evaluated on — irrelevant here, because `q̂` is already fit on `logged_train`
and evaluated on `logged_demo`, genuinely disjoint splits; cross-fitting would buy
nothing and cost a day of plumbing splitting the estimation sample further. Learned
propensities exist because a real logging policy is usually *unknown* to the person
evaluating it — irrelevant here, because `scripts/data/logging_policy.py` is this
project's own code, so propensities are exact by construction (`π₀(a|s) = 0.80 · 1{a =
h(s)} + 0.20/6`), not estimated. Online bandit updating, conformal intervals, isotonic
weight regression, and MCMC solve problems this project does not have at its scale
(∼3,000 demo rows, six policies) and would each add a dependency and a failure surface
for a robustness gain this dataset's own noise floor already exceeds.

## Consequence

The D11 finding recorded in `docs/EVALUATION.md`'s D8 section — three low-ESS
baselines (B0/B1/B3) landing out of their expected bracket order due to real sampling
variance on ∼3,000 rows — is a direct, honest cost of this choice: a more
variance-reduced estimator (cross-fitted DR, in particular) might have tightened those
confidence intervals. The counter-argument, made explicitly in `docs/EVALUATION.md`, is
that flagging the untrustworthy estimates via their own ESS is a stronger, more honest
signal than a more complex estimator that quietly produces a tighter but harder-to-audit
number. B2 (a sequential policy) is evaluated by oracle simulation only, for the
separate and unrelated reason that single-step importance weighting cannot validly
score a multi-step policy at all — no estimator choice fixes that; only a genuinely
different evaluation method for that one baseline does.
