# ADR 0004 — Platt scaling, not isotonic regression

**Status:** Accepted. **Date:** 2026-08-24 (D5).

## Context

BUILD_PLAN.md §6.6 requires a calibration step fit on `logged_calibration` only,
never on `logged_demo`. Two standard choices exist: Platt scaling (a one-parameter
logistic fit on the raw logit) and isotonic regression (a non-parametric monotone
step function).

## Decision

Platt scaling. `scripts/data/train_scorer.py` fits `platt_a`/`platt_b` on
`logged_calibration`'s raw logit and writes both as two floats into
`recovery_model.json`.

## Rationale

`logged_calibration` has 2,912 rows split across six actions — roughly 480 rows per
action on average, and fewer once split further by any interaction the model already
captures. Isotonic regression at that scale overfits into a jagged step function that
memorises calibration-split noise rather than a genuine miscalibration curve, and
because it is non-parametric, "the model" would no longer be `intercept + Σ
coefficient·feature` plus two floats — it would need its own lookup table serialised
into TypeScript, a second parity-contract surface alongside the one BUILD_PLAN.md §6.8
already demands for the coefficients themselves. Platt costs nothing extra on that
front: `plattA`/`plattB` are two more numbers in the same committed JSON, and
`src/domain/scoring/recovery-model.ts`'s `scoreRow` applies them with one extra
multiply-add already written before Platt was even added.

## Consequence

Platt scaling can only ever apply a global, monotone logistic correction — it cannot
fix a calibration curve that is miscalibrated in *different directions* at different
probability ranges, the one class of miscalibration isotonic regression can correct
that Platt cannot. The actual, committed measurement (`recovery_model.json`'s
`metrics`) is a real but modest gain: Brier moved from 0.13063 (before Platt) to
0.12586 (after) on the subscription scenario's demo split — kept because the
improvement is genuine and the cost is two floats, not because the number is dramatic.
One honest gap this ADR records rather than hides: `train_scorer.py` only computes ECE
*after* Platt, so there is no committed before/after ECE comparison to quote, only the
Brier one — a smaller claim than BUILD_PLAN.md §6.6's own illustrative example makes,
made only as far as the data actually backs it up.
