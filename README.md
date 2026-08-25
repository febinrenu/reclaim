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
npm run eval        # Python: the synthetic-data and evaluation test suite
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

**Rejected alternatives, on the record:** gradient boosting over logistic regression (no
side-by-side comparison was ever built — see `docs/DECISIONS.md` entry 2, stated as an honest
absence, not a claim either way); isotonic regression over Platt scaling for calibration
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

### The risk gate

PR-AUC **0.2038** against a 2.93% prevalence baseline — a 7.0× lift. At the calibration-chosen
threshold: precision 24.8%, recall 38.2%. The complete cost argument: flagging nothing costs
₹2,82,494 on the demo split, flagging everything costs ₹4,30,451, and the actual operating point
costs ₹1,86,540 — genuinely the cheapest of the three, computed the same way Track 02's own bar
asks for (false-positive cost in real rupees), applied here as an internal discipline even though
this submission targets Track 03.

### One live batch, in full

A real 300-event batch, run against a production build with real Docker Postgres, through the exact
webhook path a live Razorpay delivery would use:

| | Reclaim | Retry-everything (naive) |
|---|---|---|
| Revenue at risk | ₹67,338.00 | ₹67,338.00 |
| Revenue recovered | ₹1,284.00 | ₹431.00 |
| Intervention cost | ₹28.00 (80 payment links, ₹0.35 each) | ₹600.00 (300 attempts, ₹2 gateway fee each) |
| Decisions | 220 retry-later, 80 payment-link, 0 escalated | 300 retry-now |

Recovers roughly **3× more** than retrying everything, at **1/20th the intervention cost** —
computed on the *same batch*, under the *same synthetic ground-truth draw* for both policies, so the
comparison is apples to apples rather than two different random samples.

Decision latency (webhook received → action chosen), measured with `npm run replay -- --n 50`
against a production build: **p50 10.5ms, p95 34.2ms, max 94.4ms** — comfortably inside Razorpay's
5-second response requirement, and inside this project's own 150ms target with wide margin.

Language spend on that same batch: **₹0.00** — every one of the 80 `PAYMENT_LINK` drafts was served
from cache, since the batch runner's synthetic amounts cycle through the same bucketed bands across
runs and the cache keys on those bands, not the exact amount. Reported honestly rather than swapped
for a cherry-picked batch that happened to miss the cache: `tests/integration/language-live-groq.test.ts`
and `docs/EVALUATION.md`'s D7 section separately confirm a real, uncached Groq call drafts correctly
and reads the correct redacted amount.

---

## Honest limitations

**This is synthetic data, and the standard objections are real.** Three specific circularity traps
and the concrete answer to each — "you're fitting your own generator," "you can't identify action
effects without counterfactual outcomes," and "perfect risk-gate precision/recall means you labelled
risk from the rule you're testing" — are answered in `docs/EVALUATION.md`'s opening section, checked
by `eval/test_oracle_firewall.py` and `eval/test_overlap.py`, not just argued in prose.

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

**No real Razorpay delivery has ever reached this system.** Every webhook in every test, every demo
batch, and every day's own live verification was the payments simulator signing its own event
through the identical HMAC path a real delivery would use — a real, correct test of the verification
logic, but not the same claim as a signature Razorpay itself produced. `docs/SETUP.md` states this
plainly rather than implying otherwise.

**The live decision path runs on a materially thinner feature set than the model was trained on.**
Six of the subscription scenario's thirteen features are honest defaults on the live webhook path,
not computed from real history yet — `amount_zscore`, `bank_recent_fail_rate`, `contacts_last_7d`,
`ltv_zscore`, `is_soft_decline`, `is_insufficient_funds` — documented directly in
`src/app/worker/live-features.ts`'s own docstring. Three of the four risk-gate signals *are* now
computed from real transaction history (`src/app/worker/live-risk-signals.ts`); the fourth,
`geoMismatch`, stays permanently `false` because no real Razorpay payload this build has found
carries a usable billing/shipping geography field.

**No `model_evaluations` row has ever been written to Postgres.** Every metric quoted above lives in
a committed JSON artifact (`recovery_model.json`, `ope_results.json`, `risk_eval_results.json`),
regenerable from the seed, but never inserted into the table SYSTEM_SPEC.md's own schema reserves
for exactly this purpose.

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

Not wired into the live worker, by design (`docs/adr/0007`) — exercised through the policy simulator
and offline training/evaluation only, since routing a real webhook to the right scenario needs code
outside the scenario/features/templates/seeds directories this second scenario's own commit is
scoped to touch.

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
with the EV explorer, model page,              integration suite, run in
policy simulator, queue page                   GitHub Actions on every push,
                                                on both database drivers
```

**Why asynchronous.** Razorpay requires a response within 5 seconds and disables a webhook endpoint
after repeated timeouts over 24 hours. T1 is the only part of this pipeline in the request/response
cycle, and it does only fast, in-process work — verified at p50 10.5ms / p95 34.2ms against a
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
- [`BUILD_PLAN.md`](BUILD_PLAN.md) — the day-by-day build plan, kept current with a "YOU ARE HERE"
  status block after each milestone.
- [`SYSTEM_SPEC.md`](SYSTEM_SPEC.md) — the original product brief.

## Licence

MIT. See [`LICENSE`](LICENSE).
