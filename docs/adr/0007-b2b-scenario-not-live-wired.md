# ADR 0007 — The B2B receivables scenario is not wired into the live worker

**Status:** Accepted. **Date:** 2026-08-26 (D12).

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
