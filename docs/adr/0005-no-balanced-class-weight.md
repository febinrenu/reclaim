# ADR 0005 — `class_weight='balanced'` never used

**Status:** Accepted. **Date:** 2026-08-24 (D5).

## Context

Both scenarios' recovery outcome is imbalanced (subscription base rate ≈18%, B2B
≈25% — see `docs/RESULTS.md`, generated). scikit-learn's `LogisticRegression`
offers `class_weight='balanced'` as a one-line fix for exactly this shape of imbalance,
and it is a common enough default reflex that its absence needs stating on purpose
rather than leaving a reviewer to wonder whether it was considered.

## Decision

Never set it. `scripts/data/train_scorer.py` and `scripts/data_b2b/train_scorer.py`
both fit with scikit-learn's plain default weighting.

## Rationale

`class_weight='balanced'` reweights the loss function so the fitted model no longer
targets `P(y=1|x)` — it targets a *reweighted* probability, and then shifts the
intercept to compensate. The output is not a probability anymore in the sense this
project needs one to be: `EV(a) = P(recover|s,a) × amount − costs` is only a real
expected value if `P(recover|s,a)` is genuinely calibrated to observed frequency, which
is the entire point of the calibration chart, the Brier score, and ADR 0004's Platt
step. At an 18–25% base rate — nowhere near the 1% or lower thresholds where balancing
becomes a defensible trade-off — there is no imbalance severe enough to justify
trading away calibration for a marginal discrimination gain that this project's own
economics do not actually reward (a slightly better-ranked ordering of who is likely to
pay is worth nothing if the *probability number* used in the EV formula is no longer
truthful).

## Consequence

None of the discrimination metrics reported in `docs/RESULTS.md` (ROC-AUC 0.6903
subscription, 0.6461 B2B) are inflated by balancing, and the Brier/BSS/ECE numbers
next to them are directly comparable — reporting AUC from a balanced fit alongside
Brier from the same fit would be reporting two numbers computed on different pretend
probability scales. Flagging this decision explicitly is itself one of the "where you
chose not to" signals BUILD_PLAN.md §6.6 names.
