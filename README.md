# Reclaim

[![CI](https://github.com/febinrenu/reclaim/actions/workflows/ci.yml/badge.svg)](https://github.com/febinrenu/reclaim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Risk-aware revenue recovery. It prices every recovery action, including doing nothing.**

Most systems in this space predict whether a payment will fail. Reclaim asks a different question:
given a payment has already failed, **is it worth spending money and risk to get it back, and if
so, how?**

Every recovery action costs something. A WhatsApp nudge costs paise, a human escalation costs an
agent's time, and chasing a customer who was never going to pay costs goodwill you cannot buy back.
Every rupee spent pursuing an unrecoverable payment is a rupee that should have gone somewhere else.
So recovery is a constrained optimisation problem rather than a retry loop, and this system is
explicitly allowed to decide that the right action is none.

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
came in at ₹274.42, oracle ₹267.01, error 2.8%. `HeadroomCaptured = (Reclaim − incumbent) /
(oracle-optimal − incumbent) = 13.6%`.

Full six-row bracket, every estimator, every confidence interval, and the honest finding that three
low-effective-sample-size baselines land out of their expected order on ~3,000 demo rows (flagged by
their own ESS rather than quoted at face value) are in `docs/RESULTS.md` and `docs/EVALUATION.md`'s
D8 section.

**B2B now has its own full bracket too** (`scripts/data_b2b/run_ope.py`, `npm run ope:b2b`) —
previously this evaluation existed only for subscription, despite B2B having identical raw
materials (oracle counterfactuals, risk-eval splits, customer records) already generated since D12.
Same estimators, same methodology, B2B's own action vocabulary and reward structure. The honest
finding there is sharper than subscription's: Reclaim's own DR estimate (₹10,628/invoice) actually
lands *below* the incumbent logging policy (₹10,978), while Reclaim's oracle-truth value
(₹12,333.69) is the second-highest of any policy tested — the estimate is unreliable specifically
because Reclaim's chosen actions diverge enough from the logged policy that its effective sample
size (188 of 3,680 rows) falls below the same trustworthiness threshold subscription's own three
flagged baselines fall under, not because the policy is actually worse. Full bracket in
`docs/RESULTS.md`.

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

**This is synthetic data, and the standard objections are real.** Three circularity traps were
anticipated and answered before the evaluation was built — "you're fitting your own generator," "you
can't identify action effects without counterfactual outcomes," and "perfect risk-gate
precision/recall means you labelled risk from the rule you're testing" — in
`docs/EVALUATION.md`'s opening section, checked by `eval/test_oracle_firewall.py` and
`eval/test_overlap.py`, not just argued in prose.

**A fourth was not anticipated, and this project fell into it.** The 3× batch claim that stood at
the top of this README was circular: the outcome was drawn against the chosen action's own predicted
probability, so an argmax-EV policy could not lose. Found by tracing the number back to the code
rather than by an objection from outside. The mechanism, what survived it, and the measured 1.42×
that replaced it are `docs/EVALUATION.md`'s "Trap 4" — and the dominance property is now asserted in
`tests/unit/naive-baseline.test.ts` so it cannot quietly come back.

**`RETRY_NOW` and `RETRY_LATER` — the two most common actions the trained scorer actually
chooses — never call any live Razorpay API.** Investigated this session, not assumed:
a direct server-to-server payment-creation call (`POST /v1/payments/create/upi`, the API that
would let a merchant backend silently re-attempt a UPI collect) returned a real `400` on this
account — that endpoint needs Razorpay's own S2S/Seamless approval, not available to a standard
test-mode account. No card network or UPI rail permits silently re-charging a customer without
either a registered recurring mandate (which this project's one-time `payment.failed` webhook
path has no token for) or a fresh customer-facing checkout — which is exactly what `PAYMENT_LINK`
already is. Full account, including what would change this, in `docs/adr/0010`. What these two
actions actually do is drive a real second decision cycle — `src/app/worker/schedule-followup.ts`
schedules a genuine future re-evaluation at the +2h/+24h spacing SYSTEM_SPEC.md §14 names,
verified live against Supabase — which is a materially smaller, more honest claim than "recovers
money automatically," and the one this project can actually stand behind.

**The off-policy value estimate has real, stated limits.** Weight clipping at 30 is a provable
no-op given the logging policy's own minimum propensity, not a variance hack. Single-step importance
weighting cannot validly evaluate a sequential policy (three low-ESS baselines' point estimates
land out of their expected bracket order on ~3,000 demo rows, flagged rather than hidden — see
Results above). The policy simulator (`/simulate`) deliberately never estimates a realized-value
number for a hypothetical policy at all — only the decision distribution and the model's own stated
EV — for exactly this reason (`docs/adr/0008`).

**Only `payment.*`-shaped events are handled correctly.** `src/domain/webhooks/envelope.ts`'s
`extractFacts` reads fields specific to a Razorpay payment entity (`id`, `amount`, `error_code`,
`card_id`, ...). A `subscription.halted` or `subscription.charged` webhook, whose primary entity is
shaped differently, would not extract the fields this pipeline actually needs — never tested against
because a subscription-shaped payload was never constructed.

**Razorpay test mode caps Payment Links at 30 per business.** `resolveExecutionMode`
(`src/ports/executor.ts`) makes every batch-replay event structurally `dry_run` regardless of which
credentials are present specifically so a 300-event demo batch can never come close to that cap —
checked directly by a truth-table unit test, not just assumed.

**A handful of real Razorpay deliveries have reached this system, not thousands.** For most of this
build, every webhook in every test and every demo batch was the payments simulator signing its own
event through the identical HMAC path a real delivery would use. On D14, real test-mode credentials
plus a Cloudflare Quick Tunnel let genuine, Razorpay-signed deliveries reach a running instance —
first a `payment.failed`, verified, decided by the real engine, landing a real `recovery_audit` row
in `dry_run` mode. Then, for real, the full loop: a real ₹100 test-mode payment
(`pay_TUT6SjUbB46C9u`) run to completion produced a real `payment.authorized` delivery followed by a
real `payment.captured` delivery — both verified, both decided, and the second one correctly flipped
`transactions.status` to `'recovered'` from a genuine Razorpay signal, not a synthetic draw. That is
a handful of deliveries under manual, one-off conditions, not volume or automated coverage — the
simulator remains what every test and CI run actually exercises. `docs/SETUP.md` has the full
account.

**Closed, four of six:** `amount_zscore`, `bank_recent_fail_rate`, `contacts_last_7d`, and
`ltv_zscore` now compute for real from live database state — a real trailing-window bank failure
rate (`0008_bank_column.sql` gave the schema somewhere to read a bank from at all), a real
contact-fatigue count from `action_attempts`, and real population z-scores (global amount, and
customer LTV) once `customers.repo.ts`'s `recordCustomerOutcome` — real since D3, never actually
called until now — started being called for real on every settled transaction. Verified against
both PGlite and the real Supabase deployment (`tests/integration/live-features.test.ts`,
`tests/integration/repositories.test.ts`). Two remain honest defaults, and stay that way
deliberately: `is_soft_decline`/`is_insufficient_funds` are `scripts/data/common.py`'s *synthetic*
error taxonomy, and Razorpay's real per-decline `error_reason` values are not published as an
exhaustive, verifiable list this project could map against honestly (BUILD_PLAN.md §2.1 C10) — see
`src/app/worker/live-features.ts`'s own docstring for the full account. Three of the four risk-gate
signals *are* computed from real transaction history (`src/app/worker/live-risk-signals.ts`); the
fourth, `geoMismatch`, stays permanently `false` because no real Razorpay payload this build has
found carries a usable billing/shipping geography field.

**A real concurrency bug found and fixed in the process, not swept under the rug.** Verifying the
above live surfaced a genuine race: `transactions.retry_count` could be pushed past the stopping
rule's own cap under concurrent processing of the same transaction — real, reproduced against the
real Supabase deployment, full account in `docs/INCIDENTS.md`. Fixed as one atomic, self-limiting
SQL statement rather than an application-level check, and proven under real concurrent load
(`Promise.all`, not a sequential loop — sequential calls cannot race), on both drivers. The counter
being capped left one thing still open — a losing caller's own *decision* was computed from the
stale, pre-race count — closed the same week: `incrementRetryCount` now tells its caller whether it
was the one that actually incremented, so a raced decision gets flagged
(`reconciliation_required = true` on both the audit row and the intent) and the customer's real
exhausted outcome still gets recorded, instead of silently presenting a retry that will never happen
as routine. Full account, including what deliberately still isn't attempted and why, in
`docs/INCIDENTS.md`'s "Update — the decision-staleness half closed too" section.

**`ESCALATE_HUMAN` escalated into a void. Closed — it now has a recipient.**
`decide()` could choose escalation, and the risk gate could *force* it, and `recovery_audit`
recorded it faithfully — and then nothing happened. `src/ports/executor.ts` has no side effect for
that action, so a decision to involve a human produced no work item, no owner, no deadline, and no
way to record what the human found. Track 03's bar asks for *"compliant escalation"*; an escalation
with no recipient is not one, and this was the largest remaining gap between what this system
decided and what it did.

`/operator` is that recipient. An escalated decision now writes a real work item inside the same T4
transaction as its own audit row, so the two commit together or not at all, and
`UNIQUE (event_id, attempt_generation)` — the same idempotency authority `recovery_audit` uses —
means a crash-and-reclaim between T3 and T4 cannot produce two work items for one decision. Each
item carries **why** a human is involved (`risk_gated` / `stopping_rule` / `economic` — kept
distinct because a possible-fraud review, a collections call, and a judgment call the model priced
and lost are three different jobs) and a **deadline** by reason (4h / 24h / 48h, a stated policy
rather than a measurement — there is no real operations team here whose response times could be
observed, and a number that looked derived would be worse than one that is plainly a choice).

Claim, release, and resolve are each **one conditional UPDATE naming the status it expects**, so two
operators pressing Claim in the same second is settled by the database rather than by a read-then-
write — the same shape `incrementRetryCount` was rewritten into after the real race in
`docs/INCIDENTS.md`. Verified live, not asserted: two concurrent claims against a running instance
returned exactly one `200` and one `409`, and resolving before claiming was refused with a `409`
rather than silently recording an outcome nobody was accountable for having looked at.

**And it closes a hole in the *evaluation*, which is the more interesting half.** Every label this
project reports against comes from its own generator — `docs/EVALUATION.md` says so directly, and
the customer-disjoint validation exists because that limitation is real. A resolved escalation is
the first label here the DGP did not draw: a human looked at a specific failed payment and reported
what happened. Resolving one writes that outcome back through `recordCustomerOutcome`
(`src/app/operator/resolve-escalation.ts`), so `prior_success_rate` and `ltv_zscore` in
`live-features.ts` start being fed by observed reality instead of a synthetic draw.

The resolution vocabulary is closed and deliberately unflattering: **`promised_to_pay` does not
count as recovery.** A promise is not a payment, and counting one as the other is exactly the
self-serving accounting this project exists to avoid — it would let the queue report money that has
not arrived. It leaves the transaction `escalated` and banks no customer outcome at all; if the
promise is kept, a real `payment.captured` webhook settles it through the normal path and is counted
once, there. Asserted directly in `tests/unit/escalation.test.ts` and
`tests/integration/escalations.test.ts`.

Still honest about what it is not: there is **no authentication**, so `assignee` is a name the
caller types, not an identity the system verified. `SECURITY.md` says that plainly rather than
leaving a reader to assume otherwise.

**The webhook route had no rate limiting of its own.** `/api/batches` and `/api/simulate` were
rate-limited; `/api/webhooks/razorpay` relied on HMAC signature verification alone, with nothing
stopping volumetric flooding of the public URL before verification even runs. Closed: the same
per-IP `checkRateLimit` helper, generous enough (300/60s) that a real burst of legitimate Razorpay
deliveries for one merchant is never at risk.

**Closed:** `model_evaluations` now has real rows, written by `npm run record-eval`
(`scripts/record-model-evaluation.ts`) against the real Supabase deployment, not a
one-time manual insert — reading nothing but the same committed JSON artifacts
(`recovery_model.json`, `risk_eval_results.json`) every other number on this page
does. One row for the recovery scorer's held-out Brier, one for the risk gate's
precision/recall/false-positive cost — `src/repositories/model-evaluations.repo.ts`'s
`recordEvaluation` had existed since D3 and was simply never called before this.

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
- [`docs/INCIDENTS.md`](docs/INCIDENTS.md) — every real bug found by running the actual exit test,
  not by assuming it would pass, with its mechanism and its fix.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — the exact command sequence for the demo path.
- [`docs/SETUP.md`](docs/SETUP.md) — real-credential setup for each port, and which ones were
  actually exercised during this build.
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
