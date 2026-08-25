# Architecture decision records

BUILD_PLAN.md §11.2's own planned list, six entries, each shaped `Decision / Context /
Alternatives considered / Why this one / What it costs us` — that last field is what
makes an ADR credible, because every real decision has a downside, and naming it proves
the tradeoff was actually weighed rather than assumed away. Full, longer-form ADRs for
several of these (and for a few decisions BUILD_PLAN.md's own plan did not anticipate
in advance) live in `docs/adr/`; this file is the condensed, README-linkable index
BUILD_PLAN.md §11.1 point 11 asks for.

## 1. Ack-first asynchronous webhook processing

**Context.** Razorpay requires a response within 5 seconds and disables a webhook
endpoint after repeated timeouts over 24 hours. A synchronous pipeline — verify, score,
decide, execute, all before responding — risks blowing that budget the moment an
external call (the LLM, a payments API) is slow.

**Alternatives considered.** A synchronous pipeline with aggressive internal timeouts;
a synchronous pipeline with only the LLM call made async (fire-and-forget).

**Why this one.** T1 (`src/app/webhook/ingest-razorpay-event.ts`) does only signature
verification, envelope parsing, the replay-window check, and one durable
insert-then-enqueue transaction before responding `202` — every step in that path is
in-process and fast (measured p50 24–93ms, p95 37–134ms against a production build,
`docs/INCIDENTS.md`'s D6 entry), comfortably inside the 5-second budget with real
margin. The worker (`drainOnce`/`processEvent`) does everything slow — feature reads,
the LLM call, the executor call — entirely outside the request/response cycle.

**What it costs us.** A real queue (`job_queue`, `FOR UPDATE SKIP LOCKED`), a worker
loop, four separate transaction boundaries instead of one, and a documented crash
matrix (`BUILD_PLAN.md §5.6`) for every point a process can die between them. Four
distinct triggers can drain the queue (the embedded poller, a standalone worker, an
`after()` self-kick, a manual button) and a whole incident (`docs/INCIDENTS.md`'s
"crash demo's own trigger raced the crash it was supposed to show") came directly from
under-counting them.

## 2. Logistic regression, not gradient boosting

**Context.** SYSTEM_SPEC.md §10 names gradient boosting as a plausible alternative to
logistic regression for the recovery scorer, and BUILD_PLAN.md's own planned entry for
this decision explicitly asks for "the real side-by-side numbers if the ONNX comparison
gets built, and an honest 'we did not measure this' if it does not."

**Alternatives considered.** Gradient boosting (XGBoost/LightGBM), exported to ONNX for
in-process TypeScript inference.

**Why this one.** Logistic regression is exactly 25 (subscription) or 15 (B2B)
multiply-adds, human-readable as committed JSON (BUILD_PLAN.md §6.8: "a reviewer can
read the model, which no compiled blob permits"), and the entire Python-to-TypeScript
parity contract — the scaler-folding algebra, the golden-vector check to 1e-12 — is
tractable by hand. A gradient-boosted model would need either a real ONNX runtime
dependency in the request path or a much harder hand-port, for a discrimination gain
this project has not measured and therefore cannot claim.

**What it costs us — stated honestly, per the plan's own instruction.** We did not
measure this. No ONNX side-by-side comparison was built. This is not "gradient
boosting would have been worse" — it is "the comparison was never run," and the correct
statement is that absence, not an invented number in either direction.

## 3. Ports and adapters with local defaults

**Context.** SYSTEM_SPEC.md's own architecture assumes every external credential
(Supabase, Upstash, Groq, Razorpay) is present from the start, which makes a fresh
clone with no credentials unable to run at all.

**Alternatives considered.** Require every credential up front, with clear setup docs;
mock every external dependency in tests only, while still requiring real credentials to
run the app itself.

**Why this one.** Every port (`src/ports/*.ts`) has a real adapter and a local one,
selected by whether a credential is present (`src/config/capabilities.ts`) — never a
mock that only exists in tests. `git clone && npm install && npm run dev` runs the
complete decision engine, dashboard, and batch pipeline with zero configuration. See
`docs/adr/0002` for the database driver specifically.

**What it costs us.** An extra indirection layer on every external call (a port
interface, at least two adapters implementing it, and a selection function), and a
class of bug this project hit more than once: an adapter silently behaving differently
from what its name promised (the `after()`-kick race in `docs/INCIDENTS.md`, where a
flag named "disable the embedded worker" did not actually disable every trigger that
could act as one).

## 4. PGlite locally, real Postgres for anything needing concurrency — raw SQL, not Drizzle

**Context.** BUILD_PLAN.md's own planned entry for this decision reads "PGlite
locally, Supabase in production, on one Drizzle schema." Both halves of that sentence
changed before D2 finished, and this entry corrects them on the record rather than
silently rewriting BUILD_PLAN.md's own history.

**Alternatives considered.** Drizzle as the query layer, with its own migration tool;
Supabase as the only "real" driver target.

**Why this one.** `src/ports/sql.ts`'s `SqlExecutor` interface — committed before D2
started — is a thin parameterised-query executor, not an ORM surface, and Drizzle would
add a schema-DSL and a dialect-mapping layer to keep in sync with the hand-readable
`.sql` migration files SYSTEM_SPEC.md §8 wants reviewable as SQL, for a property
(one dialect, two drivers) plain SQL already has. No Supabase credentials were ever
obtained during this build, so "Supabase in production" was never exercised — the real
"production-like" target that was actually run and tested is Docker Postgres via
`node-pg`, which speaks the identical dialect a Supabase pooler URI would. Full
reasoning in `docs/adr/0001` and `docs/adr/0002`.

**What it costs us.** Every migration must avoid any Postgres feature PGlite's WASM
build does not implement, checked directly by the CI integration job running the same
suite against both drivers on every push (added 2026-08-26, closing a real gap —
see `docs/INCIDENTS.md`'s entry the same day). The claim "tested against Supabase" is
one this project cannot make; only "tested against real Postgres" is honest.

## 5. Template-first language layer with sampled model calls

**Context.** Groq's free tier is 30 requests/minute, 8,000 tokens/minute, 200,000
tokens/day. A 200–300-event demo batch drafting a customer message for every
contact-requiring decision would exhaust that budget well before the batch finishes.

**Alternatives considered.** Call the LLM for every eligible decision and accept
throttling/failures; cache aggressively with no sampling; skip the LLM entirely and
ship templates only.

**Why this one.** `src/language/language-service.ts`'s `draftNudge` chains cache →
sampling → a per-run call ceiling → a rolling-window budget guard (deliberately under
Groq's free-tier limits) → the LLM call, falling back to a hand-written template bank
at any stage, each with its own named `FallbackReason`. `draftRationale` never calls the
LLM at all — every decision gets a rationale at zero token cost, reserving the whole
budget for customer-facing copy.

**What it costs us — reported, not hidden.** Most of a large batch's nudges are
templated, not model-drafted, and `recovery_audit.llm_source` records exactly which
source produced each one, so this rate is a real, queryable number rather than an
assumed one. The amount-hallucination guardrail (never sending the exact amount to the
model, only a bucketed band) is the one place this project treats a language-layer risk
as serious enough to solve architecturally rather than just reactively.

## 6. Hand-built SVG for the signature charts, not a charting library

**Context.** The reliability curve and prediction histogram on `/model`, and the EV
explorer's component bars on `/audit`, are the two most visually load-bearing pieces of
the whole dashboard.

**Alternatives considered.** Recharts, Chart.js, D3, or a similar charting library.

**Why this one.** BUILD_PLAN.md's own risk table names "dashboard scope creep eating
D9 and D10" as a named risk, with the explicit mitigation "no charting library on the
critical path... the EV explorer is worth more than any animation." Full reasoning,
including why this also keeps the static calibration PNG and the in-app SVG reading the
exact same committed bin data rather than two independent approximations, in
`docs/adr/0006`.

**What it costs us.** Hours spent hand-computing axis positions and Wilson-interval
whiskers that a library would have handled — real time that could have gone toward
another day's scope, spent instead on a guarantee (no silent divergence between what
the chart shows and what the underlying numbers actually say) a library would not have
given for free.
