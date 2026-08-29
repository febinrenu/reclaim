# Honest limitations, in full

The README carries a short version of this list. This is the complete one, unabridged,
including the entries that describe problems since closed — kept because "we found this
by running the exit test rather than assuming it would pass" is the part of an
engineering record that is worth reading, and deleting it would make the project look
tidier than it was.

Ordered as the README orders them: what is genuinely still a limitation first, then what
was found and closed.

---

## Still limitations

**This is synthetic data, and the standard objections are real.** Three circularity traps were
anticipated and answered before the evaluation was built — "you're fitting your own generator," "you
can't identify action effects without counterfactual outcomes," and "perfect risk-gate
precision/recall means you labelled risk from the rule you're testing" — in
`docs/EVALUATION.md`'s opening section, checked by `eval/test_oracle_firewall.py` and
`eval/test_overlap.py`, not just argued in prose.

**A fourth was not anticipated, and this project fell into it.** The 3× batch claim that stood at
the top of the README was circular: the outcome was drawn against the chosen action's own predicted
probability, so an argmax-EV policy could not lose. Found by tracing the number back to the code
rather than by an objection from outside. The mechanism, what survived it, and the measured 1.42×
that replaced it are `docs/EVALUATION.md`'s "Trap 4" — and the dominance property is now asserted in
`tests/unit/naive-baseline.test.ts` so it cannot quietly come back.

**The synthetic economy's cost and rate constants were checked against published figures, and one
diverges.** `docs/CALIBRATION.md` compares the WhatsApp/SMS nudge cost, the human-escalation cost,
the naive-retry gateway-fee assumption, and the recovery base rate against real sourced numbers.
Most hold up within a defensible margin. The generator's failure-category mix does not: it gives
"soft, recoverable" declines a 55% share (`insufficient_funds` + `soft_decline` in
`ERROR_CATEGORY_WEIGHTS`) against a published 80–90% for real card failures, which means this
generator's failure population is harder to recover than a real merchant's, and the absolute rupee
figures elsewhere in this project likely understate what a real, easier failure mix would produce.
Not rebalanced after finding this — see the doc for why re-weighting one constant without
re-deriving every downstream number would just move the unverified claim rather than remove it.

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

**Update, 2026-08-28 — re-tested to exhaustion.** A real bank e-mandate was registered on
the test account, producing a genuine recurring token. The server-initiated charge still
fails: `POST /v1/payments/create/recurring` validates the payload fully and then returns
`"The requested URL was not found on the server"` (`source: internal`), deterministically,
while `POST /payment_links` returns 200 on the same credentials. The token was never the
binding constraint — S2S provisioning is, and a mandate does not unlock it. Full
request/response table in `docs/adr/0010`.

**The off-policy value estimate has real, stated limits.** Weight clipping at 30 is a provable
no-op given the logging policy's own minimum propensity, not a variance hack. Single-step importance
weighting cannot validly evaluate a sequential policy (three low-ESS baselines' point estimates
land out of their expected bracket order on ~3,000 demo rows, flagged rather than hidden — see
the Results section of `docs/RESULTS.md`). The policy simulator (`/simulate`) deliberately never estimates a realized-value
number for a hypothetical policy at all — only the decision distribution and the model's own stated
EV — for exactly this reason (`docs/adr/0008`).

**Subscription-only events are now refused by name, not by accident.** `subscription.pending` (which
BUILD_PLAN.md C13 identifies as the earlier and more actionable trigger) and `subscription.halted`
carry no amount **anywhere** in the body — the recurring amount lives on the plan, not on the
subscription — so `decide()` genuinely cannot price them. `isDecidableEnvelope` now rejects them at
ingest with a stated reason and a log line, returning **200 rather than 4xx** so Razorpay does not
retry for 24h and disable the endpoint over a valid event this system chose not to action. That
beats enqueuing a job which could only ever throw. `extractSubscriptionFacts` reads what those
entities *do* carry (`plan_id`, `paid_count`, `remaining_count`, `auth_attempts`, `charge_at`), so
acting on them later needs only an amount source — a plan lookup, or this project's own history for
a subscription it has already seen charged. That is the honest remaining gap, and it is now a
narrow one.

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

---

## Found, and closed

Each of these was a real limitation of this system at some point during the build. Each
was found by running the thing rather than by reasoning about it, and each is recorded
with its mechanism rather than just its resolution.
**`subscription.charged` was silently broken, and it is the one subscription event that
mattered most.** This limitation used to read "only `payment.*`-shaped events are handled
correctly… never tested against because a subscription-shaped payload was never constructed."
Constructing one found a real bug rather than the expected gap.

A `subscription.charged` delivery carries `contains: ["subscription", "payment"]` and a `payload`
with **both** keys — `subscription` first. `extractPrimaryEntity` took
`Object.entries(payload)[0]`, so it picked the subscription entity, which has no `amount` field at
all, and the worker rejected the event as *"missing id or amount"*. Since `statusFromEvent` maps
`.charged` to `'recovered'`, **the signal that a failing subscription had recovered was
unprocessable** — and the choice depended on JSON key ordering, which no webhook sender guarantees.

Fixed: when a payload carries more than one entity, the payment entity wins, because it is the one
holding `amount`, `error_code`, `bank`, and `card_id` — everything `decide()` needs to price an
action. Verified end to end against a real-shaped payload: the transaction now resolves against
the payment entity's id and amount, lands `'recovered'`, and banks the recovery against the
customer's real history. Order-independence is asserted in both directions.

**A real concurrency bug found and fixed in the process, not swept under the rug.** Verifying the
the live features surfaced a genuine race: `transactions.retry_count` could be pushed past the stopping
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
(`recovery_model.json`, `risk_eval_results.json`) every other number in
`docs/RESULTS.md` does. One row for the recovery scorer's held-out Brier, one for the risk gate's
precision/recall/false-positive cost — `src/repositories/model-evaluations.repo.ts`'s
`recordEvaluation` had existed since D3 and was simply never called before this.
