# ADR 0007 — The B2B receivables scenario is not wired into the live worker

**Status:** Superseded 2026-08-27 — see "Update — superseded" below. Accepted
originally for the reasons below, which held for the scoped D12 exit test they
were written against; a later, explicit instruction to close live gaps
wherever genuinely possible changed the calculus.

**Date:** 2026-08-26 (D12).

## Context

SYSTEM_SPEC.md §16 asks for a second scenario proving the engine generalizes, framed
explicitly as "genuinely a half a day to a day of work once §4–§14 exist, because
you're instantiating an architecture, not building a second one." BUILD_PLAN.md's D12
exit test adds a specific constraint: `git diff --stat` for the scenario work must show
no file touched outside the scenario/features/risk/templates/seeds directories.

## Decision

`src/domain/scenario/b2b-receivable.ts` and its trained model are built, tested
(parity-checked golden vectors, a `decide()` smoke-test suite), and exercised through
the policy simulator and offline training/evaluation only. `process-event.ts`,
`container.ts`, the webhook route, and `template-engine.ts`'s template-bank selection
are not touched, and B2B's own copy banks
(`src/language/templates/reminder-en.ts`) are committed but not wired into that
selection function.

## Rationale

Wiring a second scenario into the live worker requires the worker to pick a scenario
per incoming event — from the `transactions.scenario` column, from the webhook
envelope's own shape, or from a route parameter — and that selection logic is
inescapably outside the scenario/features/risk/templates/seeds directories the exit
test scopes this work to. Attempting it risks turning "prove the engine generalizes
with a clean diff" into "quietly grow `process-event.ts` a second scenario branch,"
which is the same kind of scope creep BUILD_PLAN.md's own risk table names for the
dashboard (`docs/adr/0006`'s rationale quotes it) — applied here to the decision
engine instead. The
half-a-day framing in SYSTEM_SPEC.md §16 is about proving `decide()`/`computeEv`/
`evaluateRisk`/the audit schema generalize — a claim the simulator and the test suite
both prove without live wiring — not about a second production traffic path, which
was never part of the stated exit test.

## Consequence

A B2B webhook cannot be posted to `/api/webhooks/razorpay` and produce a B2B decision
today; there is no route that would route it there. The genuine cost: B2B's copy banks
are dead code by the normal definition (nothing imports them outside their own test),
flagged honestly in `docs/EVALUATION.md`'s D12 section rather than silently left
unmentioned. Wiring a scenario selector into the live path — and the routing decision
that goes with it — is explicitly open, not forgotten, should a future day need it.

## Update — superseded

The original rationale's core claim — that a scenario selector belongs inside
`process-event.ts`/the webhook route, and that touching those risks scope creep — turns
out not to be forced. B2B has no external event source at all: Razorpay has no
invoice-overdue webhook, so `process-event.ts`'s own `payment.failed`/`payment.captured`
routing was never the right place for B2B traffic to arrive through in the first place.
That reframing is what actually unblocks live wiring without the feared scope creep:
`POST /api/b2b/invoices` (`src/app/b2b/process-invoice-event.ts`) is a **new, separate**
route and pipeline, not a branch grown inside the subscription one.
`process-event.ts`, the webhook route, and `container.ts`'s subscription wiring are
untouched by this change — verified by running the full existing test suite (476 tests,
including every subscription-path integration test) unchanged and green before and
after.

What genuinely is real, live, and reachable now, closing this ADR's own "Consequence"
section:

- A real HTTP POST produces a real `decide()` call over `B2B_RECEIVABLE_SCENARIO`, a real
  `transactions` row (`scenario = 'b2b_receivable'`), a real `action_attempts` intent, and
  a real `recovery_audit` row — not just the offline simulator and training scripts.
- `reminder-en.ts`'s two copy banks (`SEND_REMINDER_EN`/`OFFER_PAYMENT_PLAN_EN`) are wired
  into `template-engine.ts`'s `NUDGE_BANKS`, closing the "dead code" gap that file's own
  docstring named directly. `language-service.ts`'s `DraftNudgeInput.action` type widened
  to include them — a real, deliberate, additive change to shared language-layer
  machinery, exactly the kind of touch the original ADR avoided for the narrower D12 exit
  test, made now that the goal is genuinely closing the gap rather than a clean diff.
- Live database state (`transactions`, `customers`, `action_attempts`) feeds a genuinely
  computed 9-feature vector and 4-field risk signal
  (`src/app/worker/b2b-live-features.ts`), reusing `transactions.repo.ts`'s amount-stats
  and risk-identity queries — now scoped by an added `scenario` parameter so B2B and
  subscription rows sharing one `transactions` table never pollute each other's history.
  `chase_rounds_so_far` reuses the exact same atomic, cap-safe `incrementRetryCount` that
  closed the real retry-count race on the subscription side
  (docs/INCIDENTS.md, 2026-08-27) — B2B gets that correctness property for free, not
  reimplemented.
- A real bug this live wiring surfaced and closed the same day: the language layer's
  system prompt (`generate-copy.ts`) was hardcoded to "a payment-failure scenario" and
  freely invited a `{{link}}` placeholder regardless of action — a real live B2B request
  produced a subscription-shaped message ("your recent payment did not process") with an
  unfillable link placeholder left raw in customer-facing text. Fixed by making the
  prompt scenario/action-aware and bumping `cache-key.ts`'s `TEMPLATE_VERSION` (the exact
  mechanism that field exists for) so no stale cached copy under the old prompt could
  keep being served. See docs/INCIDENTS.md for the full account.

What deliberately still is not built, stated plainly: there is no crash-recovery matrix
for this path (a single synchronous request/response, not a job the embedded worker
claims and can die mid-way through, so `process-event.ts`'s T1-T4 boundaries don't apply
the same way) — a process crash mid-request loses that one request's decision, recoverable
only by the caller retrying with the same `eventId` (idempotent via `webhook_events`, the
same authority the Razorpay path uses). `days_overdue`, and `billingAddressMismatch`
(the B2B reinterpretation of `geoMismatch`), are caller-supplied facts, not computed —
this project has no invoice-ledger schema of its own, so a real accounts-receivable
system's own data is asked for explicitly rather than invented, the same honesty already
applied to `geoMismatch` staying `false` on the subscription side.
