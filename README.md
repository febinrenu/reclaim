# Reclaim

[![CI](https://github.com/febinrenu/reclaim/actions/workflows/ci.yml/badge.svg)](https://github.com/febinrenu/reclaim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Risk-aware revenue recovery. It prices every recovery action, including doing nothing.**

Most systems in this space predict whether a payment will fail. Reclaim asks a different question:
given a payment has already failed, **is it worth spending money and risk to get it back, and if
so, how?** Every action costs something — a nudge costs paise, a human escalation costs an agent's
time, and chasing a customer who was never going to pay costs goodwill you cannot buy back. So
recovery is a constrained optimisation problem rather than a retry loop, and this system is
explicitly allowed to decide that the right action is none.

### The short version

|  |  |
|---|---|
| **Setup** | `git clone && npm install && npm run dev`. No API keys, no `.env`, no Docker, no database to provision. Every external dependency sits behind a port with a working local implementation. |
| **The measured result** | On held-out outcomes the model never saw, Reclaim recovers **1.42× what retrying everything does** — and **retrying everything comes out behind doing nothing**, because the fee on every attempt costs more than the recovery is worth. [Details ↓](#how-much-better-than-retrying-everything--measured-on-outcomes-the-model-never-saw) |
| **What is AI, and what is not** | A calibrated logistic regression supplies one number, `P(recover \| state, action)`. A language model writes copy and nothing else — structurally unable to reach a payments client, enforced five ways including a transitive import-graph test. Every rupee of arithmetic, every state transition, and every API call is plain, tested TypeScript. [Details ↓](#what-is-ai-and-what-is-not) |
| **Escalation goes somewhere** | `ESCALATE_HUMAN` creates a real work item with an owner and a deadline at `/operator`. Resolving one is the only place in this project where an outcome comes from a person rather than the data generator. |
| **Verify it** | `npm test` (529 tests), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run eval`. No secrets needed for any of them. CI runs the same commands on Linux and Windows, against both database drivers. |
| **What it costs to run** | ₹36.65/txn to operate against ₹80.92 of measured uplift — **it pays for itself about twice over**, not the 20× the batch runner's cost row implies. The cost is almost entirely one action: a ₹40 human escalation, which the policy picks for 91.6% of these amounts. [Details ↓](#what-it-costs-to-run-and-the-number-that-is-not-flattering) |
| **The honest part** | The data is synthetic. The loudest number in this README used to be circular and is now [documented as such](docs/EVALUATION.md). Two of six risk signals are still defaults. [Full list](docs/LIMITATIONS.md). |

---

## Run it in one minute

```bash
git clone https://github.com/febinrenu/reclaim.git
cd reclaim
npm install
npm run dev
```

That is the whole setup. **No API keys, no `.env` file, no Docker, no database to provision.**

On Windows, `start.bat` (double-click it, or run it from a terminal) does the same
thing with real preflight checks on top: verifies Node.js is present and new
enough, installs dependencies only when `package-lock.json` actually changed,
detects a dev server for this project already running elsewhere and points you
straight at it instead of failing confusingly, and never leaves a bare crashed
window with no explanation. `start.bat clean` clears the build cache and the
embedded database if something ever gets stuck — never your source or `.env`.

This is deliberate, and it is the single most persuasive fact about this project. Every external
dependency — database, locks, language model, payments — sits behind a port with two
implementations, and the one that runs is chosen automatically by whether a credential happens to be
present. Absent is never an error; it is the default, fully-supported state. The app prints its own
configuration on boot and serves the identical table at `/api/health`, so nothing is hidden:

```
  Reclaim 0.1.0   mode: LOCAL, zero credentials
  --------------------------------------------------------------------------
   -    database    pglite      .data/pglite     embedded Postgres, no Docker needed
   -    locks       postgres    kv table         never the idempotency authority
   -    language    template    deterministic    hand written variants including Hinglish
   -    payments    simulator   self signed      identical HMAC path
   -    executor    dry_run     records intent   touches no network
```

To upgrade any single port to a real service, see [`docs/SETUP.md`](docs/SETUP.md). Each one is
independent; partial configuration is a fully supported state, and this document says plainly which
of those upgrades were actually exercised during this build and which were not.

## Verify it

```bash
npm test           # TypeScript: unit + property + integration
npm run typecheck
npm run lint
npm run build

pip install -r scripts/data/requirements.txt   # once, for the Python side
npm run eval                                    # the synthetic-data and evaluation test suite
```

No secrets are needed anywhere in that list — every test pins a local adapter. CI runs the identical
commands, plus the integration suite twice more (once against embedded PGlite, once against a real
`postgres:17-alpine` service container), on every push, on both Ubuntu and Windows. Read
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) to confirm there is no secret configuration
anywhere in it.

To see the decision engine actually run — post 300 synthetic, signed webhook events through the real
ingestion path and watch the dashboard render live — see the demo path in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## The decision model

For a failed payment in state `s`, and each available action `a`:

```
EV(a) = P(recover | s, a) x RecoverableAmount
        - InterventionCost(a)
        - ComputeCost(a)
        - RiskPenalty(s, a)
        - ContactFatigueCost(s, a)

choose a* = argmax EV(a)
```

`EV(DO_NOTHING)` is **not** zero. Customers retry on their own, so doing nothing has a real,
positive expected value, and the quantity that actually matters is the *uplift* of acting over not
acting — crediting an intervention with recovery that would have happened anyway is the single most
common way this kind of system lies to itself. `RiskPenalty` is not a subtracted number either: a
risk score that clears the gate's threshold makes every non-escalation action structurally
infeasible, not merely more expensive, because a fixed penalty can always be out-competed by a large
enough transaction amount.

### A real worked example, from a live batch run

This is not a constructed illustration — it is one actual row from `recovery_audit`, an event that
ran through the real webhook path during this project's own verification. A ₹289 invoice, no
systemic shock active on `RETRY_NOW`'s own bank/error-code pair... except there was one, so watch
what that does to the first row:

| Action | P(recover) | Expected gain | Cost | **EV** | |
|---|---|---|---|---|---|
| `RETRY_NOW` | 0.52% | ₹1.491 | ₹0 | *excluded* | shock-suppressed — a correlated failure burst was active |
| `RETRY_LATER` | 0.96% | ₹2.776 | ₹0 | ₹2.776 | |
| **`PAYMENT_LINK`** | **1.08%** | **₹3.129** | **₹0.35** | **₹2.779** | **chosen — narrowly beats RETRY_LATER** |
| `WHATSAPP_NUDGE` | 0.80% | ₹2.322 | ₹0.35 | ₹1.972 | |
| `ESCALATE_HUMAN` | 1.56% | ₹4.522 | ₹40.00 | **−₹35.478** | highest P(recover), deeply negative EV — a ₹289 invoice cannot justify a ₹40 human-agent cost |
| `DO_NOTHING` | 0.57% | ₹1.660 | ₹0 | ₹1.660 | the organic baseline — **not zero** |

`PAYMENT_LINK` wins by ₹0.003 over `RETRY_LATER` — genuinely close, and exactly the kind of decision
a fixed rule ("always retry first") would get wrong in the other direction on a different day. The
uplift over doing nothing is ₹1.118/transaction. `ESCALATE_HUMAN` has by far the *highest* modelled
recovery probability and is by far the *worst* choice, because probability alone was never the
question — the whole point of pricing every action, including none, is that the highest-probability
action and the highest-value action are not the same action here.

---

## What is AI, and what is not

| Layer | Implementation | Responsibility |
|---|---|---|
| State transitions, retry limits, money arithmetic, the EV formula, idempotency, stopping rules, the audit trail, every payments API call | Plain TypeScript, unit and property tested | Anything where being wrong costs money or trust. No model in the loop, ever. |
| `P(recover \| s, a)` | Logistic regression, trained offline, calibration checked against held-out data, not assumed | A calibrated probability, not a raw score — see Results below |
| Recovery message copy, and the one-sentence rationale explaining a decision already made | Groq, with a deterministic template fallback | Language only. Never touches a number that affects money movement, and cannot |
| A small, deterministic, weighted rule set flagging genuinely risky transactions | Four hand-set weights, not ML, not an LLM | An independent hard gate — not a subtracted penalty an amount could out-compete |

**Rejected alternatives, on the record:** gradient boosting over logistic regression — measured,
not assumed (`npm run benchmark:gbm`, `docs/MODEL_COMPARISON.md`): logistic regression wins on
BSS (0.1619 vs 0.1352) and ROC-AUC (0.6903 vs 0.6355) on the identical held-out split, see
`docs/DECISIONS.md` entry 2; isotonic regression over Platt scaling for calibration
(`docs/adr/0004` — overfits at this data volume, and needs a second parity-contract surface);
`class_weight='balanced'` (`docs/adr/0005` — destroys calibration for a discrimination gain this
project's economics do not reward); cross-fitted doubly-robust estimation, learned propensities, and
four other off-policy techniques (`docs/adr/0003` — solve problems this project's synthetic setup
does not have).

**The language model structurally cannot reach a payments client.** Not by policy — by construction,
enforced five independent ways:

1. `DataOnly<CopyRequest>` — a mapped type that turns any function-, Promise-, or class-valued field
   into `never`, so an argument carrying a live client object literally cannot be constructed.
2. `GenerateCopyDeps` (`src/language/generate-copy.ts:24`) has exactly one field, `llm`. There is no
   slot to smuggle a `PaymentsPort` into, and adding one is a compile error at every call site.
3. An ESLint boundary rule forbids `src/language/**` from importing `@/ports/executor`,
   `@/adapters/payments`, or `@/repositories` at all.
4. `tests/unit/firewall.test.ts` walks the *transitive* import graph of every file under
   `src/language/`, so the guarantee survives a refactor that adds an indirect path, not just a
   direct one.
5. **Ordering.** The pipeline is decide, then speak. `decide()` has already returned and the
   executor has already run before any language call is made
   (`src/app/worker/process-event.ts`), and `CopyResult` carries no action field. Even a fully
   adversarial model response can only change a string in a rationale column, never what got
   executed.

The amount-hallucination guardrail follows the same instinct: the exact rupee amount is **never**
sent to the model, only a bucketed band (`src/language/redact-facts.ts`); the model is instructed to
emit a literal `{{amount}}` placeholder, filled in afterward from the real transaction
(`src/language/amount-slot.ts`); and a regex still checks the raw model output for any stray
rupee-shaped figure as defense in depth, falling back to a template if the model ever ignores the
instruction.

---

## Results

Every number below is generated by [`scripts/report.py`](scripts/report.py) (`npm run report`)
directly from the committed artifacts each day's own training and evaluation scripts wrote — never
hand-typed. The full generated file, including the risk gate's PR curve and every off-policy
estimator's own row, is [`docs/RESULTS.md`](docs/RESULTS.md).

### The recovery scorer

| | Subscription | B2B receivables |
|---|---|---|
| Base rate (train) | 18.4% | 24.7% |
| Brier score (after Platt) | 0.1259 | 0.1623 |
| Brier skill score | 0.1619 | 0.1278 |
| ROC-AUC | 0.6903 | 0.6461 |
| ECE @ k=10 | 0.0321 | 0.0431 |

Deliberately imperfect: `eval/test_generator_difficulty.py` fails CI if either scenario's own
generator becomes too easy for these numbers to mean anything — a model that appears to fully
recover its own synthetic generator would be proof of circularity, not skill. The calibration chart
(reliability curve, 10 equal-frequency bins, Wilson 95% intervals, plus the histogram of where
predictions actually land) is [`docs/calibration_recovery_v1.png`](docs/calibration_recovery_v1.png)
and rendered live at `/model`.

**These numbers are a temporal holdout, not a customer-disjoint one, and that gap is now
measured, not just named.** `SPLIT_MONTHS` splits chronologically (train = months 1-4, demo =
month 6) specifically to respect the backward-looking feature contract — but the DGP's customer
pool is fixed once and reused across the whole timeline, so a demo-split customer can already be
partially known to the model. `scripts/data/customer_disjoint_validation.py`
(`npm run scorer:validate-customer-disjoint`) checks this directly: **every one of the 60 demo
customers also appears in train.** Re-splitting by customer instead of by time (5 seeds, same
architecture, refit fresh each time) gives Brier 0.1418 ± 0.0131 against the shipped 0.1259 — the
model is measurably worse on genuinely unseen customers than the headline number suggests. Full
account in `docs/CUSTOMER_DISJOINT_VALIDATION.md`.

### Off-policy evaluation — the six-policy bracket

The doubly-robust estimate of Reclaim's own net recovery was **₹363.09/transaction** (95% CI
₹165.99–₹570.95). Ground truth, from held-out oracle counterfactuals the estimator never saw while
estimating, was **₹347.93** — an error of **4.4%**. The incumbent logging policy (the best-anchored
number in the table — it needs no estimation at all, since every logged row *was* drawn from it)
came in at ₹274.42, oracle ₹267.01, error 2.8%.

`HeadroomCaptured = (Reclaim − incumbent) / (oracle-optimal − incumbent)` is **13.6%** computed on
the estimates and **12.2%** computed on oracle truth. Both are reported, and the oracle one is the
one to trust wherever a policy's own effective sample size is flagged — see the B2B bracket, where
the estimate-based figure came out *negative* while the policy ranked first of everything
deployable on truth.

Full six-row bracket, every estimator, every confidence interval, and the honest finding that three
low-effective-sample-size baselines land out of their expected order on ~3,000 demo rows (flagged by
their own ESS rather than quoted at face value) are in `docs/RESULTS.md` and `docs/EVALUATION.md`'s
D8 section.

**B2B has its own full bracket too** (`scripts/data_b2b/run_ope.py`, `npm run ope:b2b`) — same
estimators, same methodology, its own action vocabulary and reward structure. **On oracle truth,
Reclaim ranks first of all five deployable policies in both scenarios:**

| | Reclaim | Incumbent | Retry-everything | Ceiling | Headroom captured |
|---|---|---|---|---|---|
| Subscription (₹/txn) | **347.93** | 267.01 | 244.62 | 928.63 | **12.2%** |
| B2B receivables (₹/invoice) | **12,333.69** | 10,729.71 | 10,624.91 | 22,148.76 | **14.0%** |

**This README used to report B2B as a near-failure, and that was a reporting artifact rather than
a result.** It said Reclaim's estimate "lands *below* the incumbent" and quoted a **negative**
`HeadroomCaptured` of −3.1%. Both came from the doubly-robust *estimate* (₹10,628 against the
incumbent's ₹10,978) — an estimate whose own effective sample size, 188 of 3,680 rows, marks it
untrustworthy, because Reclaim's chosen actions diverge far enough from the logged policy that
single-step importance weighting has almost nothing to reweight. Deriving a headline from a number
the bracket itself flags is measuring the estimator, not the policy.

Computed on oracle truth instead — outcomes the model never saw — B2B's headroom is **+14.0%**,
slightly *better* than subscription's 12.2%, and Reclaim's value is the highest of anything
deployable. Both figures are now reported side by side, with the estimate-based one explicitly
marked as the one to distrust wherever ESS is flagged. Full bracket, both scenarios, in
[`docs/RESULTS.md`](docs/RESULTS.md).

One finding does **not** carry across: in B2B, retrying everything genuinely does beat doing
nothing (₹10,624.91 against ₹9,594.94), because these invoices are large enough that even an
untargeted retry pays for its own fee. The subscription scenario is the opposite. The report
generator now emits whichever is true per scenario rather than asserting one of them for both —
it briefly did the latter and printed a self-contradicting sentence, which is the class of error
this whole generated-reporting pipeline exists to prevent.

### The risk gate

PR-AUC **0.2038** against a 2.93% prevalence baseline — a 7.0× lift. At the calibration-chosen
threshold: precision 24.8%, recall 38.2%. The complete cost argument: flagging nothing costs
₹2,82,494 on the demo split, flagging everything costs ₹4,30,451, and the actual operating point
costs ₹1,86,540 — genuinely the cheapest of the three, computed the same way Track 02's own bar
asks for (false-positive cost in real rupees), applied here as an internal discipline even though
this submission targets Track 03.

### How much better than retrying everything — measured on outcomes the model never saw

This is the number Track 03's bar actually asks for, and it is measured against
`oracle_counterfactuals.parquet`: per-action true outcomes generated by the DGP, firewalled from
the serving path by an ESLint boundary rule and `eval/test_oracle_firewall.py`, and never visible
to the trained model at any point. Every policy is scored on the same 3,042 held-out events.

| Policy | Net recovery (₹/txn) | vs. retry-everything | |
|---|---|---|---|
| Retry everything | 244.62 | — | `RETRY_NOW` on every event |
| Do nothing | 250.05 | **+5.42** | the organic baseline |
| Incumbent logged policy | 267.01 | +22.38 | what actually happened; needs no estimation |
| **Reclaim** | **347.93** | **+103.31 (1.42×)** | risk-gated argmax-EV over every action, including none |
| Oracle-optimal ceiling | 928.63 | +684.01 | best action per event, known only to the DGP |

**Reclaim recovers 1.42× what retrying everything does**, and 1.30× the incumbent policy.

**And retrying everything is measurably worse than doing nothing** — ₹244.62 against ₹250.05. That
is this whole project's thesis arriving as a result rather than an assertion: the gateway fee on
every attempt, plus the small recovery lift on payments that were never going to convert, costs
more than the recovery is worth. A retry loop is not a weaker version of this system; on these
outcomes it is worse than having no system at all.

Generated by `npm run report` into [`docs/RESULTS.md`](docs/RESULTS.md), never hand-typed.

### The correction that produced that table

**This section used to claim 3×, from the batch runner, and that comparison was circular.**
Worth stating plainly because it was the single loudest number in this README.

`src/app/worker/process-event.ts` settles a batch event by drawing against the **chosen** action's
own modelled `pRecover`. `src/app/batch/naive-baseline.ts` draws against `RETRY_NOW`'s modelled
`pRecover`, under the same seed. So per event there is one uniform draw `u`: Reclaim recovers iff
`u < p_chosen`, naive iff `u < p_RETRY_NOW`. An argmax-EV policy picks higher-`p` actions
essentially by construction — so Reclaim won that comparison **before the batch ran**. The model
was grading its own homework against its own answer key. Common random numbers made it
*internally* consistent, which is what made it look rigorous, and did nothing about the
circularity.

The oracle-truth number above is what survives when the outcome comes from the DGP instead of
from the model. It is smaller — 1.42×, not 3× — and it is real.

### What it costs to run, and the number that is not flattering

A recovery system that returns more than it costs is the only kind worth deploying, so
here is the cost side, derived from the same split and the same oracle-truth values as the
table above — the action mix Reclaim actually chooses, priced with the identical
intervention-cost table `decide()` uses.

| | ₹/txn |
|---|---|
| Cost to operate | 36.65 |
| Measured uplift over the incumbent policy | 80.92 |
| **Net** | **44.28** |
| Return per rupee of operating spend | **2.21×** |

Per 1,000 transactions: **₹36,647** to operate, **₹80,923** of measured uplift, **₹44,276**
net. It pays for itself roughly twice over — a real result, and a far more modest one than
the batch runner's "1/20th the intervention cost" row implies.

**Why the gap, stated rather than left to be discovered.** The operating cost is almost
entirely one number: a human escalation costs ₹40, and on this split the policy escalates
**91.6%** of events. That is not a bug in the policy — it is the EV formula reaching the
right answer for these amounts. A ₹40 human is 2.7% of this split's median ₹1,484 event and
27% of a ₹148 one:

| Event amount | Events | Escalated | Cost/event |
|---|---|---|---|
| ₹250–500 | 151 | 44.4% | ₹17.75 |
| ₹500–1k | 719 | 78.4% | ₹31.38 |
| ₹1k–1.5k | 664 | 97.6% | ₹39.04 |
| ₹1.5k–2.5k | 751 | 100.0% | ₹40.00 |
| ₹2.5k+ | 757 | 100.0% | ₹40.00 |

So the dashboard's batch — synthetic amounts of ₹100–₹352, **zero** escalations, ₹28 across
300 events — and this table are the same policy at two different operating points, not a
contradiction. **The batch runner's cost row is the cheap end of the range and should not be
read as typical.** Both numbers are true; only together are they honest.

The practical consequence is a real product finding rather than a caveat: **the escalation
price is the single most important knob a merchant has.** At this operating point escalation
could cost up to **₹88.33** before the system stopped paying for itself against the
incumbent — so the question "what does an agent-minute actually cost us" determines whether
this is a 2× system or a 6× one. That is also the argument for `/operator` capturing real
outcomes: those are the labels that would let the escalation decision be re-priced against
observed reality instead of a hand-set ₹40.

Generated into [`docs/RESULTS.md`](docs/RESULTS.md) by `npm run report`, including the
per-action mix and the cost table, so none of it is typed by hand.

### The batch runner, and what it is still good for

A real 300-event batch, run against a production build with real Docker Postgres, through the exact
webhook path a live Razorpay delivery would use. Two of these three rows are real measurements; one
is a model-implied projection and is now labelled as one.

| | Reclaim | Retry-everything (naive) | |
|---|---|---|---|
| Revenue at risk | ₹67,338.00 | ₹67,338.00 | real — the events' own amounts |
| Decisions | 220 retry-later, 80 payment-link, 0 escalated | 300 retry-now | **real** — what `decide()` actually chose on live database state |
| Intervention cost | ₹28.00 (80 payment links, ₹0.35 each) | ₹600.00 (300 attempts, ₹2 gateway fee each) | **real** — arithmetic on the chosen actions, no draw involved |
| *Revenue recovered (model-implied)* | *₹1,284.00* | *₹431.00* | *projection, not a measurement — see above* |

**1/20th the intervention cost is a real result** and needs no oracle: 80 payment links at ₹0.35
against 300 gateway attempts at ₹2. So is the decision distribution — that a trained,
cost-aware policy chooses `RETRY_LATER` 220 times and escalates zero times is exactly the
behaviour the EV formula is supposed to produce, observed on live state rather than argued for.

What the batch runner is *not* is an experiment about recovery, and it no longer presents itself
as one. The dashboard says the same thing in the same place the number appears.

Latency, measured with `npm run replay -- --n 50` against a production build on the
zero-credential path (embedded PGlite — the configuration a reviewer gets from `npm install &&
npm run dev`, so these numbers are reproducible rather than dependent on my network). Three
numbers, because this pipeline has three and they are not interchangeable:

| | p50 | p95 | max | what it is |
|---|---|---|---|---|
| **Ack** (T1, in-request) | 36ms | 69ms | 81ms | the webhook route's own HTTP response. The only part inside the request/response cycle, so this is the number that has to fit Razorpay's 5-second requirement — and it does, by ~70×. |
| **Decision** (worker) | 16ms | 32ms | 40ms | job pickup → action chosen, measured inside the worker and stored on every `recovery_audit` row (`decision_latency_ms`). Read back rather than timed from outside, so there is no polling error in it. |
| **End-to-end** (wall) | — | — | — | 2.2s to settle all 50 events, ~44ms/event mean. Includes queue wait and the worker's own poll interval. |

**This table used to be one row, and it was mislabelled.** It quoted the ack number under the
description "webhook received → action chosen" — but the route returns `202` *before* anything is
decided, which is the entire point of the architecture described above, so no single number could
have been both. `scripts/replay.ts`'s own docstring said "response latency" the whole time and
disagreed with the README. Now the script reports all three, each labelled for what it measures.

Latency is dominated by database round trips, not by this pipeline's logic, and the honest version
of that is: against a **remote** Supabase over a home connection the same script measures ack p50
~1.9s and decision p50 ~3.6s. Still inside Razorpay's 5s window, with much less margin than the
local number suggests. `docs/LOAD_TEST.md` has the full account and the connection-pool fix that
came out of it.

Fixed while measuring this: `npm run replay`, `worker`, `burst`, and `record-eval` never loaded
`.env` at all — `next dev`/`next start` load it, a bare `tsx` process does not. Every one of them
silently fell back to the built-in dev webhook secret and got a `400 invalid signature` from the
project's own server whenever a real `RAZORPAY_WEBHOOK_SECRET` was configured. They now run with
`--env-file-if-exists=.env`.

Language spend on that same batch: **₹0.00** — every one of the 80 `PAYMENT_LINK` drafts was served
from cache, since the batch runner's synthetic amounts cycle through the same bucketed bands across
runs and the cache keys on those bands, not the exact amount. Reported honestly rather than swapped
for a cherry-picked batch that happened to miss the cache: `tests/integration/language-live-groq.test.ts`
and `docs/EVALUATION.md`'s D7 section separately confirm a real, uncached Groq call drafts correctly
and reads the correct redacted amount.

---

## Honest limitations

The full list, with mechanisms, is [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md). The five
that would matter most to someone deciding whether to trust this:

**It is synthetic data, and the standard objections are real.** Three circularity traps were
anticipated and answered before the evaluation was built, and are checked by
`eval/test_oracle_firewall.py` and `eval/test_overlap.py` rather than argued in prose. **A
fourth was not anticipated, and this project fell into it** — the 3× batch claim that once
led this README was circular, found by tracing the number back to the code. The mechanism,
what survived it, and the measured 1.42× that replaced it are `docs/EVALUATION.md`'s
"Trap 4".

**`RETRY_NOW` and `RETRY_LATER` — the two actions the trained scorer chooses most — make no
live Razorpay call, and this was re-tested to exhaustion rather than assumed.**
`docs/adr/0010` originally blamed the absence of a tokenized mandate. So one was obtained:
a real bank e-mandate was registered on the test account through Razorpay's own
registration-link flow, producing a genuine recurring token (`method: emandate`,
`recurring: true`, ₹1,000 cap).

**It changed nothing, and that is the finding.** With that token in hand,
`POST /v1/payments/create/recurring` validates the payload in full — it walks you through
`amount`, then `currency`, then `bank` — and then, once there is nothing left to complain
about, returns `"The requested URL was not found on the server"` with `source: internal`.
Deterministic across three attempts, no payment object created, while `POST /payment_links`
returns `200` on the identical credentials. Same signature as `/payments/create/upi` and
`/payments/create/json`: the S2S payment-creation family is not provisioned for this
account, and **a mandate does not unlock it**.

So the constraint is narrower and harder than originally argued. Razorpay itself *can*
charge that mandate — Subscriptions' own dunning would, on its own schedule. What is
unavailable is *this system deciding when*, which is exactly what `RETRY_NOW` needs to be
more than a scheduled re-evaluation. A recovery engine whose retry timing is chosen by the
payment processor rather than by its own EV calculation is not the thing this project
claims to be. What these actions do instead is drive a real second decision cycle at the
+2h/+24h spacing (`schedule-followup.ts`). Full account, including the request/response
table: [`docs/adr/0010`](docs/adr/0010-retry-actions-have-no-live-gateway-call.md).

**The off-policy estimate has stated limits.** Weight clipping at 30 is a provable no-op
given the logging policy's own minimum propensity, not a variance hack. Single-step
importance weighting cannot validly evaluate a sequential policy, and three low-ESS
baselines land out of their expected bracket order on ~3,000 demo rows — flagged by their
own effective sample size rather than quoted at face value.

**Subscription-only events cannot be priced.** `subscription.pending` and
`subscription.halted` carry no amount anywhere in the body — the recurring amount lives on
the plan, not the subscription — so they are refused at ingest by name, with a `200` so a
valid delivery never gets the endpoint disabled. `subscription.charged`, which *does* carry
a payment entity, works: it was silently broken until this was tested properly, and that
story is in `docs/LIMITATIONS.md`.

**A handful of real Razorpay deliveries have reached this system, not thousands.** On D14,
real test-mode credentials and a tunnel let genuine signed deliveries through — a
`payment.failed`, then a real ₹100 payment run to completion producing `payment.authorized`
and `payment.captured`, the second correctly flipping a transaction to `'recovered'` from a
real signal. That is a handful under manual conditions, not volume. The simulator remains
what every test and CI run exercises.

**Two of the six risk signals, and two of thirteen features, remain honest defaults** rather
than live computations — `is_soft_decline`/`is_insufficient_funds` map a synthetic error
taxonomy Razorpay does not publish exhaustively, and `geoMismatch` stays `false` because no
real payload this build has seen carries a usable geography field. The other four features
and three risk signals compute for real from live database state.

## Found, and closed

Six things in this system were genuinely broken or missing and were found by running the
exit test rather than by assuming it would pass. Each is recorded with its mechanism in
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) and [`docs/INCIDENTS.md`](docs/INCIDENTS.md):

| Found | Mechanism, in one line |
|---|---|
| `subscription.charged` unprocessable | Multi-entity payload; `Object.entries(payload)[0]` picked the entity with no `amount`, so the main subscription recovery signal was rejected |
| `retry_count` could pass its own cap | A real race under concurrent processing of one transaction, reproduced against real Postgres — and the losing caller's *decision* was stale too |
| `ESCALATE_HUMAN` escalated into a void | No work item, no owner, no deadline, no way to record what the human found. Now `/operator`, and the first labels here the data generator did not draw |
| Webhook route had no rate limit of its own | Signature verification alone, with nothing stopping volumetric flooding before it runs |
| Four of six live features were defaults | `recordCustomerOutcome` was real since D3 and never once called, so every customer counter sat at zero |
| `model_evaluations` had no rows | The repository existed since D3 and was never called |

---

## The second scenario

`src/domain/scenario/b2b-receivable.ts` — a fictional B2B merchant's overdue invoices, instead of
failed card payments. **Reused, unmodified:** `decide()`, `computeEv`, `evaluateRisk`, the audit
schema, the policy simulator, the dashboard. **Configured, not rebuilt:** a different action
vocabulary (`SEND_REMINDER`, `OFFER_PAYMENT_PLAN`, `ESCALATE_COLLECTIONS`, `WRITE_OFF` in place of
the subscription actions — `WRITE_OFF` plays `DO_NOTHING`'s exact structural role), nine
receivables-specific features in place of the subscription scenario's thirteen, its own cost table,
and its own independently-trained logistic regression (own seed, own deliberately misspecified
generator, own golden-vector parity contract — `docs/RESULTS.md` reports both scenarios' metrics
side by side).

**Live now, too** (`docs/adr/0007`'s "Update — superseded"): `POST /api/b2b/invoices` runs a real
invoice event through `decide()` for real, against real database state, producing a real
`transactions` row, a real `action_attempts` intent, and a real `recovery_audit` row — not just the
policy simulator and offline training/evaluation. Not by routing a real Razorpay webhook to a second
scenario branch inside `process-event.ts` (B2B has no Razorpay-native event to route from at all —
invoices aren't a Razorpay object), but through its own separate, additive pipeline
(`src/app/b2b/process-invoice-event.ts`) that reuses `decide()`, the atomic cap-safe
`incrementRetryCount` that closed the real retry-count race on the subscription side, and the same
`webhook_events`-backed idempotency authority — while leaving `process-event.ts`, the webhook route,
and every subscription code path completely untouched.

---

## What broke

**The worst thing that broke here was a number, not a process.** The claim that led this
README — "recovers roughly 3× more than retrying everything" — was circular: both policies'
outcomes were drawn against their own chosen action's predicted probability under a shared
seed, so an argmax-EV policy could not lose. Nothing failed, no test went red, and the
careful part (common random numbers, to remove sampling noise) is exactly what made it read
as rigorous — CRN controls for noise between two samples and does nothing about both samples
being drawn from the quantity under test. It was found by tracing the number back to the code
that produces it, and the question that finds this class of defect is not "is the number
right" but **"could this comparison have come out the other way?"** The measured replacement
is 1.42×. Full mechanism in [`docs/INCIDENTS.md`](docs/INCIDENTS.md) and
`docs/EVALUATION.md`'s "Trap 4".

The rest of this section is the runtime incident that was here before, and it is still the
best example of the *other* failure mode — a guarantee that was real, tested, and quietly
bypassed.

A concurrent-duplicate-delivery test (`Promise.all` of 20 identical, correctly-signed webhook
POSTs for the same event id — the exact scenario the ingestion pipeline's idempotency guarantee
exists for) initially passed. A *separate*, later exercise — a real `kill -9` on the worker
process mid-batch, `RECLAIM_CRASH_AFTER=intent`, restart, resume — did not.

**The symptom:** the intended sequence was to start the app with the embedded poller disabled, run
a standalone worker configured to crash right after committing its intent row, post one signed
event, watch the standalone worker die, restart it, and confirm exactly one audit row. On the first
real attempt, the standalone worker never crashed at all — the event was already fully settled
before it had done anything.

**The mechanism:** the "disable the embedded worker" flag only gated the app's own *polling* loop.
The webhook route's `after()` self-kick — a separate, non-blocking drain triggered on every
accepted request, added for a snappier demo — had no flag check of its own, fired within
milliseconds of the response, and won the race against the standalone worker's 250ms poll interval
every single time. The flag's name promised "disable the embedded worker"; the code only disabled
one of two things that could act as one.

**The fix:** gate the `after()` kick on the identical flag. One `if` around the existing call, in
`app/api/webhooks/razorpay/route.ts`.

**Verified, not assumed:** re-ran the full sequence for real — a real process, a real crash, a real
restart. `tasklist` confirmed the worker process was actually gone; the audit table read zero rows
immediately after (T3 committed, T4 never ran — the crash matrix's hardest documented case); the
restarted worker sat idle until its lease genuinely expired, then reclaimed the same job and settled
it. Final count: one row, never zero, never two.

Full mechanism, plus five more real incidents found the same way — including one from this same
week, where the risk-gate fix below tripped a latent bug in the batch runner's own synthetic-customer
scheme — are in [`docs/INCIDENTS.md`](docs/INCIDENTS.md).

---

## Architecture

```
Razorpay (test mode, or the built-in simulator)
   │  payment.failed webhook, HMAC-signed
   ▼
Next.js route (app/api/webhooks/razorpay) ───────────────────────────────┐
   │ T1  Raw body → verify signature → parse → replay-window check →      │
   │     ONE transaction: insert-if-absent + enqueue (a UNIQUE            │
   │     constraint is the idempotency authority, not a lock in a         │
   │     second datastore)                                                │
   │     Responds 202 here — everything below runs off the request path   │
   ▼                                                                      │
Durable queue (Postgres, FOR UPDATE SKIP LOCKED, lease-based reclaim)     │
   ▼                                                                      │
Worker (drainOnce → processEvent)                                        │
   │ Reads: live features, real risk signals, shock-detector state        │
   │        — no transaction open                                        │
   │ T3  Intent row committed BEFORE any side effect                      │
   │ decide(): risk gate → per-action EV → argmax, entirely pure           │
   │ Executor call (payments client or dry-run, no transaction open)      │
   │ Language call (Groq or template, firewalled from the executor)       │
   │ T4  Settle: audit row + intent status + transaction status, atomic   │
   └───────────────────────────────────────────────────────────────────────┘
   ▼                                              ▲
Dashboard — batch runner (SSE), audit table    Vitest unit + property +
with the EV explorer, model page, policy       integration suite, run in
simulator, queue page, and /operator —         GitHub Actions on every push,
the escalation queue a human actually works     on both database drivers
```

**Why asynchronous.** Razorpay requires a response within 5 seconds and disables a webhook endpoint
after repeated timeouts over 24 hours. T1 is the only part of this pipeline in the request/response
cycle, and it does only fast, in-process work — verified at ack p50 36ms / p95 69ms against a
production build, with real margin against that constraint. Everything slow (the LLM, the payments
API) happens in the worker, entirely outside it. Full rationale: `docs/DECISIONS.md` entry 1.

One Next.js application. No separate microservice, no container to deploy to run it locally, no
second runtime to keep alive.

---

## Constraints held throughout

- No real customer data. Everything synthetic, generated by a committed, seeded script — a reviewer
  regenerates the exact same bytes from the seed and `npm run data:verify`/`data:verify:b2b`
  confirms it.
- No unsolicited messages to real phone numbers or email addresses. Every "sent" message in this
  repository is either a dry-run receipt or a signed, self-simulated webhook.
- Live payment credentials are refused at startup — `RAZORPAY_KEY_ID` starting with `rzp_live_`
  fails to boot. Test mode only.
- Strictly defensive. The system recommends and executes bounded, reversible recovery actions.
- Every action that could execute twice for one event is guarded by a `UNIQUE` constraint in the
  same transaction as the write, proven by a real concurrent-post test, not asserted in prose.

## Full documentation

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — the six architecture decisions BUILD_PLAN.md's own
  plan named in advance, each with what it costs.
- [`docs/adr/`](docs/adr) — longer-form records for these and several decisions the plan did not
  anticipate.
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — the day-by-day evaluation narrative: every tuning
  pass, every bug found while building the exit tests, written as it happened.
- [`docs/RESULTS.md`](docs/RESULTS.md) — generated, numbers-only.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — every limitation in full, including the ones
  since closed, each with its mechanism. The README carries only the five that matter most.
- [`docs/INCIDENTS.md`](docs/INCIDENTS.md) — every real bug found by running the actual exit test,
  not by assuming it would pass, with its mechanism and its fix.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — the exact command sequence for the demo path.
- [`docs/SETUP.md`](docs/SETUP.md) — real-credential setup for each port, which ones were
  actually exercised during this build, and how to deploy it publicly: the one environment
  variable that matters, what structurally bounds the damage a stranger can do without any
  authentication, and what genuinely remains exposed.
- [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md) — a real load test against the real Supabase
  deployment, the bottleneck it found, and the fix, with before/after numbers.
- [`docs/MODEL_COMPARISON.md`](docs/MODEL_COMPARISON.md) — logistic regression vs. gradient
  boosting, measured for real (`npm run benchmark:gbm`), not assumed.
- [`SECURITY.md`](SECURITY.md) — what is actually protected, what genuinely is not, stated
  as plainly as everything else in this list.
- [`BUILD_PLAN.md`](BUILD_PLAN.md) — the day-by-day build plan, kept current with a "YOU ARE HERE"
  status block after each milestone.
- [`SYSTEM_SPEC.md`](SYSTEM_SPEC.md) — the original product brief.

## Licence

MIT. See [`LICENSE`](LICENSE).
