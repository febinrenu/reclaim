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

## D5 — training, calibration, and the parity contract

`scripts/data/train_scorer.py` fits the real recovery scorer: thirteen shared features, five
action dummies (`DO_NOTHING` as the reference level), and seven hand-picked action interactions,
against `logged_train`. `StandardScaler` is fit and then folded algebraically into the
coefficients (`w'_j = w_j / σ_j`, `b' = b − Σ_j(w_j·μ_j/σ_j)`) before anything is written, so
`src/domain/scoring/recovery-model.ts` does a raw dot product with no scaler at all — nothing left
to forget on the TypeScript side. The fold is checked, not assumed: the script refuses to write
`recovery_model.json` unless the folded prediction matches the original scaler-pipeline's
`predict_proba` to under 1e-12 on 1,000 real holdout rows.

Platt scaling is fit on `logged_calibration` only. Every metric that appears anywhere —
Brier, BSS, ECE at k = 5/10/20, MCE, the Murphy decomposition, ROC-AUC — is computed on
`logged_demo`, the one split whose numbers are allowed to appear anywhere (BUILD_PLAN.md §6.6).
`Brier_ref` is computed from `logged_train`'s base rate specifically, so the reference cannot
peek at calibration or demo.

**Tuning the generator to be honestly hard, not just complex.** The first trained model scored
BSS ≈ 0.32 and a model-to-Bayes-floor gap of ≈ 0.008 — both outside `eval/test_generator_difficulty.py`'s
bounds, meaning the 13-feature-plus-interactions model was recovering *too much* of the true
process for the "we are not just recovering our own generator" claim to mean anything. Fixed by
weakening `scripts/data/dgp.py`'s visible, learnable signal (`WEIGHTS`, `ACTION_LIFT`) and raising
its heteroskedastic noise (`NOISE_SCALE`), then regenerating the D4 dataset and retraining, until
the model genuinely underfits with real margin: **AUC 0.690** (band: 0.68–0.82), **BSS 0.162**
(band: 0.08–0.25), and a model-to-Bayes-floor gap comfortably over the 0.015 floor. This changed
the committed D4 data files, not just D5's — the two milestones share one generator, and honesty
about difficulty is a property of the *data*, checked by code that runs against a *trained model*.

**The parity contract, checked for real.** `train_scorer.py` computes 42 golden vectors — more
than BUILD_PLAN.md §6.8's suggested "sixteen to twenty," covering the all-zero and all-median
rows, every one of the 13 features individually at ±3σ, every action at the median, the two
all-±3σ extremes, a cold-start row, and five random holdout rows — each as a
(features, action, row, expectedProbability) tuple in the committed model JSON.
`tests/unit/scorer.parity.test.ts` rebuilds every one of those rows independently in TypeScript
(`src/domain/scenario/subscription-model.ts`'s hand-ported `buildModelRow`) and asserts the score
matches to under 1e-12. All 42 pass. The same test also checks property P15 directly:
`MODEL_FEATURE_ORDER` (TypeScript) equals `featureOrder` (the trained model JSON) exactly.

**`hour_of_day_risk` → `hour_sin`/`hour_cos`**, per BUILD_PLAN.md §6.7's correction, is now the
shipped feature — `src/domain/scenario/subscription.ts` computes both from the decision hour via
`buildSubscriptionFeatures`, replacing D3's placeholder scalar entirely.

## What is still open

- The risk gate's precision/recall/PR-AUC and the amount-weighted cost-threshold selection
  (BUILD_PLAN.md §6.6) are not yet built, against `risk_eval_calibration.csv`.
- No `model_evaluations` row has been written to Postgres yet — that needs the live app and
  worker (D6+); the same numbers currently live only in `recovery_model.json`'s `metrics` field.
- The customer-disjoint secondary split and the five-seed spread (BUILD_PLAN.md §6.6) are not
  built. Only one seed and one (temporal) split have been checked.
- D8 builds the DR/SNIPS/DM off-policy estimators against `oracle_counterfactuals.parquet` and
  the baseline bracket (B0–B5), using this trained model as `q̂`.

## D8 — off-policy evaluation, the bracket, and the estimator-error audit

`scripts/data/run_ope.py` (`npm run ope`) evaluates the six-policy bracket on `logged_demo` alone
— the only split whose numbers are allowed to appear anywhere — using the reward `r_i = y_i ·
amount_i − InterventionCost(a_i) − ContactFatigueCost(s_i,a_i)`, in integer paise
(`scripts/data/reward.py`, the exact cost table `src/domain/scenario/subscription.ts` ships,
kept as plain paise rather than re-deriving `MilliPaise` arithmetic this script has no parity
contract with). `q̂(s,a)` is the trained recovery scorer's own probability turned into expected
reward — `scripts/data/q_hat.py` re-scores every row through `model_spec.build_row`, the same
feature/interaction layout `train_scorer.py` fit against, so this can never silently drift from
the shipped model.

**The headline claim (BUILD_PLAN.md §6.3's exact template, with real numbers):**

> Our doubly-robust estimate of Reclaim's net recovery was ₹363.09 per transaction (95% CI
> ₹165.99–₹570.95). Ground truth, from held-out oracle counterfactuals the estimator never saw
> while estimating, was ₹347.93 — an error of 4.4%. The incumbent logging policy itself (B4,
> directly observable as an on-policy mean, no estimation needed) came in at ₹274.42, oracle
> ₹267.01, error 2.8%.

**An honest finding, not a bug: the demo split's ~3,000 rows are not enough to keep the DR point
estimates in the expected bracket order for every baseline.** B0, B1, and B3 are extreme,
low-propensity, one-hot policies against an epsilon-greedy logging policy — their effective sample
sizes (ESS) come out at 94, 113, and 201 respectively, two of the three genuinely under
BUILD_PLAN.md §6.4's 200 floor, and `ope_results.json`'s `ess_trustworthy` flag says so plainly
rather than quoting a number that shouldn't be trusted (`eval/test_ope.py`'s
`test_low_ess_policies_are_flagged_untrustworthy_rather_than_silently_reported`). With that much
sampling noise on the point estimates, the DR-estimated order came out `B0 ≤ B4 ≤ B3 ≤ Reclaim ≤
B1 ≤ B2 ≤ B5`, not BUILD_PLAN.md §6.5's expected `B0 ≤ B3 ≤ B1 ≤ B2 ≤ B4 ≤ Reclaim ≤ B5`. The
oracle-audited ground truth — computed only for this check, never fed into any estimator — tells
the real story: `B3(236) ≤ B1(245) ≤ B0(250) ≤ B4(267) ≤ B2(404) ≤ Reclaim(348) ≤ B5(929)` is close
to the expected shape (Reclaim genuinely beats every single-decision-point baseline;
`eval/test_ope.py`'s `test_reclaim_beats_every_baseline_under_oracle_ground_truth` asserts this
directly), and the two best-identified policies in the table — B4 (trivially well-identified: it
*is* the logging policy) and Reclaim (the headline claim) — both land within 5% of oracle ground
truth. Reporting the noisy point-estimate order rather than quietly re-sorting by the oracle column
is the honest choice; the ESS flag is exactly the tool BUILD_PLAN.md names for a reader to tell the
two apart.

`HeadroomCaptured = (V_Reclaim − V_B4) / (V_B5 − V_B4) = 13.6%` on the DR/on-policy-mean estimates.

**B2 (sequential retry, up to three attempts, stop on success) is evaluated by oracle simulation
only, never DR/SNIPS/DM** — BUILD_PLAN.md §6.4 is explicit that single-step importance weighting
is invalid for a sequential policy. A further, documented limitation of this specific simulation:
it walks each transaction's *actually observed* up-to-three-attempt chain and asks, at each
observed state, "what if RETRY_NOW had been tried there instead" (`y_true_RETRY_NOW` from the
oracle file at that state), stopping at first success. That is a valid question, but it is not the
same as a true retry-conditional simulation with decay under a forced RETRY_NOW at every step
(BUILD_PLAN.md §6.4's own phrase) — the observed second and third attempts happened because
whatever action the logging policy actually took at the prior step failed, not because a
hypothetical all-RETRY_NOW trajectory failed. Building the latter needs the generator itself to
emit forced-RETRY_NOW state decay, which D4 did not build, and re-opening D4's generator was out of
scope for a single day. Recorded here as a first-order approximation rather than silently presented
as exact. **B5 (perfect foresight)** is the oracle file's per-event best-of-six-actions value, the
ceiling the whole bracket is measured against — ₹928.63/transaction, roughly 3.4× the incumbent
heuristic.

Weight clipping at 30 stayed a provable no-op on this run too:
`eval/test_ope.py::test_min_propensity_makes_weight_clip_a_no_op` checks the logging policy's own
minimum propensity (0.20/6) implies a maximum importance weight of exactly 30, independent of
anything the estimator computed.

`npm run ope` writes `docs/ope_results.json`; `eval/test_ope.py` (9 tests) checks the pure
estimator math (DM/SNIPS/DR agreement when on-policy, DR's double-robustness under a perfect
`q̂`), the ESS-untrustworthy flag, and the estimator-error audit against oracle ground truth. No
`model_evaluations` row has been written to Postgres for these numbers yet — same open item D5
already noted, still waiting on a place in the live app to put an off-policy evaluation run.
