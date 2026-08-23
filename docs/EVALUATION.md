# Evaluation design

Started on D4, when the synthetic data generator (`scripts/data/`) was built, because the
reasoning behind it needs to be on record while it is still fresh — not reconstructed at D13.
This file grows through D5 (training, calibration) and D8 (off-policy evaluation); this section
covers what D4 is responsible for: the generator, and why it is trustworthy evidence rather than
a circular one.

## Why a synthetic evaluation can be trusted at all

We wrote the generator, so three specific objections are live, and BUILD_PLAN.md §6.2 names them
precisely. Each has a concrete answer in `scripts/data/`, not just a design intention.

### "You're fitting your own generator" (Trap 1)

The shipped recovery scorer (D5) is a logistic regression over 13 features plus action
interactions. The true generating process (`scripts/data/dgp.py`) includes six structures that
model omits on purpose, because a competent engineer building the shipped model could not have
seen them:

- a per-bank, 5-minute-resolution latent health process (`build_bank_health_paths`)
- a per-customer latent intent random effect (`Customer.intent_effect`)
- a threshold effect at each customer's own 90th-percentile amount (`THRESHOLD_WEIGHT`)
- one feature-feature interaction the shipped model does not include
  (`days_since_last_failure × amount_zscore`, via `INTERACTION_WEIGHT`)
- heteroskedastic noise, scaled by how hard the decline reason is (`NOISE_SCALE * DECLINE_HARDNESS`)
- asymmetric label noise on the *recorded* outcome only: 2% of true successes are logged as
  failures, 1% of true failures are logged as successes

**The load-bearing decision, stated once and referenced from everywhere else:** every one of
those six structures enters the *outcome*. None of them enters the *logging policy*
(`scripts/data/logging_policy.py`), which is a pure function of recorded features — amount,
`prior_success_rate`, `retry_index`, decline category. This buys two properties at the same time.
Because the logging policy cannot see the latents, propensities are **known exactly** rather than
estimated from data, which is what keeps the D8 off-policy estimator unbiased. And because the
outcome model still has irreducible structure the shipped model cannot capture, the recovery
scorer's Brier score will be a real, non-tautological number rather than a proof that we can
recover code we wrote ourselves. Letting a latent drive action selection would break the first
property for no benefit to the second, which is why it is not done anywhere in this generator.

D5 will report the Bayes floor (`Brier_bayes`), the base-rate reference (`Brier_ref`), and
`SkillEff = (Brier_ref - Brier_model) / (Brier_ref - Brier_bayes)` — the fraction of the
achievable signal actually captured. `eval/test_generator_difficulty.py`, added in D5 once a
model exists to measure, fails CI if the task becomes too easy for that comparison to mean
anything.

### "You can't identify action effects without outcomes for actions not taken" (Trap 2)

`scripts/data/logging_policy.py` implements an explicit, non-trivial incumbent heuristic `h(s)`
with epsilon-greedy exploration (`π₀(a|s) = 0.80 · 1{a = h(s)} + 0.20/6`), and every logged row
carries its exact propensity. Positivity holds by construction: the minimum propensity is
0.20/6 ≈ 0.0333 in every state, so the maximum importance weight for off-policy evaluation is
exactly 30 — weight clipping at 30 (D8) is therefore a provable no-op, not a variance hack that
needs defending. `eval/test_overlap.py` checks this empirically on the generated `logged_train`
split: every (retry_index, action) and every (bank_recent_fail_rate-bucket, action) contingency
cell clears a 30-row floor, and the rarest action still gets a meaningful share of the data.

### "Precision and recall of 1.0 means you labelled risk from the rule you're testing" (Trap 3)

`scripts/data/risk.py` assigns a hidden `is_truly_risky` flag through compromised-card episodes
over card fingerprints — a latent cause, never the four rule signals themselves. The signals the
risk gate actually sees (`geo_mismatch`, `card_velocity_high`, `amount_far_above_history`,
`card_first_seen_recently`) are noisy, incomplete emissions of that latent, at the exact
per-signal rates in BUILD_PLAN.md §6.2's table. 30% of truly risky events emit no signal at all
(`SILENT_RISKY_RATE`), which is the gate's recall ceiling by construction, and 60 benign
look-alikes emit every signal regardless (`_apply_benign_lookalikes`), which puts a real ceiling
on precision. The label used for the risk gate's own evaluation, `would_chargeback`, is one layer
further removed still: P = 0.80 given truly risky, P = 0.005 given benign — a noisy consequence
of the latent, not the latent itself.

`is_truly_risky` and `would_chargeback` never reach the recovery-scorer's training or evaluation
data. `eval/test_oracle_firewall.py` checks this two ways: statically, by asserting neither the
logged splits nor `scripts/data/loader.py`'s source contain a banned column or a reference to the
oracle file; and dynamically, by asserting the loader itself raises if a logged CSV ever did
carry one. The risk gate's own labelled set (`risk_eval_{train,calibration,demo}.csv`) legitimately
contains `would_chargeback` — that is its label, sanctioned by SYSTEM_SPEC.md §11.1 — but it never
carries `is_truly_risky` or any oracle-shaped column either.

## What D4 generated

Numbers below are the actual output of `python -m scripts.data.generate` against the pinned seed
in `scripts/data/common.py`, reported honestly rather than tuned to round numbers — see that
module's manifest for the full, current figures. As of this writing: roughly 15,100 logged
events across ~8,600 transactions and 60 customers, a recorded recovery rate of about 16%, a
truly-risky rate of about 2.8% (target: BUILD_PLAN.md §6.2's stated ~2.5%), and two embedded
shock decoys — a 12-event single-bank cluster and a 35-event four-bank cluster sharing one error
code — landed in the demo split for D11's offline shock-detector evaluation to check neither one
trips it.

The three-way split is temporal (by `event_created_at`'s calendar month), never random: a random
split would put the same customer on both sides and leak as-of features across it. `data:verify`
re-hashes every generated file against the committed manifest, so a reviewer can regenerate this
exact dataset from the seed and confirm it byte-for-byte.

## What is still open

- D5 trains the actual recovery scorer against `logged_train`/`logged_calibration`, fits Platt
  scaling, and fills in the Brier/BSS/SkillEff/calibration numbers this document currently only
  describes the mechanism for.
- D5 also retrains `src/domain/scenario/subscription.ts`'s placeholder model and, per
  BUILD_PLAN.md §6.7's correction, replaces `hour_of_day_risk` with the `hour_sin`/`hour_cos`
  pair this generator already emits.
- The risk gate's precision/recall/PR-AUC and the amount-weighted cost-threshold selection
  (BUILD_PLAN.md §6.6) are D5 work, against `risk_eval_calibration.csv`.
- D8 builds the DR/SNIPS/DM off-policy estimators against `oracle_counterfactuals.parquet` and
  the baseline bracket (B0–B5).
