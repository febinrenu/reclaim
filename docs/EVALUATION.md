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

**D10 addendum:** `train_scorer.py` now also writes `calibration_bins` and
`prediction_histogram` into `recovery_model.json` — the exact 10-bin, Wilson-95%-CI
data `_make_calibration_chart` already computed for the static PNG, exposed as plain
data so `/model`'s in-app reliability curve (hand-rolled SVG, BUILD_PLAN.md's D10
row: "no charting library on the critical path") reads the identical numbers rather
than a second, independently-computed set that could silently drift from the chart.
Retraining after this change reproduced the exact same coefficients, Platt
parameters, and all 42 golden vectors — confirmed by rerunning
`scorer.parity.test.ts` (44 assertions, still 1e-12) — since the added fields are
additive, not a change to the fit itself.

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

## D11 — the shock detector, the stopping rule, and the risk gate's own evaluation

**The shock detector (SYSTEM_SPEC.md §15) is wired into the live decision pipeline for real.**
`src/app/worker/shock-detector.ts` records every genuinely-failed event toward a rolling
`failrate:{bank}:{errorCode}` counter (`KvPort.incrWithTtl`, `src/ports/kv.ts`) and sets a 15-minute
`suppress:{bank}:{errorCode}` flag once the count exceeds `SHOCK_THRESHOLD = 20` — chosen with real
margin on both sides of BUILD_PLAN.md §6.10's two named decoys (a 12-event sub-threshold cluster,
and a 35-event cluster spread across 4 banks sharing one error code). `process-event.ts` checks
suppression on every event, failed or not, and threads it into `DecisionInput.shockSuppressed` —
the domain-layer wiring (`decide()`, `SUBSCRIPTION_DEFAULT_POLICY.shockSuppressedActions`) already
existed since D3; D11's job was building the real trigger.

**The spec's own TTL bug (`INCR` then `EXPIRE` as two calls, so a crash in between leaves a key
suppressed or inflated forever) never had a chance to exist here**, because `incrWithTtl` was
already built atomically back in D7 for the language-layer budget guard — one `INSERT ... ON
CONFLICT DO UPDATE` statement in the Postgres adapter, one synchronous critical section in the
in-memory adapter. `tests/integration/shock-detector.test.ts` checks this against real PGlite
directly: after crossing the threshold, the row's `expires_at` is never `NULL`.

**Verified live, against a running production build**, with `npm run burst`: fired 35 correlated
failures against one bank/error-code pair, a 12-event sub-threshold decoy, and a 35-event
4-bank decoy, all through the real signed webhook path. Result: the main burst tripped in
466ms (event 21 of 35 — the threshold crossing at exactly the 21st failure), neither decoy
tripped, and RETRY_NOW's own EV breakdown entry — computed for every decision regardless of
whether it wins, per SYSTEM_SPEC.md §11's "the counterfactual is always on the record" — flipped
from `allowed: true` to `allowed: false, disallowedReason: 'shock_suppressed'` at exactly that
event, with a rationale reading "Deferred rather than retried immediately. The shock detector has
this bank/error-code pair suppressed right now...".

**A real, rigorously-checked finding, not a bug: on the model actually shipped, `chosen_action`
itself never flips from `RETRY_NOW` to `RETRY_LATER`, because `RETRY_NOW` was never being chosen in
the first place.** `RETRY_LATER`'s own trained coefficient (+0.52) dominates `RETRY_NOW`'s (−0.12)
by more than the largest possible swing either action's interaction terms can produce — proven
both analytically (their EV difference has a fixed sign for any amount, since both actions cost ₹0
to attempt, so `sign(EV_RETRY_NOW − EV_RETRY_LATER)` cannot change with amount) and empirically (a
200,000-random-feature-vector sweep found `p(RETRY_NOW) − p(RETRY_LATER)` was never once positive).
The mechanism is fully correct and demonstrated on the actual code path (RETRY_NOW's `allowed` flag
genuinely flips); what it does *not* do on this dataset is change which action wins, because the
model had already learned to prefer a deferred retry over an immediate one before the shock
detector ever enters the picture. Recorded honestly rather than staged to match the illustrative
example's exact wording.

**The stopping rule had a real, live gap, closed today.** `transactions.repo.ts`'s
`incrementRetryCount` existed since D2 but nothing had ever called it — `retryIndex` in
`process-event.ts` only *read* the stored count, never advanced it, so `decide()`'s
`retryCount >= maxRetries` stopping rule could never actually fire on the live path; it was fully
correct in the domain layer and completely inert in the running system. Fixed by calling
`incrementRetryCount` inside T4 whenever the chosen action is `RETRY_NOW`/`RETRY_LATER`. Verified
directly against the burst's own database state: `max(retry_count)` across every transaction stays
well under the limit of 3, as expected for single-attempt synthetic events.

**The property suite is complete: all fifteen properties from BUILD_PLAN.md §6.9.** P6–P9, P12, and
P14 landed today in `tests/property/decide.property.test.ts` as real `fast-check` properties, not
just worked examples. P8 ("there exists a threshold below which the null action wins") is scoped
honestly to the three actions with a strictly positive intervention cost
(`WHATSAPP_NUDGE`/`PAYMENT_LINK`/`ESCALATE_HUMAN`) rather than claimed for all six — `RETRY_NOW`
and `RETRY_LATER` cost ₹0 by design, so their EV scales with amount at exactly the rate
`DO_NOTHING`'s does, and no amount threshold can flip a zero-cost action's ranking against the
null action. P13 (crash-reclaim across a process restart) needs a real transaction boundary a pure
property test cannot probe; it stays checked where it already was, `tests/integration/webhook-worker.test.ts`,
now named and cross-referenced so the property inventory stays traceable.

**The risk gate's own evaluation (SYSTEM_SPEC.md §11.1, BUILD_PLAN.md §6.6), not yet built as of
D5, lands today.** `scripts/data/risk_eval.py` (`npm run risk:eval`) scores `risk_eval_calibration.csv`
and `risk_eval_demo.csv` with the exact weighted rule sum `src/domain/risk/rules.ts` ships (checked
by literal value in `eval/test_risk_eval.py`, since there is no shared JSON artifact the way the
recovery model has one), reports a full PR curve rather than a single number, and picks the
operating threshold by amount-weighted expected cost — `τ* = argmin_τ TotalCost(τ)`, chosen on
calibration, reported on demo, exactly SYSTEM_SPEC.md §11.1's own discipline.

Results: PR-AUC 0.204 against a prevalence baseline of 0.029 (roughly 7× lift). At the
calibration-chosen threshold (0.45): precision 24.8%, recall 38.2% (34 true positives, 103 false
positives, 55 false negatives). The complete cost argument SYSTEM_SPEC.md §11.1 asks for: flagging
nothing costs ₹2,82,494 on the demo split, flagging everything costs ₹4,30,451, and the chosen
operating point costs ₹1,86,540 — genuinely the cheapest of the three, not just the middle one by
construction. False-positive cost specifically: ₹14,003 across 103 unnecessary escalations.

**A real bug in the PR-AUC computation, found by a test whose own expectation was correct and
caught the code being wrong, not the other way around.** The first version of `pr_curve` swept an
arbitrary threshold grid (every observed score, plus synthetic 0.0/1.0 endpoints) and sorted the
resulting points by recall alone. For ties at the same recall — which happen constantly once
recall has already saturated at 1.0 but lower thresholds keep sweeping in more negatives — the sort
was not also stable by precision, so the trapezoidal integration could walk *backward* in precision
at a fixed recall, undercounting the area. `eval/test_risk_eval.py`'s
`test_pr_auc_is_perfect_for_a_perfectly_separating_score` (a 4-point case with total separation,
where AUC must be exactly 1.0) caught it returning 0.875. Fixed by switching to the standard
rank-based construction (`sklearn.metrics.precision_recall_curve`'s own method): sort by score
descending, and accumulate tp/fp one score-tied-group at a time, so recall is non-decreasing by
construction and precision is well-defined pointwise along the curve — no arbitrary threshold grid,
no possibility of walking backward. The real numbers above are the corrected ones (PR-AUC moved
from 0.161 to 0.204 once fixed).

`eval/test_risk_eval.py` (8 tests): the weight-parity check against the shipped TypeScript, the PR
curve's monotonicity and perfect-separation cases, the cost formula against SYSTEM_SPEC.md §11.1
verbatim, and the two headline claims (PR-AUC clears its baseline with margin; the chosen operating
point beats both brackets) checked against the committed `docs/risk_eval_results.json`. No
`model_evaluations` row written yet — same open item as the recovery scorer's own metrics.

## D12 — the policy simulator, and the B2B receivables chaser (proving generalization)

**The policy simulator** (`src/domain/simulate.ts`'s `replayBatch`/`summarizeReplay`, pure —
literally `decide()` mapped over stored `decision_input` rows under a possibly-different `Policy`)
reads a stored batch and recomputes both a baseline and a varied-policy run entirely offline.
Verified directly against real Postgres: running a simulation writes zero `recovery_audit` rows and
creates zero new `batches` rows, and re-running the exact baseline policy reproduces its own
recomputed baseline byte for byte — both checked as assertions, not just claimed.

A real, checked finding along the way, in the same spirit as D11's RETRY_NOW result: halving
`WHATSAPP_NUDGE`'s intervention cost — BUILD_PLAN.md §1.4's own illustrative example — never flips
the argmax on the model actually shipped. The cost (₹0.35) is three-plus orders of magnitude
smaller than any real amount×probability EV term, and `WHATSAPP_NUDGE` turns out to be a dominated
action on this trained model too (`PAYMENT_LINK`'s own `prior_success_rate` interaction and
`RETRY_LATER`'s dummy both sit too far ahead for any plausible cost tweak to close the gap — checked
directly across a wide amount sweep with the cost set to zero, not just halved). The risk threshold
is the lever that reliably and dramatically shifts the distribution instead, since crossing it is a
hard, discrete cutover rather than a small EV nudge — also named alongside the cost table in
BUILD_PLAN.md §1.4 point 1, and demonstrated directly.

**The B2B receivables chaser** (SYSTEM_SPEC.md §16) is a second, fully independent instance of the
same generator → training → scenario pipeline: `scripts/data_b2b/` (its own `dgp.py`,
`logging_policy.py`, `model_spec.py`, `loader.py`, `manifest.py`, `train_scorer.py`, its own seed
`20260901`, its own epoch), writing to `data/synthetic/b2b_receivable/`, and
`src/domain/scenario/b2b-receivable.ts`/`b2b-receivable-model.ts` on the TypeScript side. Four
actions (`SEND_REMINDER`, `OFFER_PAYMENT_PLAN`, `ESCALATE_COLLECTIONS`, `WRITE_OFF` — `WRITE_OFF`
plays `DO_NOTHING`'s structural role as the null action), nine shared features (days overdue, this
customer's own on-time-payment history, invoice size relative to their own average, chase rounds so
far, a repeat-overdue flag, a quarter-cyclicality pair in place of subscription's hour-of-day pair,
a 14-day contact fatigue window instead of 7 — a B2B relationship is chased far less often — and
relationship tenure), three action dummies, and three hand-picked interactions.

**Genuinely reused, not duplicated:** `computeEv`, `evaluateRisk`, `decide()`, the audit schema, and
`scripts/data/risk.py`'s compromised-actor/noisy-signal mechanism (the same four-field `RiskInput`
shape, reinterpreted rather than renamed — `geoMismatch` becomes a billing-address mismatch,
`cardVelocityHigh` becomes an unusual burst of large invoices, and so on, documented in
`b2b-receivable.ts`'s own comment). `tests/unit/b2b-scenario.test.ts` checks `decide()` genuinely
handles the new vocabulary correctly (feasibility gating on opt-out, the stopping rule, the risk
gate, the null action's own non-zero EV) with zero scenario-specific code inside `decide()` itself
— the strongest form of "the engine generalizes" a test can state.

**Honestly hard, not by luck.** The generator needed two tuning passes (BSS started at 0.46, far
outside a defensible band) before landing at AUC 0.646 / BSS 0.128 — comparable difficulty to
subscription's own 0.690 / 0.162, checked the same way (`eval/test_b2b.py`, mirroring
`test_generator_difficulty.py`'s AUC/BSS-band and Bayes-floor-gap checks, plus the oracle firewall
and the overlap/positivity floor). `MAX_CHASE_ROUNDS` was set to 1 (two total chase attempts, not
subscription's three) specifically because B2B's slower cadence meant a third round's contingency
cells fell under the 30-row floor — a real data-volume constraint, not an arbitrary number.

**Another real, checked finding, the same shape as D11's and the simulator's own:** replaying 500
real synthetic demo rows through `decide()` never once selects `SEND_REMINDER` or `WRITE_OFF` —
only `OFFER_PAYMENT_PLAN` and `ESCALATE_COLLECTIONS` win, on this trained model. Consistent with the
now-familiar pattern: an action whose own dummy coefficient trails another action's by more than any
interaction term can close is architecturally unselectable, regardless of state. Recorded here
rather than tuned away, since forcing every action to be individually competitive was never the
generator's actual goal.

**Explicitly not built, and stated plainly rather than silently dropped:** this scenario is
exercised through the simulator and offline training/evaluation only. It is not wired into
`process-event.ts`, `container.ts`, or the webhook path — SYSTEM_SPEC.md §16's own "half a day,
instantiating an architecture" framing and BUILD_PLAN.md's D12 exit test (no file touched outside
the scenario/features/risk/templates/seeds directories) both point the same way. The B2B copy banks
(`src/language/templates/reminder-en.ts`) are committed and parity-checked but not yet wired into
`template-engine.ts`'s selection function, for the identical reason. `git diff --stat` for this
scenario's commit touches only `scripts/data_b2b/`, `data/synthetic/b2b_receivable/`,
`src/domain/scenario/b2b-*`, `src/language/templates/reminder-en.ts`, `docs/`, `eval/test_b2b.py`,
and their tests — no file inside `src/app/worker/`, `src/ports/`, `src/config/`, or `app/api/` is
touched by it.
