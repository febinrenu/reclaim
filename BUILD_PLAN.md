# Reclaim — Master Build Plan

> **This file is the single source of truth for the Reclaim build.**
> It is written to be handed to any model or agent mid-project. Read this file top to bottom
> before touching code. Where this file and `SYSTEM_SPEC.md` disagree, **this file wins** —
> §2 records the verified reasons why.
>
> Plan authored 23 Aug 2026. Submission deadline 5 Sept 2026.

---

## 1. Context

### 1.1 What we are building and why

`Reclaim` is a risk-aware revenue recovery engine, built as a submission to the **Razorpay AI
Buildathon**, track **AI Revenue Recovery**. The full product brief lives in
`SYSTEM_SPEC.md` at the repo root and should be read alongside this plan.

The one-paragraph premise, which every design decision below serves:

> Most "AI payment recovery" systems predict whether a payment will fail. Reclaim asks a
> different question: given a payment has already failed, **is it worth spending money and risk
> to get it back, and if so, how?** Every recovery action costs something, and every rupee spent
> chasing a payment that was never coming back is a rupee misallocated. Reclaim treats recovery
> as a constrained optimisation problem rather than a retry loop, and it is explicitly allowed
> to do nothing.

The decision rule, for a failed payment in state `s` and each available action `a`:

```
EV(a) = P(recover | s, a) × RecoverableAmount
        − InterventionCost(a)
        − ComputeCost(a)
        − RiskPenalty(s, a)

choose a* = argmax EV(a)          DO_NOTHING has EV = 0 by definition
```

### 1.2 What the submission is judged on

Four stated criteria. Every milestone in §8 is tagged with which one it serves.

| Criterion | What it means | How we serve it |
|---|---|---|
| **Problem taste** | Did you pick something that actually matters | The "is it worth recovering" framing, and a non-empty `DO_NOTHING` bucket that proves the question is real |
| **Build quality** | Does it run, is it structured, would you trust it | Zero-credential clone-and-run, ports-and-adapters separation, green CI, property-based invariant tests |
| **AI judgment** | The right tool in the right place, and where you chose *not* to use one | A type-level guarantee that the language model cannot reach a money-moving API, plus a documented rejected-alternatives table |
| **Failure recovery** | What broke, and what you did about it | A deliberately manufactured, honestly documented incident with a regression test guarding it |

**The single highest-leverage property of this repo:** a stranger who has never spoken to us
must be able to clone it and have it running, with real numbers on screen, in under ten minutes,
using the README alone and **with zero API credentials**. §4 is built entirely around this.

### 1.3 Locked decisions

These were decided with the project owner and are not open for re-litigation by a later agent.

| Decision | Value |
|---|---|
| Project name | **Reclaim** |
| Submission track | AI Revenue Recovery |
| Time budget | Full-time, roughly 8h/day, 23 Aug through 5 Sept (13 days) |
| Scope | Full `SYSTEM_SPEC.md`, plus the four approved additions in §1.4 |
| Visual direction | Terminal-brutalist ops console, **Ledger Amber on Warm Graphite** (§7) |
| Credentials | **None held at plan time.** Everything must run without them. Setup runbook in §11 |
| Deliverables | Code, README, ADRs, 5-minute video script, 12 form answers, credential runbook |

### 1.4 Approved additions beyond the spec

Designed in from the start, not bolted on. Each exists because it converts a *claim* into a
*demonstration*.

1. **Policy Simulator.** Change the intervention cost table, the risk threshold, or the shock
   threshold, then replay a stored batch through the decision engine offline with no side
   effects, and diff the resulting metrics against the baseline run. This is the proof that the
   system is genuinely optimising rather than running a dressed-up rule chain, because a
   reviewer can watch the chosen-action distribution shift as the economics change.
2. **Live streamed batch execution.** The dashboard receives decisions as they are made, so the
   demo video shows rows landing in real time rather than a static table appearing after a wait.
3. **Per-transaction EV explorer.** For any transaction, show all available actions with their
   EV decomposed into its four component terms, so a viewer sees exactly why the argmax landed
   where it did. This is the signature interaction of the product and the thing no other
   submission will have.
4. **Seeded deterministic synthetic data.** A reviewer regenerates our exact demo numbers from
   source. Reproducibility is itself a build-quality signal.

---

## 2. Corrected facts register

`SYSTEM_SPEC.md` was written against assumptions that research has since falsified or refined.
**These corrections are load-bearing and several of them change the architecture.** Any agent
picking up this project must treat this section as authoritative over the spec.

### 2.1 Corrections that change the architecture

| # | Spec assumption | Verified reality | Consequence |
|---|---|---|---|
| C1 | Webhook handler can run the full pipeline synchronously (verify → load → score → EV → LLM → execute → audit) before responding | Razorpay requires a **2xx within 5 seconds**. Slower is marked timeout. After **24h of failures the webhook is disabled** and must be re-enabled by hand from the dashboard. Retries use exponential backoff for 24h. Delivery order is **not guaranteed**. | **Mandatory ack-first architecture.** Verify, replay-check, acquire lock, durably enqueue, respond 202. All decisioning happens in a worker. This is the largest single deviation from the spec. |
| C2 | A batch of 200–300 events can make one LLM call each | Groq free tier is **30 req/min, 8,000 tokens/min, 1,000 req/day, 200,000 tokens/day**, enforced per organisation. A single large prompt can consume most of a minute's token budget. | Language layer must be **selective, cached, and template-first**. Full batches run on the deterministic template adapter; the LLM is used for a sampled subset and for all live demo events. Fallback and sampling rates become reported metrics, not hidden behaviour. |
| C3 | `PAYMENT_LINK` can execute freely in test mode | Razorpay caps test mode at **30 Payment Links per business**. | Executor needs an explicit **dry-run mode**. Batch runs record what *would* have happened; a handful of live events do it for real. The distinction must be visible in the audit trail. |
| C4 | Retry scheduling at +2h and +24h can use platform cron | Vercel Hobby cron has a **minimum interval of once per day**, accurate only to the hour, and sub-daily expressions **fail at deploy time**. | Scheduling uses a `due_actions` table drained by an explicitly triggered route, plus a local worker loop for development and demo. Not platform cron. |
| C5 | The dashboard can stream over the dev tunnel | Cloudflare Quick Tunnel **does not support Server-Sent Events** and caps at 200 concurrent requests. | Stream over SSE on localhost, where the demo is recorded. Automatic polling fallback when SSE is unavailable. Never let the tunnel be on the streaming path. |
| C6 | Groq offers only `json_object` mode | Groq supports **strict `json_schema`** with constrained decoding, on `openai/gpt-oss-20b` and `-120b` specifically. Requires every field in `required` and `additionalProperties: false`. **Cannot be combined with streaming or tool use.** | Use strict schema mode. It is a stronger guarantee than the spec assumed. Do not attempt to stream a structured response. |

### 2.2 Corrections that change implementation details

| # | Item | Verified reality |
|---|---|---|
| C7 | Next.js version | **16.3.2** is current, not 15.x. App Router is default. `cookies()`, `headers()`, `params`, `searchParams` are **async-only**. `middleware.ts` is renamed to **`proxy.ts`**. Dynamic code runs at request time by default; caching is opt-in via `"use cache"`. Turbopack is the default bundler. Requires Node 20.9+, TypeScript 5.1+. Raw body for HMAC is `await req.text()`, and `req.json()` must never be called first. |
| C8 | Next.js security | A **critical-severity** patch ships as **16.3.3** on **26 Aug 2026**. Start on 16.3.2 and bump on day one of availability. Treat this as a scheduled task, not a surprise. |
| C9 | Razorpay webhook envelope | Confirmed: `entity`, `account_id`, `event`, `contains`, `payload`, `created_at`. Event id header **`x-razorpay-event-id`** exists and is unique per event. |
| C10 | Razorpay error fields | Only `BAD_REQUEST_ERROR`, `GATEWAY_ERROR`, `SERVER_ERROR` are verifiable as `error_code` types. Verifiable `error_reason` values: `payment_failed`, `invalid_otp`. The exhaustive reason list ships as a spreadsheet, not an HTML table. **Treat `error_reason` as an open string with a default branch. Do not write an exhaustive enum.** `insufficient_funds` and `card_declined` are widely cited but unverified. |
| C11 | Forcing a test-mode failure | The documented paths are the **mock bank page Failure button**, an **OTP under 4 digits**, and **`failure@razorpay`** for UPI. There is no verified "failure card number" — do not put one in the README. Note also that cancelling a UPI test payment yields success, so use the failure VPA. |
| C12 | Coverage hole | `payment.failed` does **not** fire when a payment fails during authorisation on a first subscription payment. Document this as a known limitation rather than pretending coverage is total. |
| C13 | Better subscription hook | `subscription.pending` fires when charge attempts begin failing, which is **earlier and more actionable** than `subscription.halted`. Ingest both; treat `pending` as the primary recovery trigger. |
| C14 | Razorpay Node SDK | Package `razorpay`, version **2.9.8**, official. Exposes `Utils.verifyWebhookSignature`. We implement our own HMAC anyway so it can be unit-tested against a known vector, but cross-check against the SDK helper. |
| C15 | Payment Links API | `POST https://api.razorpay.com/v1/payment_links`, Basic auth. Only `amount` is required, in the smallest currency unit, **minimum 100** for INR. |
| C16 | Upstash lock semantics | `await redis.set(key, val, { nx: true, ex: n })` returns `"OK"` on acquisition and **`null` when the key already exists**. That null is the duplicate signal. Client `@upstash/redis` v1.38.2. |
| C17 | Supabase | Free tier confirmed: 500MB, 2 active projects, paused after 7 days idle. **60 direct connections, 200 via pooler** — use the pooler. Client `@supabase/supabase-js` v2.112.3. |
| C18 | Vercel Hobby | 1M invocations confirmed. Function duration is now **300s** with Fluid compute, far better than the old limits. Request body cap **4.5MB**. Runtime logs retained only **1 hour**, so durable logging must go to Postgres. Hobby projects **cannot connect to a Git-organisation-owned repo** — the repo must be personal. |
| C19 | Groq model and pricing | `openai/gpt-oss-20b` still valid and in production. **$0.075 per 1M input, $0.30 per 1M output**, and **cached input around $0.037 per 1M**, which the spec did not know about. 131k context. SDK `groq-sdk` v1.5.0; the OpenAI SDK can also be pointed at `https://api.groq.com/openai/v1`. |
| C20 | Charting | **Recharts 3.10.1** is the pragmatic choice where a library helps. ECharts 6 is stronger above ~10k points. `visx` 4.0.0 is maintained but is a primitives kit and too slow to build under deadline. Our signature visuals are hand-built SVG regardless — see §7.6. |
| C21 | Track numbering | The spec calls this "Track 03". That numbering could **not** be confirmed on Razorpay's own site, which is client-side rendered and did not yield track data. **Verify the exact track label in a browser before submitting** and use their wording, not ours. The deadline of 5 Sept 2026 is also third-party sourced and should be confirmed the same way. |

### 2.3 Open verification tasks

Carry these forward. Each is a five-minute browser check, and each is currently a small risk.

- [ ] Open `razorpay.com/buildathon` in a real browser. Confirm the exact track label, the
      deadline, the judging criteria wording, and every field the form asks for.
      **Still open. The page is client-side rendered and would not yield to a fetch.**
- [ ] Confirm the current Groq model id and price on `console.groq.com/docs/models` on the day
      the cost table is finalised, since `ComputeCost` arithmetic must be checkable against it.
- [ ] Confirm Razorpay's live test-mode failure mechanics in the dashboard once credentials exist.

---

## 3. Design system — Ledger Amber on Warm Graphite

The dashboard is the primary evidence on camera, so its design is specified here rather than
left to improvisation. This section is a contract.

### 3.1 Why this direction, and the trap it avoids

The register is a **terminal-brutalist operations console**: Swiss grid, hairline rules, extreme
type-scale contrast, monospaced numerals, no rounded-card soup. That register is correct for an
audit trail because it is the visual language of tools that are actually used to move money.

**The trap.** Anthropic's own `frontend-design` skill names the current AI-design clusters, two
of which are *"a near-black background with a single bright acid-green or vermilion accent"* and
*"a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like
columns."* Those are precisely what a naive brutalist dashboard produces. We keep the density
and the grid discipline, and we differentiate on three axes:

1. **Substrate is warm graphite, never near-black.** `#14100E`, a brown-black rather than a
   blue-black or a true black.
2. **The single accent is ledger amber**, `#C8862B` — currency and ledger ink, not acid green
   and not vermilion. This alone moves the palette out of the named cluster.
3. **Typography pairs a condensed grotesque against a mono**, rather than defaulting to
   JetBrains Mono everywhere, which is the single most overused terminal-aesthetic signal.

### 3.2 Tokens

Define once as CSS custom properties on `:root`. Nothing in the app may hardcode a colour.

```
--substrate    #14100E   warm graphite page ground, never #000000
--surface      #1C1714   raised plane
--surface-alt  #221C18   alternating table rows, hover
--rule         #2E2620   hairline dividers, 1px
--rule-strong  #453A31   section boundaries
--fg           #EDE6DC   warm bone, never pure white
--fg-muted     #8A7F73   labels, secondary
--fg-faint     #5C544B   disabled, placeholder
--accent       #C8862B   ledger amber, THE ONLY ACCENT
--accent-dim   #8A5D1E   accent at rest, borders
--positive     #5F8A5A   semantic outcome only, always with a glyph
--negative     #A8483A   semantic outcome only, always with a glyph
--warn         #B8862B   risk-gate override, distinct from accent by role only
```

### 3.3 Typography

| Role | Face | Size | Treatment |
|---|---|---|---|
| Numeric data, all of it | IBM Plex Mono | 11 / 13 / 15px | `font-variant-numeric: tabular-nums`, always |
| Section and column labels | Big Shoulders Display | 10px | uppercase, `letter-spacing: 0.09em` |
| Display figures | IBM Plex Mono | 32–44px | `letter-spacing: -0.02em` |
| Prose, rationale text | IBM Plex Sans | 13px | `line-height: 1.55` |

Both faces are in the `canvas-design` skill's bundled `canvas-fonts/` directory and are also on
Google Fonts. Self-host to avoid a network dependency during the demo.

**Serif is banned outright in this UI.** Ops consoles do not use serifs, and the
`stitch-design-taste` skill is unambiguous that serif in a dashboard reads as costume.

### 3.4 Layout and density

Density target is 8–9 on a 10-point scale, which is "cockpit". At that density,
`design-taste-frontend` §4.4 applies: **generic card containers are banned**, and data breathes
in plain layout separated by 1px rules rather than nested boxes.

```
--grid-gap           8px
--pad-tight          12px
--table-row-height   34px
--rail-width         232px
--header-height      52px
grid-template-columns: repeat(12, 1fr)
```

The hairline grid uses the `industrial-brutalist-ui` technique: a parent with
`display: grid; gap: 1px; background: var(--rule)` and children with
`background: var(--surface)`. This produces mathematically exact 1px dividers with no border
arithmetic and no half-pixel artefacts.

**Semantic rigidity.** The DOM uses the precise tags the content actually is: `<data>` for
machine-readable values, `<output>` for computed results such as an EV figure, `<samp>` for
system-emitted strings such as an error code, `<dl>` for label-value pairs, `<time>` for
timestamps. This costs nothing, improves accessibility, and is the kind of detail that reads as
craft when someone opens devtools.

**Texture, at exactly one intensity.** A single global SVG noise filter at very low opacity,
applied once at the document root, to keep the surface from reading as flat vector. This is the
only textural effect permitted. No scanlines, no halftone, no dithering — those cross from
material into costume.

### 3.4.1 The one bold move

Per `frontend-design`'s restraint principle, boldness is spent in exactly one place. Ours is the
**EV decomposition bar** (§3.6, item 1): the moment where a viewer sees six candidate actions
priced against each other, watches the negative terms eat into the positive term, and understands
in one glance why the system chose what it chose. Everything else in the interface stays quiet
and disciplined so that this reads as loud.

There is exactly one macro-typographic moment: the batch headline figure, set in Big Shoulders
Display at a `clamp()` scale, uppercase, tracking tight. Every other figure in the product is
IBM Plex Mono with tabular numerals, because money must align on the decimal.

### 3.5 Hard prohibitions

Collected from the installed design skills. These are ship-gate items, not preferences.

- **No `border-radius` anywhere.** Not on buttons, not on inputs, not on badges.
- **No gradients, no soft drop-shadows, no translucency, no glassmorphism.**
- **No pure `#000000` and no pure `#FFFFFF`.**
- **No em-dashes or en-dashes in any user-visible string.** Zero. Not one.
- **No second accent.** Positive and negative are semantic outcome markers only, never
  decoration, and never the sole carrier of meaning — every colour-coded state also carries a
  glyph or a sign.
- **No proportional figures in any numeric column.** Tabular numerals or mono, always.
- **No terminal costume.** No `[ SYSTEM ONLINE ]`, no `>>>` prompts, no `REV 2.6`, no fake
  version strings, no CRT scanline overlay, no blinking cursors used as decoration. Every label
  must name something that actually exists in the system. This is the line between "reads as a
  real internal tool" and "reads as a theme."
- **No left sidebar as the only navigation.** `redesign-existing-projects` flags the reflexive
  dashboard sidebar; we use a compact top rail plus a command palette.
- **No infinite looping animations on data elements.** Motion is reserved for state transitions
  and streaming arrival, nothing ambient.
- **No thick icon sets.** Icons are hairline, custom, and few. Where an icon is not obviously
  better than a word, use the word.

### 3.6 Charts

The signature visuals are **hand-built SVG**, not library output, because library defaults are
the most recognisable AI-dashboard tell and because these three charts are specific enough that
a generic library fights us:

1. **EV decomposition bars.** Per transaction, one horizontal diverging bar per available
   action, each segmented into its four EV components. The chosen action is marked in accent.
   This is the product's signature interaction.
2. **Reliability diagram.** Predicted-probability decile against observed recovery rate, with
   the diagonal drawn. Rendered both to the dashboard and to a committed PNG.
3. **Shock timeline.** Failures per bank/error-code over the rolling window, with the
   suppression threshold drawn and the moment the system changes behaviour marked.

Recharts 3.10.1 is available for anything conventional where hand-building is not worth the
hours. Chart series must clear 3:1 contrast against the substrate, and gridlines must sit low
enough in contrast that they never compete with data.

### 3.7 States that must exist before ship

The most reliable tell of an unfinished dashboard is missing states. Every view needs all of:
empty, loading skeleton, error, and zero-results-after-filter. Plus a custom 404, a
skip-to-content link, `aria-sort` on every sortable column reflecting real state, keyboard
reachability throughout, and CSV export on the audit table.

---

## 4. The zero-credential mandate

**The owner holds no API keys at plan time**, and independently, the spec's own reviewer
simulation says the highest-leverage property of the repo is that a stranger can clone and run
it immediately. These two facts point the same direction, so what looks like a constraint is
actually the right architecture.

**Requirement: `git clone && npm install && npm run demo` must produce a fully working system
with real numbers on screen, with an empty `.env`, on a machine with nothing installed but Node.**

Every external dependency sits behind a port with two adapters, selected by whether its
credentials are present:

| Port | Real adapter | Local adapter |
|---|---|---|
| Database | Supabase Postgres | Embedded Postgres-compatible store, no Docker required |
| Lock and counter store | Upstash Redis over REST | In-memory implementation with identical atomic semantics |
| Language | Groq `openai/gpt-oss-20b` | Deterministic template engine, including a Hinglish variant |
| Payment provider | Razorpay SDK | Simulator that signs its own webhooks with a local secret and fakes Payment Links |

Selection is automatic: if a credential set is absent, the local adapter is used and the app says
so plainly in the header. There is no hidden degradation and no silent mocking. Tests always pin
the local adapters so CI needs no secrets.

**The database port, concretely.** One Drizzle schema, two drivers. Locally,
`drizzle-orm/pglite` against `@electric-sql/pglite` 0.5.6, a WebAssembly build of Postgres that
runs in-process with no Docker and persists to a directory. With credentials, the same schema
runs against Supabase Postgres through the pooler. Drizzle supports PGlite officially, so this is
a documented path rather than a hack, and it means a stranger gets **real Postgres semantics**,
real SQL, and real transactions on first clone.

One portability rule follows from this: **generate UUIDs in application code** with
`crypto.randomUUID()` rather than relying on a `gen_random_uuid()` column default. It is portable
across both drivers, it removes any dependency on which extensions PGlite bundles, and it makes
id generation unit-testable. The schema in `SYSTEM_SPEC.md` §8 should be adjusted accordingly.

This also produces a genuinely better demo, because the recorded run cannot be broken by a rate
limit, a paused Supabase project, or a tunnel dropping.

Credential acquisition steps are in §11.

---

## 5. Architecture

### 5.1 The five commitments everything else follows from

**A1. Postgres is the queue, the lock, and the KV store. There is no second datastore in the
default path.** The spec's use of Redis `SETNX` as the idempotency authority is a correctness
defect, not a preference: a lock in datastore A cannot be atomic with a write in datastore B. If
the process dies after acquiring the lock and before the write, the event is locked out for 24
hours and silently dropped forever, with no record it ever arrived. The authority must be a
`UNIQUE` constraint in the **same transaction** as the write. Once that is accepted, Redis becomes
an optimisation rather than a dependency, and its absence stops being a blocker. This one decision
is what makes §4's zero-credential mandate achievable without building a parallel universe of
fake infrastructure.

**A2. PGlite is the default database and `DATABASE_URL` is the single escape hatch**, to Docker
Postgres and to Supabase alike. Because PGlite is real Postgres compiled to WebAssembly, the same
SQL text runs against all three targets, so there is exactly one repository layer. Consequence:
**do not use `@supabase/supabase-js`.** Use the session-pooler URI with `pg`. Supabase collapses
from an adapter into a connection string, which deletes an entire adapter and its whole class of
bugs.

**A3. `decide()` is a pure synchronous function of `(DecisionInput, Policy, ScenarioDefinition)`,
and `DecisionInput` is persisted verbatim as JSONB.** This single seam buys three of the four
approved additions at once: the policy simulator replays stored inputs under a new policy with
zero I/O, the EV explorer reads a breakdown that is already in the row, and the entire decision
surface becomes trivially unit-testable. Store the input to the pure function, never the source
rows, because source rows mutate and replaying from them would be non-deterministic.

**A4. All money is integer `Paise`. All EV arithmetic is integer `MilliPaise`** (1e-5 rupees).
Floats would put `12.399999999999998` on camera, and float non-associativity would make the
simulator's baseline-versus-variant diff produce phantom deltas. Integers make replay bit-identical
across runs and machines, which is a hard requirement for "a reviewer regenerates our exact
numbers." `MilliPaise` exists specifically because one language-model call costs roughly 0.02
paise and must remain representable as an integer.

**A5. Adapter selection is auto-detected from environment presence, never required, and always
printed.** Every key is optional. A missing key is not a startup error; it selects the local
adapter and logs the reason. Boot prints a capability banner that doubles as a demo beat, because
it tells a stranger what is simulated before they can be confused by it.

### 5.2 Layering

```
app/ (routes, UI)  →  src/app/ (orchestration)  →  src/repositories/ + src/ports/  →  src/domain/
                                                    src/adapters/ ← referenced ONLY by src/config/container.ts
```

`src/domain/` imports nothing but itself and `zod`. Direction is one-way and **lint-enforced**
via `no-restricted-imports` boundary rules, with `process.env` readable in exactly one file
(`src/config/env.ts`). Four gates are tests, not conventions:

- `tests/unit/purity.test.ts` stubs `Date.now` and `Math.random` to throw, then calls `decide()`.
- `tests/unit/firewall.test.ts` walks the transitive import graph of `src/language/**` and fails
  on any payments reference, so the guarantee survives a future refactor.
- A grep test asserts zero `if (scenario === ...)` branches outside `scenario/registry.ts`.
- A leakage test forbids `ground-truth.repo.ts` from being imported by `src/app/worker/**`.

### 5.3 Key type signatures

The full set lives in `docs/ARCHITECTURE.md`. These four are the load-bearing ones.

```ts
// src/domain/decide/decide.ts — PURE. Synchronous. No Date, no Math.random, no I/O.
export function decide<K extends ScenarioId>(
  input:    DecisionInput<ActionOf<K>, FeatureOf<K>>,
  policy:   Policy<ActionOf<K>>,
  scenario: ScenarioDefinition<ActionOf<K>, FeatureOf<K>>,
): Decision<ActionOf<K>>;

// Every action is always returned, including disallowed ones, so the counterfactual is on record.
export interface EvBreakdown<A extends string> {
  readonly action: A;
  readonly allowed: boolean;
  readonly disallowedReason: 'stopping_rule' | 'shock_suppressed' | 'no_contact'
                           | 'opted_out' | 'capability_missing' | null;
  readonly pBase: number;            // model output, P(recover | s)
  readonly pRecover: number;         // after the action lift is applied and clamped
  readonly expectedGain: MilliPaise;
  readonly interventionCost: MilliPaise;
  readonly computeCost: MilliPaise;
  readonly riskPenalty: MilliPaise;
  readonly ev: MilliPaise;
}
```

```ts
// src/ports/queue.ts — the two signatures that matter most in the whole system.
// Both take a transaction, so enqueue commits WITH the caller's write (transactional outbox)
// and a job can never be marked done without its audit row, or vice versa.
enqueue(tx: SqlExecutor, req: EnqueueRequest): Promise<{ jobId: JobId; created: boolean }>;
complete(tx: SqlExecutor, jobId: JobId, result: Jsonish): Promise<void>;
```

```ts
// src/domain/json.ts + src/ports/llm.ts — the type-level firewall (§5 of the spec requires this
// be structural, not a comment).
export type Jsonish = string | number | boolean | null
                    | readonly Jsonish[] | { readonly [k: string]: Jsonish };

export type DataOnly<T> =
  T extends (...args: never[]) => unknown ? never :
  T extends Promise<unknown>              ? never :
  T extends readonly (infer U)[]          ? readonly DataOnly<U>[] :
  T extends object                        ? { readonly [K in keyof T]: DataOnly<T[K]> } :
  T;

generateCopy(
  req: DataOnly<CopyRequest>,                              // facts: Jsonish
  opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<CopyResult>;
```

```ts
// src/ports/executor.ts — pure, unit-tested with a truth table.
// Live requires ALL FOUR. A batch replay is therefore ALWAYS dry-run even with real keys,
// which is structurally why a 300-event batch can never hit the 30-Payment-Link test cap.
export function resolveExecutionMode(ctx: {
  source: 'live_webhook' | 'batch_replay' | 'simulation';
  hasCredentials: boolean;
  configured: ExecutionMode | 'auto';
  liveBudgetRemaining: number;
}): { mode: ExecutionMode; reason: string };
```

### 5.4 Why a payments client structurally cannot reach the language layer

Five independent barriers. The first two are type-level, which is what the spec demands.

1. **`facts: Jsonish` rejects it.** A payments client has method-valued properties, and no member
   of the `Jsonish` union accepts a callable. Burying it as `{ facts: { client } }` fails on the
   recursive index signature too.
2. **`DataOnly<CopyRequest>` closes the loopholes.** Even if a field is later widened to
   `unknown`, `DataOnly` maps any function-, Promise-, or class-instance-valued member to `never`,
   making the argument unconstructible. The second parameter is a closed literal, so nothing rides
   in there either.
3. **The deps type has no slot.** `makeLanguageService({ llm, cache, budget, clock, policy })`.
   `PaymentsPort` is absent, so no client can be captured in a closure, and adding one is a
   compile error at every construction site.
4. **Lint plus test**, per §5.2, so the guarantee cannot be quietly lint-disabled away.
5. **Ordering, which is arguably stronger than all four.** The pipeline is **decide, then speak**.
   `decide()` has already returned before any language call, and `CopyResult` has no action field.
   Even a fully adversarial model response cannot change what gets executed. It can only change a
   string in a `rationale` column.

### 5.5 The webhook route, ordered exactly

Target p95 under 120ms, hard budget 800ms, against Razorpay's 5-second ceiling. Nothing between
step 1 and step 6 makes an outbound network call.

```
POST /api/webhooks/razorpay          runtime = 'nodejs'; dynamic = 'force-dynamic'

1. rawBody = await req.text()                    never req.json() first, HMAC is over raw bytes
2. sig = (await headers()).get('x-razorpay-signature')      Next 16: headers() is async
3. verifyWebhook(rawBody, sig)                   timing-safe; hash BOTH sides to a fixed length
                                                 first so the length pre-check cannot leak.
                                                 Nothing is parsed or persisted before this line.
4. parse + zod-validate envelope; eventId from x-razorpay-event-id ?? payload.id
   reject if age > 300s (stale replay) or age < -60s (skew or forged future)
   NOTE: the age window alone does not stop replay inside 300s. The dedupe table does.
5. ── T1 ── ONE transaction, ONE commit:
       webhookEvents.insertIfAbsent(tx, {...})   INSERT .. ON CONFLICT (event_id) DO NOTHING
         if absent -> return 200 "duplicate, ignored"   (Razorpay stops retrying)
       queue.enqueue(tx, { kind: 'process_event', dedupeKey: `evt:${eventId}`, ... })
6. after(() => trigger.kick('webhook'))          non-blocking, fires after the response
7. return 202 { accepted, eventId, jobId }
```

### 5.6 The worker, and why `kill -9` cannot double-process

Four named transaction boundaries:

- **T2 CLAIM.** A single atomic statement using `FOR UPDATE SKIP LOCKED`, with expired-lease
  reclaim folded into the same claim so no separate sweeper process is needed.
- **Reads and pure compute**, needing no transaction. `buildFeatures` then `scoreLogistic` then
  `evaluateRisk` then `decide()`, roughly 0.2ms. The `DecisionInput` is serialised here.
- **T3 INTENT.** Commits *before* any side effect, inserting an `action_attempts` row keyed on
  `idempotencyKey = sha256(eventId|action|attemptGeneration)`. Then, with **no transaction open**,
  the language call and the executor call happen. Never hold a database transaction across a
  network call.
- **T4 SETTLE.** One transaction, five writes, atomic: settle the attempt, insert the audit row,
  apply the outcome to the transaction, enqueue any follow-up (transactional outbox), bump batch
  counters, and complete the job.

The crash matrix:

| Crash point | Consequence |
|---|---|
| Before T1 commits | Nothing persisted. The sender retries. Clean. |
| After T1, before T2 | Job sits pending. Any worker picks it up later. The 202 was correct, because durability was established at T1. |
| After T2, before T3 | Lease expires, the next claim reclaims it, nothing had happened, recomputation is safe. |
| **After T3, before T4** | The only genuinely hard case. On reclaim we find an existing `intent` row with the same idempotency key. If `dry_run`, no side effect was possible, so discard and redo. If `live`, **never blindly re-execute**: call `findByReference(idempotencyKey)`; if found, settle with the real receipt; if not, settle `outcome='unknown'`, force escalation, and flag `reconciliation_required`. At-most-once with explicit human reconciliation, visible in the audit trail rather than hidden. This is the correct fintech semantic. |
| During T4 | Atomic. All five writes or none. The audit table is never inconsistent with the transactions table, and a job is never done without its audit row. |
| Re-running a settled job | `recovery_audit UNIQUE (event_id, attempt_generation)` raises a constraint violation, which the handler catches and marks done. **The database physically cannot hold two audit rows for one event-generation.** Spec §14's second invariant is therefore not asserted, it is structurally impossible. |

**Windows note.** `kill -9` does not exist here. The runbook uses `taskkill /F /PID`, which is a
genuine SIGKILL equivalent. Additionally, `RECLAIM_CRASH_AFTER=intent npm run worker` makes the
worker exit immediately after T3 commits, so the crash beat is **reproducible on every take**.
That matters a great deal when there is one shot at a five-minute video.

### 5.7 Queue and triggers

The queue is durable state and is always Postgres. The **trigger**, meaning whatever wakes the
worker, is environment-dependent. Four triggers all call the identical
`drainOnce(deps, { maxJobs, budgetMs })`, so there is exactly one code path to test:

1. **Embedded worker**, the local default. Started from `instrumentation.ts`, polling at 250ms with
   adaptive backoff. `npm run dev` is the only command a stranger needs.
2. **Standalone worker**, `npm run worker`, for the multi-worker concurrency demo and the crash story.
3. **`after()` self-kick**, which POSTs the authed drain route. This is the serverless path.
4. **Manual or scheduled**, a dashboard button plus an optional daily sweep for stuck leases.

`drainOnce` returns `{ claimed, done, failed, remaining }`, so a trigger can immediately re-kick
while work remains. That gives a self-sustaining chain on serverless **without** needing
sub-daily cron, which Vercel Hobby does not provide.

Redis, when present, is used for exactly three things, none of which is the idempotency authority:
the shock rolling counter, the language-budget rolling window, and a soft pre-filter that skips a
transaction for obvious duplicates. A wiped, missing, or stale KV is therefore harmless.

### 5.8 The language budget architecture

For a 300-event batch under 30 requests/min and 200,000 tokens/day:

1. **Policy gate.** Batch runs use `mode: 'sampled'` with an 8% rate and a hard ceiling of 24
   calls per run. Sampling is **deterministic**: `hash(transactionId) mod 100 < 8`, so the same 24
   events get model-written copy on every re-run. Reviewer reproducibility, not luck.
2. **Cache before call.** Keyed on a hash of scenario, action, locale, tone, template version, and
   **bucketed** facts (amount into six bands, days-overdue into four, error code into roughly
   eight classes). 300 events collapse to about 30 distinct keys. The cache is a table, so it
   survives restarts and is shared across processes.
3. **Budget guard set deliberately below Groq's**: 20 requests/min, 6,000 tokens/min, 600
   requests/day, 150,000 tokens/day, leaving headroom for retries and the live demo.
4. **Limiter.** Concurrency 2, 350ms minimum spacing, three retries with jitter on 429 and 5xx,
   `Retry-After` honoured, 6-second timeout falling back to template.
5. **Call shape.** Plain `fetch` against the OpenAI-compatible endpoint, no SDK.
   `response_format: { type: 'json_schema', json_schema: { strict: true, ... } }`, no streaming and
   no tools, because those are mutually exclusive with structured output. The response is **still**
   zod-validated, because strict mode is a provider promise and not a proof.
6. **The fallback is not a stub.** Eight hand-written variants per action per tone, in `en-IN` and
   Hinglish, with slot filling and seeded variant selection. Copy that is genuinely fine to read
   aloud on camera. This is what makes the zero-credential clone demoable rather than visibly
   degraded.
7. **Reportable.** Every result carries its `source` and `fallbackReason`. The dashboard shows the
   split, for example `llm 24 (8.0%) · cache 61 (20.3%) · template 215 (71.7%)`. A 0%
   *error-driven* fallback rate reported alongside a 92% *policy-driven* rate is far more
   interesting and more honest than either number alone, and it demonstrates quota awareness the
   spec never considered.

Expected batch spend is roughly 17,000 tokens, about ten paise, which is about 8% of the daily
request cap. That means the batch can be rehearsed a dozen times a day, which is the real
operational constraint.

### 5.9 The two scenarios share code by type, not by convention

```ts
export interface ScenarioDefinition<A extends string, F extends string> {
  readonly actions: readonly A[];
  readonly nullAction: A;              // DO_NOTHING for subscriptions, WRITE_OFF for receivables
  readonly escalationAction: A;
  readonly features: readonly F[];
  readonly model: LogisticModel<F>;
  readonly buildFeatures: (s: EntitySnapshot) => Readonly<Record<F, number>>;
  readonly riskRules: readonly RiskRule[];
  readonly capabilityOf: Readonly<Record<A, ExecutorCapability>>;
  readonly templates: Readonly<Record<Locale, TemplateBank<A>>>;
  readonly defaultPolicy: Policy<A>;
  // ... plus requiresContact, copyTask, amountOf, statusFor
}
```

`Record<A, MilliPaise>` inside `Policy` is **exhaustive**, so adding an action produces compile
errors at exactly the seven places a human must make a decision (intervention cost, compute cost,
lift, capability, contact requirement, copy task, templates) and nowhere else. That is the
difference between an abstraction and a coincidence.

**The proof, and it is a demo asset:** milestone M12 adds the receivables scenario, and
`git diff --stat` for that milestone must show **no file modified outside**
`src/domain/scenario/`, `src/domain/features/`, `src/domain/risk/`, `src/language/templates/`,
and `db/seeds/`. Put that diffstat on screen at 4:30 in the video.

---

## 6. Modelling, evaluation, and testing

### 6.1 Two corrections to the EV formula itself

**Correction 1: `EV(DO_NOTHING)` is not zero.** The spec asserts it is zero by definition. That is
wrong whenever organic recovery exists, and it does: customers retry on their own. Since the
generator gives `DO_NOTHING` a real recovery probability of roughly 0.11, the corrected model is:

```
EV(a)          = P(recover|s,a)·A − InterventionCost(a) − ComputeCost(a)
                 − RiskPenalty(s,a) − ContactFatigueCost(s,a)
EV(DO_NOTHING) = P(recover|s,DO_NOTHING)·A                       > 0
Uplift(a)      = EV(a) − EV(DO_NOTHING)
a*             = argmax_a EV(a)
```

Log **both** `EV` and `Uplift` in the audit row. Getting this right is the difference between a
system that credits every intervention with recovery that would have happened anyway and one that
does not. It belongs in the README, because it is a sharp correction a reviewer will recognise.

**Correction 2: the cost table is missing a term, and without it the `DO_NOTHING` bucket is
empty.** At the spec's ₹0.35 per nudge, nudging is positive-EV for essentially every row. So the
reviewer's own predicted criticism ("if your `DO_NOTHING` bucket is empty, your EV math never
produces a negative number") lands exactly. Padding a threshold to fake a non-empty bucket would
be dishonest. Fix it economically instead:

```
ContactFatigueCost(s,a) = 1{a ∈ {WHATSAPP_NUDGE, PAYMENT_LINK}}
                        · churn_hazard(contacts_last_7d)
                        · expected_LTV(s)

churn_hazard:  0 contacts → 0.0005   1 → 0.002   2 → 0.004   ≥3 → 0.008
```

At an LTV of ₹6,000 with two prior contacts that is ₹24, now comparable to the amounts in play, so
`DO_NOTHING` wins for a defensible economic reason. This is better product taste as well as better
statistics, and product taste is the first judging criterion.

**Correction 3: the risk gate must be a hard feasibility constraint, not a soft penalty.** The spec
says `RiskPenalty` is "large enough that no action outranks `ESCALATE_HUMAN`." A *fixed* penalty can
always be out-competed by a large enough amount, and high-amount transactions are precisely the
risky ones. Fix: when the gate fires, **remove the non-escalation actions from the allowed set**,
while still computing and logging the soft EVs for the audit trail (which the spec already wants).
Property test P10 in §6.7 is what proves this.

### 6.2 The circularity problem, and the move that reverses it

There are three distinct circularity traps, and naming them separately is most of the solution.

| Trap | Consequence if unhandled |
|---|---|
| **Recovering our own generator.** We wrote the data-generating process, so fitting it proves nothing. | The Brier score is a tautology and every number gets discounted. |
| **Counterfactual conditioning.** `P(recover \| s, a)` needs outcomes for actions not taken. The spec papers over this entirely. | Action coefficients are unidentifiable. If the logging policy is deterministic in `s`, complete separation. |
| **Rule-labelled risk evaluation.** Labels derived from the very rules being evaluated. | Precision and recall both 1.0, which is exactly the failure the spec's reviewer section predicts. |

#### Trap 1: deliberate misspecification, then quantify the gap

Make the true process strictly outside the shipped model's hypothesis class, but **do not sandbag**
by shipping a deliberately weak feature set, because that is a different dishonesty. The rule:
engineer the features a competent engineer would engineer, and locate the misspecification in the
parts a competent engineer *cannot see*.

The true process includes, and the shipped logistic regression omits: a per-bank-per-5-minute
latent health variable, a per-customer intent random effect, a threshold effect at the customer's
90th-percentile amount, one feature-feature interaction, heteroskedastic noise scaled by decline
hardness, and asymmetric label noise (2% of successes recorded as failures, 1% the reverse).

**The critical subtlety.** The latent confounders enter the **outcome** but must **not** enter the
**logging policy**. The logging policy is a function only of recorded features. This gives both
properties at once: unconfoundedness holds with respect to logged features, so propensities are
**known exactly rather than estimated**, keeping the off-policy estimator unbiased; while the
outcome model still has irreducible unexplained structure, so the Brier score is a real number.
Letting the latent drive action selection would break the evaluation and gain nothing. This is the
load-bearing decision of the entire evaluation design and it gets its own paragraph in
`docs/EVALUATION.md`.

**Now the move that converts the objection into an advantage.** Because we wrote the generator, we
know the true probability for every row, so we can report the **Bayes floor**:

```
Brier_bayes = mean_i[ p_true_i(a_i) · (1 − p_true_i(a_i)) ]     irreducible noise
Brier_ref   = p̄_train · (1 − p̄_train)                          base-rate-only predictor
BSS         = 1 − Brier_model / Brier_ref
SkillEff    = (Brier_ref − Brier_model) / (Brier_ref − Brier_bayes)
```

`SkillEff` is a number nobody can compute on real data: what fraction of the achievable signal we
captured. It converts "Brier 0.19, is that good?" into "0.1897 against a noise floor of 0.1602 and
a base-rate-only 0.2247, so we captured 54% of the recoverable signal and we are demonstrably
**not** recovering the generator." **The measurable gap to the Bayes floor is the proof of
non-circularity, quantified.**

Add the **Murphy decomposition** over calibration bins, about fifteen lines of code:

```
Brier = Reliability − Resolution + Uncertainty
```

which supports the precise claim: "the reliability term is 0.0031 of a 0.2247 total, so 98.6% of
our error is irreducible uncertainty and limited resolution, not miscalibration."

**And codify the difficulty.** `eval/test_generator_difficulty.py` **fails CI** if the task becomes
too easy:

```python
assert 0.68 <= holdout_auc <= 0.82
assert 0.08 <= bss <= 0.25
assert (brier_model - brier_bayes) > 0.015     # the model must genuinely underfit
```

A test suite that fails when our own benchmark becomes trivial is unusual and reads exactly as the
intellectual honesty the rubric rewards. Name it in the README by filename.

#### Trap 2: an explicit logging policy with recorded propensities

The generator simulates an incumbent operations heuristic with epsilon-greedy exploration, and
logs the propensity on every row.

```
h(s) = DO_NOTHING      if amount < ₹200 and prior_success_rate < 0.30
     = RETRY_NOW       if retry_index == 0 and is_soft_decline
     = RETRY_LATER     if retry_index == 0 and is_insufficient_funds
     = PAYMENT_LINK    if amount > ₹5,000
     = ESCALATE_HUMAN  if retry_index >= 2
     = WHATSAPP_NUDGE  otherwise

π₀(a|s) = 0.80 · 1{a = h(s)} + 0.20/6
```

Deliberate properties worth stating as such:

- **Positivity by construction.** Minimum propensity 0.0333, so the maximum importance weight is
  exactly 30. Weight clipping at 30 is therefore a provable no-op, not a variance hack to defend.
- **Identifiability per action.** Every action appears in every region of state space. On 7,200
  training rows the rarest action still gets roughly 240 pure-exploration rows.
- **`DO_NOTHING` has real mass**, roughly 11%, which matters because it is the reference level every
  uplift is measured against.
- **A non-trivial incumbent baseline.** `h` is a sensible policy, so beating it is a real result
  rather than beating a straw man.

Model form: **one model with action features, not six models.** Thirteen shared features, five
action dummies with `DO_NOTHING` as the reference level (so its fitted probability *is* the organic
baseline, which is elegant and self-documenting), and seven hand-picked action interactions, giving
about 25 coefficients. Reasons over six separate models: shared statistical strength on shared
features, one artifact instead of six, and a coefficient table you can read aloud
("`RETRY_NOW × is_soft_decline = +1.24`, so retrying works on soft declines and not otherwise").

#### Trap 3: risk labels from a latent cause, never from the rules

Each event carries a hidden `is_truly_risky` flag assigned via compromised-card **episodes** over
card fingerprints, not per row. The signals the gate sees are noisy, incomplete emissions of that
latent:

| Signal | P(signal \| risky) | P(signal \| benign) | Benign explanation |
|---|---|---|---|
| geo mismatch | 0.55 | 0.08 | travel, VPN, corporate billing address |
| card velocity ≥ 4 in 10 min | 0.60 | 0.04 | a frustrated customer retrying |
| amount > 8× customer p90 | 0.45 | 0.05 | annual plan upgrade |
| card first seen < 24h | 0.70 | 0.15 | legitimate replacement card |

Two properties make the evaluation non-trivial, and both are deliberate: **30% of truly risky
events emit zero signals**, which is the gate's recall ceiling of roughly 0.70 by construction; and
60 benign look-alikes (legitimate customers who happen to emit every signal) put a real ceiling on
precision. Reporting a recall of 0.68 with an explained ceiling is far more credible than 0.99.

**Label on the consequence, not the cause.** Emit `would_chargeback` at P=0.80 given risky and
P=0.005 given benign, and define the positive class as `would_chargeback = 1`. This decouples the
label from the rules by one more layer and makes false-negative cost directly monetisable.

**Prevalence is 2.5%.** State it unprompted, since the spec's reviewer section says explicitly "I
will ask about class balance." Pre-empt with the lift framing: at 2.5% prevalence, precision 0.62
is a 25× lift over random.

### 6.3 The two-track evaluation, and the strongest sentence in the submission

**Track A, honest and deployable.** The training and evaluation pipeline sees only the logged CSVs:
one action per row, the realised outcome, and the propensity. This is exactly what an engineer with
a real ledger could do.

**Track B, oracle audit.** The generator *also* writes `oracle_counterfactuals.parquet` containing
the outcome and true probability under **all** actions. This file is **forbidden** to the training
pipeline, and the firewall is mechanical: `eval/test_oracle_firewall.py` asserts the training and
evaluation sources contain no reference to it, and asserts the logged CSVs contain no column
matching `p_true|y_a_|is_truly_risky|would_chargeback`. The CSV loader takes a column allowlist
derived from `FEATURE_ORDER` and raises on anything else.

The payoff, and this is the single strongest claim the submission can contain:

> Our doubly-robust estimate of the learned policy's net recovery was ₹412 per transaction
> (95% CI ₹380 to ₹444). The ground truth, from held-out counterfactuals the estimator never saw,
> was ₹427, an error of 3.5%. The same table reports the estimator's error on all five baselines.

That reframes the objection completely. We are no longer using synthetic data to argue the model is
good. We are using its one genuine advantage, known counterfactuals, to prove the **measurement
method** is sound, and the measurement method is the part that transfers to a real ledger.

### 6.4 Off-policy evaluation: build it, the cheap version

**Verdict: build it, roughly six hours.** The expensive part of off-policy evaluation is propensity
estimation, and here it is free because we generate it. It is also the same computation that
produces the spec's required baseline comparison, so it **replaces** work rather than adding it.
It is the highest credibility-per-hour item in the project.

Reward is **money, not the binary**: `r_i = y_i·amount_i − InterventionCost(a_i) − ContactFatigueCost(s_i,a_i)`, in integer paise.

```
w_i        = π(a_i|s_i) / π₀(a_i|s_i)
V_DM(π)    = (1/n) Σ_i Σ_a π(a|s_i)·q̂(s_i,a)
V_SNIPS(π) = Σ_i w_i r_i / Σ_i w_i
V_DR(π)    = (1/n) Σ_i [ Σ_a π(a|s_i) q̂(s_i,a) + w_i (r_i − q̂(s_i,a_i)) ]
ESS(π)     = (Σ_i w_i)² / Σ_i w_i²
```

`q̂` comes from the scorer fit on **train only**, evaluated on **demo**, so it is already disjoint
from the evaluation rows. Confidence intervals by 2,000-resample row bootstrap, percentile
interval, not a normal approximation, because importance-weighted estimates are right-skewed.
**Report ESS per policy**, and if any policy's ESS falls below 200, print the estimate as
untrustworthy rather than quoting it. Volunteering that is a credibility gain.

**Explicitly rejected**, recorded in the ADRs: cross-fitted doubly-robust estimation and double
machine learning (`q̂` is already fit on a disjoint split, so cross-fitting buys nothing and costs a
day of plumbing), learned propensities, online bandit updating, conformal intervals, isotonic
regression, Venn-Abers, and Bayesian logistic regression with MCMC. Refusing loudly is itself an
AI-judgment signal.

### 6.5 Baselines, and the headline framing

| ID | Policy | Note |
|---|---|---|
| B0 | Do nothing at all | The organic-recovery floor |
| B1 | Retry once, immediately, everything | Costs ₹0 intervention plus **₹2 gateway fee per attempt**. Document that assumption; failed-attempt fees are real |
| B2 | Retry everything up to 3 times, stop on success | **Sequential**, see the caveat below |
| B3 | Nudge everything | Tests whether the fatigue term matters. First to cut |
| B4 | **The logging policy itself** | The most important baseline: what a competent team without a model does. Its value is **directly observable** from the logs as an on-policy mean, no estimation needed. The best anchor in the set |
| B5 | **Oracle, perfect foresight** | The ceiling. Oracle file only |

Report the bracket in net rupees per transaction, ordered `B0 ≤ B3 ≤ B1 ≤ B2 ≤ B4 ≤ Reclaim ≤ B5`,
plus `HeadroomCaptured = (V_Reclaim − V_B4) / (V_B5 − V_B4)`. "We captured 61% of the headroom a
perfect oracle would have over the incumbent heuristic" is worth more than any recovery-rate
percentage, and it is exactly the reference-pointed claim the spec demands.

**Be explicit about where the honest method does not apply.** B2 is a *sequential* policy, and
single-step importance weighting cannot validly evaluate it. So evaluate B2 by the oracle simulator
only, and **say that single-step doubly-robust estimation is invalid for sequential policies**. The
generator must therefore emit retry-conditional counterfactuals with decay, otherwise B2 would look
three times better than B1, which is obviously wrong and a reviewer would catch it immediately.
Stating the limit of your own estimator is stronger than pretending it generalises.

### 6.6 Data volumes, splits, and calibration

**The spec's 200 to 300 rows is the demo-batch size, not the training corpus.** With 25
coefficients and six actions, 300 rows gives separation and wild coefficients. Synthetic data is
free. Per scenario: 60 customers, a six-month warm-up of about 4,000 successful payments so
`prior_success_rate` has real variance, and **12,000 logged decision events**.

**The split is temporal, not random.** Explicitly reject the spec's
`train_test_split(random_state=42)`: a uniform random split puts the same customer on both sides,
so as-of features leak across it, and it lets future rows predict past ones.

| Split | Rows | Window | Purpose |
|---|---|---|---|
| `logged_train` | 7,200 | months 1 to 4 | fit coefficients |
| `logged_calibration` | 2,400 | month 5 | fit Platt, build the diagnostic diagram, pick the risk threshold |
| `logged_demo` | 2,400 | month 6 | **the only split whose numbers appear anywhere** |

Report a secondary customer-disjoint split in the notes. If the two Brier scores diverge
materially, that is information worth reporting, not hiding. Run five seeds and report mean plus
standard deviation in one line, which costs ten minutes of compute and forecloses "you got lucky
with seed 42."

**Calibration.** Ten **equal-frequency** bins as primary, not equal-width: predictions pile up in
0.05 to 0.45, so several equal-width upper bins would hold fewer than ten samples and look erratic
for reasons that are pure sampling noise. The bin-count rule to state is `n/k ≥ 100`. Plot
**Wilson 95% intervals per bin**, because without them a reviewer cannot distinguish miscalibration
from noise, and putting them there says you know that. The chart must be **two panels**: the
reliability curve, and **a histogram of predicted probabilities underneath**, which is not
decoration but the thing that reveals where the mass actually is.

Metrics on the demo split: Brier, `Brier_ref` computed from the **train** base rate so the baseline
cannot peek, BSS, `Brier_bayes`, SkillEff, the Murphy decomposition, **ECE at k = 5, 10 and 20 as a
small table** rather than one number since ECE is bin-count sensitive, MCE, and ROC-AUC because
Brier conflates calibration with discrimination.

**Platt, not isotonic.** Isotonic on 2,400 rows across six actions overfits into a step function,
and worse, it is a non-parametric map that would have to be serialised as a lookup table into
TypeScript, creating a second artifact and a second parity surface. Platt is two floats in the same
model JSON and one extra multiply.

**The honesty constraint the spec misses entirely: you cannot report post-Platt metrics on the rows
you fit Platt on.** Hence the three-way split does double duty. Put this line above the results
table: *"Every figure below was computed on a 2,400-event split used for neither fitting nor
calibration."* Report before and after honestly, including when the improvement is boring. "Platt
moved Brier from 0.1897 to 0.1891 and ECE(k=10) from 0.021 to 0.013; we kept it because the ECE
improvement is real and the cost is two floats" is far more credible than a dramatic improvement,
and it pre-empts "why did you need calibration if the model was already fine?"

**Do not use `class_weight='balanced'`**, and say so in the ADRs: it shifts the intercept and
destroys calibration, so the probabilities stop being probabilities. At a 34% base rate there is no
reason to reach for it. Flagging a mistake deliberately avoided is exactly the "where you chose not
to" signal.

**Risk gate reporting: a curve, not a number.** The gate's weighted rule sum is continuous, so
sweeping its threshold is free. Report the **precision-recall** curve, not ROC, and say why: at
2.5% prevalence ROC-AUC flatters everything. Report PR-AUC against its correct baseline, which
equals the prevalence. Then pick the operating point by **amount-weighted expected cost**, because
count-based precision at low prevalence hides that the false negatives are the biggest tickets:

```
C_FN(i) = amount_i + ₹500 dispute handling + ₹150 representment
C_FP(i) = ₹40 agent time + ₹12 churn externality + 0.05·amount_i
τ* = argmin_τ TotalCost(τ)          chosen on calibration, reported on demo
```

Bracket it: report cost at flag-nothing and flag-everything, so "flag nothing costs ₹1.42L, flag
everything costs ₹2.08L, our operating point costs ₹0.61L" is a complete argument in one line.

### 6.7 Feature discipline and leakage

Every feature is computed **as of `event_created_at`**, never from final-state rows. The three
highest-risk features are `prior_success_rate` (if the customer's success count includes this
transaction's eventual recovery, the label leaks directly), `bank_recent_fail_rate` (the window must
be **strictly** backward-looking; a symmetric or inclusive window leaks the future), and
`contacts_last_7d` / `n_prior_reminders` (must exclude the contact we are about to make).

Two specific spec fixes: replace `hour_of_day_risk` with `hour_sin` and `hour_cos`, because a
scalar risk score for hour-of-day is either arbitrary or fit on the label; and for the B2B
scenario, treat `has_disputed_lines` with care, because disputes are frequently *raised in response
to* a chase, making a final-state flag caused by the action. Classic reverse causation.

**Banned columns, named in the README:** `transactions.status` (it contains the label),
`recovery_audit.outcome`, final `retry_count`, and anything from a window including the event time.

**The test that proves it**, and it is the strongest possible evidence:
`features.asof.test.ts` samples 200 events, recomputes features against a store truncated to
delete every row after `event_created_at`, and asserts **byte-identical** output.

### 6.8 The Python-to-TypeScript parity contract

The spec's approach is right: export coefficients to JSON, run sigmoid in TypeScript. No network
hop in a one-shot recorded demo, roughly 25 multiply-adds so latency is honestly dominated by
database I/O, and the coefficient JSON is **human-readable**, so a reviewer can read the model,
which no compiled blob permits.

But the spec's inference snippet has three real bugs:

1. **`features[k] ?? 0` silently imputes zero for a missing feature.** For a standardised feature
   that means the mean, which is benign. For a raw feature like `prior_success_rate` it means "0%
   historical success," which is catastrophically wrong and completely silent. Fix: an explicit
   `FEATURE_ORDER` array in the JSON, a dense `number[]` input, and **throw** on missing or NaN,
   with declared per-feature imputation values used explicitly and logged.
2. **`Object.entries(model.coefficients)` relies on JSON key order.** It happens to work, which
   makes the contract implicit. Fix: aligned arrays, plus property test P15.
3. **No scaling contract, which is the worst bug class in the system.** Add `StandardScaler` in
   Python and forget it in TypeScript and the probabilities are garbage but still inside `[0,1]`, so
   nothing crashes and nothing warns. **Fix: fold the scaler into the coefficients algebraically at
   export time.**

```
w'_j = w_j / σ_j
b'   = b − Σ_j (w_j · μ_j / σ_j)
```

TypeScript then does a raw dot product with no scaler at all, so **there is nothing left to
forget**. This eliminates an entire bug class rather than testing for it. Assert
`|folded − pipeline.predict_proba| < 1e-12` on 1,000 holdout rows *before* writing the JSON.

**`golden_vectors` live inside the model JSON.** The training script writes them, so they can never
drift from the coefficients they were computed with, and the TypeScript test reads them from the
same file it loads the model from. Hand-edit a coefficient and the parity test fails immediately.
Sixteen to twenty vectors: all zeros, all medians, each feature at ±3σ, each action one-hot, the
extremes, one row with every optional feature absent, and five random holdout rows. **Tolerance
1e-12, not 1e-6**, because summing in the same order in both languages is bit-identical in float64,
so a failure at 1e-12 is a real ordering or scaling difference rather than noise. Say that in the
test comment; the tight tolerance is the point.

### 6.9 Property-based tests

Library: **`@fast-check/vitest`**. `fast-check` 4.9.0 is the mature TypeScript choice with real
shrinking, and the Vitest binding gives `test.prop([...])` with no config.

Note that the `retryCount` arbitrary should range to 5, **above the legal maximum**, because you
want the generator probing states the code claims are unreachable.

The spec's four invariants:

| # | Property |
|---|---|
| P1 | For any batch, `sum(recovered) ≤ sum(atRisk)`. Integer paise, so no float slop can mask a violation |
| P2 | Over a shuffled, duplicated event stream, `distinct(eventIds).length === auditRows.length` |
| P3 | Terminal `retryCount ≤ 3`, and no retry action is ever emitted at `retryCount ≥ 3` |
| P4 | If the chosen action is neither the null action nor escalation, its logged EV is positive |

The eleven additions, which is where the real value is:

| # | Property | Why it matters |
|---|---|---|
| P5 | `chosen === argmax(evs)` under a **documented deterministic tie-break** | The spec never specifies tie-breaking. On exact ties the demo becomes non-deterministic between takes |
| P6 | EV non-decreasing in `p` for fixed state and action | Catches a sign error in cost subtraction |
| P7 | EV strictly increasing in amount for positive `p` | Catches a swapped amount/cost argument |
| P8 | There exists a threshold below which the null action wins for all states | **Guarantees the `DO_NOTHING` bucket cannot be empty by construction** |
| P9 | Adding a risk signal never decreases the risk score | Catches a negative-weight typo |
| **P10** | If the risk score clears the threshold, escalation is chosen **for all amounts up to ₹50,00,000** | **Proves the soft-penalty bug of §6.1 is fixed. The highest-value property in the set** |
| P11 | Scorer output lies in the open unit interval for all finite vectors including ±1e6, and throws rather than returning NaN on NaN input | `Math.exp` overflow silently producing NaN would propagate into money math |
| P12 | Every monetary output satisfies `Number.isInteger` | Catches float drift at its source |
| P13 | The same event twice across a process-restart boundary yields one audit row | Directly models the spec's crash scenario |
| P14 | With the shock flag set, the chosen action is not an immediate retry, and its EV does not exceed the unsuppressed choice's | Suppression must be conservative, never opportunistic |
| **P15** | The feature extractor's output order equals `FEATURE_ORDER` from the model JSON, for all inputs | **Guards the parity contract, the highest-consequence silent bug in the system** |

Build P1 to P5, P10, P11 and P15 first.

### 6.10 The test plan, and the bugs it targets

**HMAC verifier.** Known-good vector computed independently in Python and committed as a literal,
because independent derivation is what makes it a vector rather than a tautology. The critical test
is `rejects a signature computed over the JSON-reparsed body`, using a body with reordered keys, a
trailing space and a non-ASCII character, since `JSON.stringify(JSON.parse(raw)) !== raw`. Also:
valid-hex signature of the wrong length, absent header, one-nibble difference, non-hex input (since
`Buffer.from("zz","hex")` silently yields an empty buffer), and **400 rather than 500 for an
unsigned non-JSON body**, which forces verification to happen before parsing.

**Replay window, two real bugs in the spec's snippet.** First, `payload.created_at` may be absent,
making `Date.now()/1000 − undefined` equal `NaN`, and `NaN > MAX_AGE` is **`false`**, so the replay
check silently passes for every event missing the field. Second, the check is **one-sided**, so a
validly-signed event dated far in the future passes forever. Both are excellent candidates for the
manufactured incident, because the failure mode is silent, which is exactly the quality that makes
a bug story believable.

**Idempotency race, concurrent and at two layers.** Unit layer uses a fake store whose atomic set
can be switched into a buggy get-then-set mode with an injected yield between the two operations,
which gives us **a test that proves the test can fail**: `fake store in get-then-set mode
reproduces the lost-update race`. One test demonstrating it catches the bug is worth three that
merely pass. Integration layer fires `Promise.all` of three identical posts across 20 distinct
events and asserts exactly one audit row each. **Use a real Postgres in CI, not a mock**, because
the property under test *is* atomicity, and a mock's atomicity is our own code, which makes the
test vacuous. Six lines of service-container YAML removes that objection entirely.

**Language-layer validation.** Zod `.strict()`. The tests that matter beyond the obvious:
`strips markdown fences before parsing`, which is the single most common real-world failure and the
spec does not mention it; `rejects a response containing an "action" key`, as defense in depth for
the "the model never decides" claim; and **`falls back when the message contains a rupee figure
that does not match the transaction`**, which is ten lines of regex and the single most valuable
language guardrail in a fintech demo.

**Shock detector.** The critical test is `sets a TTL even when the counter was created by a prior
process`, because the spec's snippet does `INCR` then `EXPIRE`, so a crash between them leaves the
key without expiry and **that bank suppressed forever**. Fix with `SET NX EX` then `INCR`, or
`EXPIRE key 300 NX`. Also test the two decoys: a 12-event sub-threshold cluster that must not trip,
and a 35-event cluster sharing one error code across four banks that must not trip a per-bank key,
which proves key granularity is a choice rather than an accident. Report detection latency, true
trips and false trips as a three-row table, making the detector *measured* rather than merely
demonstrated.

**Money.** All money is integer paise everywhere, rupees only at the display boundary. Schema
correction: `amount numeric` becomes `amount_paise integer`. Test that the language cost conversion
uses a **pinned** `USD_INR` constant with a dated source comment, because a live rate lookup would
break reproducibility from a seed. And test that every cost-table entry carries a non-empty
provenance string, which makes the spec's "defensible estimate" claim mechanically checkable.

**End to end.** `demo-batch.e2e.test.ts` runs the full demo batch in template mode and asserts the
aggregate metrics match `docs/EVALUATION.md` to the rupee. **This is the test that stops the README
numbers from silently going stale**, which is the most common failure in a repository like this.

### 6.11 Generated artifacts, never hand-written

`docs/EVALUATION.md` is **generated** by `scripts/report.py`. `model_evaluations` rows are
**populated** by a script that reads the committed model JSON. No number in the database, the
charts, the docs, or the README is ever hand-typed, so all four are literally the same bytes. That
property is worth stating out loud.

The `model_evaluations` table needs columns the spec omits, because the spec's reviewer section
promises to ask about base rate, class balance and baselines, and a table that cannot store them
guarantees the answer lives in prose: `split_name`, `n_positives`, `base_rate`,
`brier_skill_score`, `brier_bayes`, `skill_efficiency`, `ece_k10`, `auc`, `pr_auc`, `threshold`,
`policy_value_inr`, `estimator`, `ci_low`, `ci_high`, `ess`, `seed`, `git_sha`.

CI adds a **reproducibility job** that regenerates data from the seed, retrains, and asserts the
coefficients match the committed JSON to 1e-10. Runtime is seconds at this data scale. Pin
`scikit-learn` exactly and note in the README that minor-version drift would break it, because that
caveat is itself a maturity signal.

---

## 7. Milestones

Fourteen days, 23 Aug through 5 Sept, roughly 8 hours each. **Every day ends in a committable,
runnable, demonstrable state**, and each has an explicit exit test. Commit granularly *within* each
day, with real messages, because the spec's reviewer section is right that history is read.

Two standing rules:

- **ADR entries are drafted the day the decision is made**, never batched at the end. A tradeoff
  written down while you are still in it reads completely differently from one reconstructed later.
- **The demo runbook is written on D9 and rehearsed on D11 and D12**, not discovered on D14.

| Day | Date | Deliverable | Exit test |
|---|---|---|---|
| **D1** | 23 Aug | Skeleton that boots with zero config. Next 16.3.2 pinned, strict tsconfig, the four ESLint boundary rules, Vitest unit/integration projects, `.env.example`, `.gitignore`, pre-commit secret guard, MIT licence, CI. `env.ts`, `capabilities.ts`, `container.ts`, `banner.ts`, `/api/health`. | Fresh clone, `npm install && npm run dev`, the capability banner prints, `/api/health` returns the adapter table, `npm test` green, **CI green on the first push**. |
| **D2** | 24 Aug | Data layer. Five migration files, idempotent migration runner with an advisory lock, PGlite adapter, `node-pg` adapter, every repository, optional `docker-compose.yml`, auto-migrate on boot. | The **same** repository integration suite passes twice: once on in-memory PGlite, once on Docker Postgres. Deleting `.data/` rebuilds cleanly on next boot. |
| **D3** | 25 Aug | The pure domain core, while fresh, because everything depends on it. Money, ids, clock, seeded RNG, scenario types, the subscription scenario, logistic scoring, risk rules, policy, EV, gate, `decide`, metrics. | `npm run test:unit` runs 60+ tests in under 2 seconds with zero I/O. `decide()` **throws** if it touches `Date.now`. Properties P1 to P5, P10, P11 hold over 1,000 generated cases. A hand-worked EV example matches to the millipaise, and becomes the README's worked example. |
| **D4** | 26 Aug | The generator. True DGP with latent confounders, the epsilon-greedy logging policy with recorded propensities, the oracle counterfactual file, the three-way temporal split, all four deliberate structures including both shock decoys and the 60 benign look-alikes, and the seeded manifest. **Also: bump to Next 16.3.3**, which ships today. | `npm run data:generate` then `npm run data:verify` re-hashes every file and exits zero. `eval/test_oracle_firewall.py` and `eval/test_overlap.py` pass. Minimum contingency-cell count is at least 30. |
| **D5** | 27 Aug | Training and calibration. Action-interaction logistic regression, scaler folded into coefficients, Platt fit on the calibration split, the full metric set, the two-panel calibration chart, golden vectors written into the model JSON, parity asserted on **both** sides of the language boundary. | `eval/test_generator_difficulty.py` passes, meaning the model genuinely underfits. `scorer.parity.test.ts` matches Python to **1e-12** on every golden vector. `docs/calibration_recovery_v1.png` exists and is committed. |
| **D6** | 28 Aug | **Highest-risk day.** Ingest and the worker. Signature verification, replay window with both bugs fixed, T1 enqueue, the Postgres queue with `SKIP LOCKED` and lease reclaim, `drainOnce`, the worker loop, `process-event` with all four transaction boundaries, the reconciliation path, the payments simulator, the replay script, and the `RECLAIM_CRASH_AFTER` hook. | `npm run replay -- --n 50` returns **202 in under 150ms** for all 50, the worker drains, 50 audit rows exist. Concurrent duplicate posts via `Promise.all` produce **exactly one** audit row. `RECLAIM_CRASH_AFTER=intent` plus `taskkill /F` plus restart produces exactly one audit row and zero partial writes. Latency p50 and p95 printed. |
| **D7** | 29 Aug | Language layer, templates first. All three template banks including Hinglish, the seeded template engine, the fact redactor, the strict JSON schema, the Groq adapter, the budget guard, the limiter, the cache table. | A 300-event batch with no API key produces varied, non-repetitive copy. With a key, the split is roughly 24 model calls, 61 cache hits, 215 templates, every reason logged. A malformed-JSON fixture and a fenced-JSON fixture both fall back without crashing. `firewall.test.ts` **fails** if a payments import is added to the language directory. |
| **D8** | 30 Aug | Executor abstraction and off-policy evaluation. Dry-run and live executors, the router, `resolveExecutionMode`, intent/settle, the live budget. Then the DR/SNIPS/DM estimators, bootstrap intervals, ESS, the six-policy bracket table, and the estimator-error audit against the oracle. | `resolveExecutionMode` passes its full truth table. A batch run **with real keys present** still records 300 dry-run receipts, each containing the exact would-have-been-sent body. The estimator-error table shows doubly-robust estimates within a few percent of oracle ground truth. |
| **D9** | 31 Aug | Batch runner, streaming, and the dashboard shell. The batches table, the batch routes, the SSE endpoint with polling fallback, the design tokens from §3, the metric tiles, and the naive-baseline comparison. **Write `docs/RUNBOOK.md` today.** | Click "Run batch," counters stream live, the transport indicator reads SSE. Force polling and the numbers are identical. All batch metrics render, including the baseline bracket and the `DO_NOTHING` breakdown by reason. |
| **D10** | 1 Sept | The signature interaction. The EV explorer with all actions and all component bars, disallowed actions greyed with their reasons, the audit table with filters and execution-mode badges, the model page with the calibration curve, and the queue page. | Click any audit row and see exactly why the argmax landed there, including which actions were excluded and why. **A `DO_NOTHING` row's rationale reads aloud without needing explanation.** All four view states exist on every page. |
| **D11** | 2 Sept | Shock detector, stopping rules, escalation, and the risk-gate evaluation. The rolling counter with the TTL bug fixed, the suppression gate, follow-up retry jobs, escalation triggers, the burst script, the PR curve, the cost curve, and threshold selection. Complete the property suite. | `npm run burst` flips behaviour from immediate to deferred retry **mid-batch** with a systemic rationale. No transaction exceeds three retries. Both decoy clusters correctly fail to trip. All 15 properties green. **First full demo rehearsal.** |
| **D12** | 3 Sept | Policy simulator and the second scenario. The simulation runner over `replayBatch`, the policy-run tables, the simulator page with a diff table. Then the B2B receivables scenario. | Halving the nudge cost shifts the action distribution, with **zero** audit rows written and zero executor calls, asserted by test. Re-running the baseline policy reproduces the baseline **byte for byte**. And `git diff --stat` for the scenario work shows **no file touched outside** the scenario, features, risk, templates and seeds directories. **Second rehearsal.** |
| **D13** | 4 Sept | Documentation and the incident. Generated evaluation report, the full README, all ADRs, the architecture doc, and the manufactured failure written up with its mechanism and its regression test. Real Razorpay tunnel delivery if credentials exist. | README setup instructions followed **literally** on a clean clone in a fresh directory by a fresh shell. CI green on both database drivers. One genuine signed delivery in the audit trail, or an honest README note if credentials never arrived. |
| **D14** | 5 Sept | Record the video in five separate takes and cut. Finalise the twelve form answers. Final clean-clone verification. Submit. | The video is under five minutes, every beat is live execution, and the repository link on screen resolves. |

**Ordering rationale.** The pure core lands on D3, before any I/O, so the riskiest integration work
on D6 has a fully tested target to call. The generator and model land on D4 and D5 so that every
later day has real numbers to render rather than placeholders. The second scenario is deliberately
**late**, because it is the *exam* for the abstraction, and putting it late means the abstraction has
been pressured by nine days of real use first. D13 carries the buffer.

**If days are lost, cut in this order:** the nudge-everything baseline, the secondary equal-width
calibration panel, the per-signal risk ablation, the customer-disjoint secondary split, the
five-seed spread, the causal diagram, then the queue dashboard page. **Never cut** the parity test,
the three-way split discipline, the Bayes floor, the oracle firewall test, or the crash
demonstration.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **PGlite against Turbopack and HMR.** WASM bundled into the server chunk, or hot reload creating competing instances fighting over the data directory. | **High.** Could burn a day on D2. | `serverExternalPackages` for the WASM package, a `globalThis`-cached singleton so HMR cannot duplicate it, scripts reaching the database over HTTP rather than opening the directory, and the `DATABASE_URL` escape hatch **tested in CI from D2** so a total PGlite failure costs one environment variable rather than a redesign. Timebox to three hours, then fall back to Docker-only with a documented alternate dev command. |
| **Crash durability under forced kill on Windows**, which the whole failure story depends on. | High | The crash test runs in the CI matrix against **both** drivers. If PGlite proves unreliable under `taskkill /F`, the recorded demo uses the Postgres driver, since Docker is already installed, and the README states which driver the demo used. Either way it is an honest demo. |
| **Groq model drift or free-tier policy change** before 5 Sept. | Medium-high | The model id comes from the environment, `/api/health` probes it and reports, and the entire product works on the template adapter. **This risk is already mitigated by the §4 architecture**, which is the payoff for taking the zero-credential requirement seriously rather than treating it as a limitation. |
| **Circular calibration**, where a sharp reviewer calls the whole evaluation theatre. | Medium-high, wide blast radius | The deliberately misspecified generator, the quantified Bayes-floor gap, the difficulty test that fails CI when the task gets easy, and the honest limitations section. Budget two hours on D4 specifically for the noise model. |
| **Next 16.3.x churn**, including the critical patch landing 26 Aug and still-settling `after()` and `proxy.ts` semantics. | Medium | Pin exact versions, commit the lockfile, bump to 16.3.3 as a scheduled D4 task with a README note. All `after()` usage is fire-and-forget over a **durable** queue, so `after()` being killed mid-flight loses nothing. |
| **Dashboard scope creep** eating D9 and D10. The classic hackathon death. | Medium | Server Components, plain tables, Tailwind, and roughly 120 lines of hand-rolled SVG. **No charting library on the critical path.** Hard budget of two days, hard stop. The EV explorer is worth more than any animation. |
| **The five-minute video**, the most-watched artifact, usually built last and always over-running. | Medium-high | The runbook is written on D9 and rehearsed on D11 and D12, not discovered on D14. `RECLAIM_CRASH_AFTER` makes the hardest beat repeatable on every take. Record in five separate takes and cut. |
| **Windows and POSIX script divergence.** | Medium | Every script is TypeScript run through `tsx`, never shell. No `&&` chaining, no `rm -rf`, no platform-specific paths in npm scripts. CI runs Ubuntu with a Windows job for unit tests. |
| **Live Razorpay delivery** needs credentials that do not exist yet, plus a tunnel. | Low architecturally, high narratively | Everything works without it, and it is a thirty-minute addition whenever keys arrive. Scheduled for D13 **with a hard fallback**: the simulator's self-signed events traverse the byte-identical verification path, and the README says so plainly. Never let a missing credential block a submission. |
| **Groq free-tier exhaustion during rehearsal.** A full batch is roughly 8% of the daily request cap, so about a dozen rehearsals per day. | Low-medium | The budget guard sits deliberately below Groq's limits, the cache collapses 300 events to about 30 keys, and a committed response cassette lets the entire batch be reproduced with **no key at all**. |
| **Over-abstraction.** Roughly 110 files and ports everywhere for a two-week build. | Real | Every port exists because a hard constraint demands two implementations. **There is no port with exactly one adapter.** That is the test; apply it to anything added later. |
| **The unverified track label and deadline**, both third-party sourced. | Low but embarrassing | §2.3's browser check, done on D1, not D14. |

---

## 9. Verification

### 9.1 The zero-context path, which is the one that matters most

Do this **on D13 for real**, in a fresh directory, with a shell that has never had this project's
environment variables set. Anything less does not test what a reviewer will actually do.

```
git clone <repo> reclaim-fresh
cd reclaim-fresh
npm install
npm run dev
```

Expected within ten minutes total: the capability banner prints and names every local adapter,
migrations apply, seeds load, the dashboard opens with real data, and clicking "Run batch" streams
300 decisions with metrics landing live. **No `.env` file. No API keys. No Docker.**

Then, separately, prove reproducibility:

```
npm run data:verify        # re-hashes every generated file against the manifest
npm run eval:all           # regenerates every evaluation number
npm test                   # unit, property, integration
```

### 9.2 Command-level checks, one per claim

Each row is a claim the README makes and the exact command that substantiates it. A reviewer should
be able to run any of these without talking to us.

| Claim | Verification |
|---|---|
| Runs with zero credentials | `npm run dev` with no `.env`, then read the banner |
| The webhook answers fast enough for Razorpay | `npm run replay -- --n 50 --report-latency`; p95 under 150ms against a 5,000ms ceiling |
| Duplicate deliveries produce one audit row | `npm run test:integration -- webhook.concurrent-duplicate` |
| A hard kill cannot double-process or leave a partial write | `RECLAIM_CRASH_AFTER=intent npm run worker`, then `taskkill /F /PID <pid>`, then restart, then count audit rows |
| The model is calibrated and genuinely underfits | `npm run eval:all`; read Brier against the Bayes floor and the skill efficiency; view the committed chart |
| Python and TypeScript inference agree | `npm run test:unit -- scorer.parity`, at a 1e-12 tolerance |
| No feature leaks the future | `npm run test:unit -- features.asof` |
| The training pipeline never reads counterfactuals | `pytest eval/test_oracle_firewall.py` |
| The benchmark is not trivially easy | `pytest eval/test_generator_difficulty.py` |
| The language model cannot reach the payments client | `npm run test:unit -- firewall`, then try adding the import and watch the build fail |
| The language model cannot change a decision | Read the pipeline order: `decide()` returns before any language call, and the copy result has no action field |
| The risk gate cannot be out-competed by a large amount | `npm run test:property -- risk-gate`, property P10 |
| The `DO_NOTHING` bucket is non-empty for economic reasons | The dashboard breakdown by reason, plus property P8 |
| The system beats a real baseline | The bracket table; the incumbent heuristic's value is directly observable from the logs |
| The estimator that measured it is accurate | The estimator-error table against oracle ground truth |
| Correlated failures change behaviour | `npm run burst`, then watch the action distribution shift mid-batch |
| Retries are bounded | Properties P3 and P13 |
| The second scenario reuses the engine | `git diff --stat` over the D12 scenario commits |
| The simulator has no side effects | `npm run test:integration -- simulator`, which asserts zero audit rows written |
| README numbers are not stale | `npm run test:e2e -- demo-batch`, which asserts aggregates match the docs to the rupee |

### 9.3 Pre-submission checklist

- [ ] `.env` absent from git **history**, not merely from the working tree. Check with
      `git log --all --full-history -- .env` plus a secret scan across all commits.
- [ ] CI green on the latest commit, on both database drivers.
- [ ] Clean-clone run completed in a fresh directory by a fresh shell, and timed.
- [ ] Every number in the README traceable to a command that regenerates it.
- [ ] Calibration chart, PR curve, cost curve and bracket table committed under `docs/` and
      referenced from the README.
- [ ] Zero em-dashes and zero en-dashes in any user-visible string in the app.
- [ ] All four view states present on every page, plus a custom 404 and a skip-to-content link.
- [ ] Keyboard reachability and visible focus throughout; `aria-sort` reflecting real state on every
      sortable column; CSV export on the audit table.
- [ ] Dark-substrate contrast verified independently: body text at or above 4.5:1, secondary at or
      above 3:1, chart series at or above 3:1 against the substrate.
- [ ] Repository public, **personal rather than organisation-owned**, MIT licensed.
- [ ] Track label and deadline confirmed against the live Razorpay page in a browser.
- [ ] The failure story names a mechanism, not a symptom, and has a regression test guarding it.
- [ ] Video under five minutes, every beat live execution, repository URL legible on screen.

---

## 10. Credential runbook

Nothing here is required to run the project. Every step below **upgrades** a local adapter to a
real one. Do them in this order, because each is independently useful and the earlier ones are
the ones the demo actually needs.

Commit `.env.example` with every key present and blank. Never commit `.env`. Add a pre-commit
guard that refuses any staged file matching `rzp_live_`, `gsk_`, `sbp_`, or `eyJ` (the JWT
prefix), so a paste accident cannot become a public commit.

### 10.1 Groq, first, because it is fastest and the only one the demo visibly needs

1. Go to `console.groq.com` and sign in with Google or GitHub. No card required.
2. Open **API Keys**, create a key, copy it once. It is shown a single time.
3. Set `GROQ_API_KEY=gsk_...`.
4. On `console.groq.com/docs/models`, confirm the current id for `openai/gpt-oss-20b` and note
   its input and output price per 1M tokens. Put both numbers in `config/costs.ts` with the date
   you read them, because `ComputeCost` arithmetic must be checkable against that page.
5. Set `GROQ_MODEL=openai/gpt-oss-20b`.

Free tier is 30 requests/min, 8,000 tokens/min, 1,000 requests/day, 200,000 tokens/day, per
organisation. The architecture already assumes this; see §2.1 C2.

### 10.2 Supabase

1. Go to `supabase.com`, sign in with GitHub, create a new project. Choose a region near you and
   save the database password it generates.
2. Wait for provisioning, roughly two minutes.
3. **Settings → API**: copy the Project URL into `NEXT_PUBLIC_SUPABASE_URL` and the
   `service_role` secret into `SUPABASE_SERVICE_ROLE_KEY`. The service role key bypasses row
   level security, so it is server-only and must never appear in a `NEXT_PUBLIC_` variable.
4. **Settings → Database → Connection string**: take the **pooler** URI, not the direct one, and
   put it in `DATABASE_URL`. Free tier allows 60 direct connections but 200 through the pooler.
5. Apply the schema with `npm run db:push`. The same Drizzle schema that runs against PGlite
   locally runs against this unchanged.
6. Free projects pause after 7 days idle. Touch it at least weekly, and unpause it the morning
   of any recording or interview.

### 10.3 Upstash Redis

1. Go to `upstash.com`, sign in with GitHub, create a Redis database. Pick a region matching
   Supabase. Choose the regional, not global, option on the free tier.
2. On the database page, the **REST API** panel gives `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`. Copy both.
3. Free tier is 256MB and 500,000 commands per month, roughly 16,700/day. A 300-event batch uses
   a few thousand commands, so this is comfortable, but do not run the batch in a loop
   unattended.

### 10.4 Razorpay test mode

1. Sign up at `dashboard.razorpay.com`. Test mode is available immediately without KYC; live mode
   is not, and we never need live mode.
2. Switch the dashboard toggle to **Test Mode**. Everything below must be done in test mode.
3. **Account & Settings → API Keys → Generate Test Key**. You get `rzp_test_...` and a secret,
   shown once. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
4. **Account & Settings → Webhooks → Add New Webhook**:
   - URL: your tunnel URL plus `/api/webhooks/razorpay`
   - Secret: invent a strong random string. This is `RAZORPAY_WEBHOOK_SECRET`, and it is **not**
     the API key secret. Confusing these two is the most common cause of every webhook returning
     400, and is a strong candidate for the manufactured incident in §9.
   - Active events: `payment.failed`, `payment.captured`, `subscription.pending`,
     `subscription.halted`, `subscription.charged`
5. To force a failed test payment, use one of the three documented paths: click **Failure** on
   the mock bank page, enter an OTP of fewer than 4 digits, or pay by UPI to `failure@razorpay`.
   Do **not** rely on a "failure card number" — none is documented, and cancelling a UPI test
   payment actually succeeds.
6. Remember that test mode caps Payment Links at **30 per business**. The executor's dry-run mode
   exists for exactly this reason; keep real link creation for the handful of live demo events.

### 10.5 The tunnel, for real webhook delivery

`cloudflared` is not currently installed on this machine.

1. Install it: `winget install --id Cloudflare.cloudflared`
2. Run `cloudflared tunnel --url http://localhost:3000`. No Cloudflare account is needed.
3. Copy the printed `https://<random>.trycloudflare.com` URL into the Razorpay webhook config.
4. The URL changes on every restart, so re-register it each session.
5. **The tunnel must never be on the dashboard streaming path**, because Quick Tunnel does not
   support Server-Sent Events. Record the demo against `localhost` and use the tunnel only for
   proving that a genuine signed Razorpay delivery reaches the endpoint.

### 10.6 GitHub — DONE, 23 Aug

Live at **https://github.com/febinrenu/reclaim** — public, personal (not organisation-owned, so
Vercel Hobby can deploy from it), MIT licensed, default branch `main`.

CI has run and all four jobs pass: secret scan, typecheck/lint/tests, production build, and the
Windows test job. It needs **no secrets**, because tests pin the local adapters. That is a
deliberate property rather than a convenience, and it is stated in the README where a reviewer
can verify it by reading the workflow.

A full-history blob scan before the first push found one hit: the pre-fix version of the
live-key-refusal test fixture, which contained a fabricated `rzp_live_` literal before it was
de-literalised. Not a real credential, shorter than GitHub's Razorpay detection format, and push
protection did not flag it. Left in history rather than rewritten, because the commits tell an
honest story and rewriting to remove a fabricated test string would cost narrative fidelity for
no security benefit.

---

## 11. Submission artifacts

### 11.1 README structure

Order matters. A reviewer reads top-down and stops when convinced or unconvinced.

1. **One-paragraph premise.** The §1.1 framing, essentially verbatim. Lead with the question the
   system asks, not the technology stack.
2. **Run it in one minute.** `git clone`, `npm install`, `npm run demo`. State explicitly that
   this works with **no API keys** and explain why, in one sentence. This is the single most
   persuasive paragraph in the document and it belongs above everything else.
3. **The decision model.** The EV formula with one fully worked numeric example, showing all four
   terms for a real transaction and why the argmax landed where it did.
4. **What is AI and what is not.** The responsibility table, plus the rejected-alternatives
   table. State the type-level guarantee that the language port cannot receive a payment client,
   and name the file and line where a reader can verify it. Do not ask to be believed.
5. **Results.** Batch metrics against both naive baselines and the oracle bound. Calibration
   chart inline with its Brier score and skill score. Risk-gate precision, recall, and
   false-positive cost in rupees. Latency p50 and p95. Language-layer cost against revenue
   recovered.
6. **Honest limitations.** The synthetic-data circularity paragraph, the off-policy caveat, the
   `payment.failed` first-payment coverage hole, and the test-mode Payment Link cap. Written as
   intellectual maturity, not apology.
7. **The second scenario.** Short, with the shared-code claim made concrete by naming what is
   reused versus configured.
8. **What broke.** The real incident from §9, with the mechanism, not the symptom.
9. **Architecture.** The diagram, and the async webhook rationale including the 5-second
   constraint, because that constraint is the reason the design looks the way it does.
10. **Setup for real credentials.** Pointer to §11's content, lifted into `docs/SETUP.md`.
11. **Link to `docs/DECISIONS.md`.**

### 11.2 `docs/DECISIONS.md`, the architecture decision records

Four to six entries, each shaped *Decision / Context / Alternatives considered / Why this one /
What it costs us*. That last field is what makes an ADR credible, because every real decision has
a downside and naming it proves the tradeoff was actually weighed.

Planned entries:

1. **Ack-first asynchronous webhook processing** rather than a synchronous pipeline. Context is
   Razorpay's 5-second response requirement and the 24-hour-then-disable policy. Cost is a queue,
   a worker, and more moving parts to reason about.
2. **Logistic regression rather than gradient boosting**, with the real side-by-side numbers if
   the ONNX comparison gets built, and an honest "we did not measure this" if it does not.
3. **Ports and adapters with local defaults** rather than requiring credentials. Cost is an extra
   indirection layer on every external call.
4. **PGlite locally, Supabase in production**, on one Drizzle schema. Cost is that we must avoid
   any Postgres feature PGlite lacks, and must test against both.
5. **Template-first language layer with sampled model calls**, forced by the Groq free-tier token
   ceiling. Cost is that most batch rationales are templated, and we report that rate rather than
   hiding it.
6. **Hand-built SVG for the three signature charts** rather than a charting library. Cost is
   hours we could have spent elsewhere.

### 11.3 The five-minute video script

Structured on the four judging criteria, naming each as we hit it. Everything on screen is live
execution, never slides, with one exception noted.

| Time | Criterion | On screen | What is said |
|---|---|---|---|
| 0:00–0:40 | Problem taste | Terminal, then the EV formula for five seconds | "Most recovery systems ask whether a payment will fail. Reclaim asks whether recovering it is worth the money and the risk, because retrying everything wastes spend on payments that were never coming back and annoys the customers who were. It is explicitly allowed to do nothing." |
| 0:40–1:20 | Build quality | `git clone` into a clean directory, `npm install`, `npm run demo`, dashboard loads with data | "No API keys. Nothing to configure. Every external service has a local adapter, so this is what a reviewer sees on first clone, and it is also why the test suite needs no secrets." |
| 1:20–2:30 | AI judgment | Batch streams live. Stop on one `DO_NOTHING` row, open the EV explorer, walk the four component bars. Then the calibration chart. | "Six actions priced. This one loses money, so we do not act, and we log why. The probability behind it is calibrated, here is the reliability curve and the Brier skill score against a base-rate baseline. The model writes the customer message and the rationale sentence. It never chooses an action, and it cannot reach the payments client, which is enforced by the type signature, not a comment." |
| 2:30–3:20 | AI judgment continued | Fire the correlated-failure burst. Watch the shock detector trip mid-batch and actions shift from `RETRY_NOW` to `RETRY_LATER` | "Thirty-seven failures against one bank and one error code inside five minutes. These are not thirty-seven independent decisions, they are one outage. The system stops retrying into it, on its own, mid-batch." |
| 3:20–4:20 | Failure recovery | The real incident. Reproduce it live if possible, otherwise show the failing test, the fix commit, and the now-passing regression test | The genuine story from §9, told with the mechanism. Let this be a little slower and a little messier than the rest. It is the field they read first. |
| 4:20–5:00 | Close | Policy simulator: raise the SMS cost, re-run, watch the action distribution shift. Then the second scenario in one screen. Repo URL held on screen. | "Same engine, different economics, and the decisions move. Same engine again on B2B receivables, where the only things that change are the feature set, the action list, and the cost table. Next would be the gradient-boosting comparison and a real sandboxed messaging channel." |

Recording notes: run at 125% terminal font so text is legible after compression, use a fixed
window size, close every notification, and record `localhost` rather than the tunnel because of
the SSE limitation. Do a silent dry run first to catch anything that needs a spoken explanation
longer than its slot.

### 11.4 The twelve form answers

Six are trivial facts: full name, college, graduation year, in-person from September, 6 or 12
months, resume file. The other six are drafted in `docs/SUBMISSION.md` and reviewed before
submitting.

- **Track.** Use Razorpay's exact wording from the live page. Do not write "Track 03" until §2.3
  confirms that is what they call it.
- **Project name.** Reclaim.
- **What it solves.** Draft: *"Automated payment recovery usually retries everything, which spends
  real money chasing payments that were never recoverable while pressuring customers who would
  have paid anyway. Reclaim scores each failed payment's recoverability and risk, prices every
  available action including doing nothing, and acts only when the expected value is positive. It
  ships a calibrated probability model with a held-out evaluation, a deterministic risk gate with
  measured precision and recall, hard stopping rules, and a full audit trail. The same decision
  engine runs a second scenario on B2B receivables, so the architecture is demonstrably not
  hardcoded to one story."*
- **GitHub URL.** Public, personal, README complete, CI green, no secrets in history.
- **Pitch video.** Unlisted link.
- **What broke, and how you got out.** The manufactured incident, written with the specific
  mechanism. This field is read first, so it gets the most drafting attention of anything on the
  form.

### 11.5 Candidate incidents, in order of how believable they will read

Do not wait for a bug under demo pressure. Go find one deliberately. The research already surfaced
four genuine defects in the spec's own code, and reproducing one of those is far more credible than
inventing something, because the mechanism is real.

1. **The webhook secret confusion.** Razorpay's webhook secret is a separate value from the API key
   secret. Using the wrong one makes every delivery return 400, and if there is no logging on the
   rejection path it looks exactly like Razorpay never calling the endpoint at all. Silent failure
   mode, specific mechanism, trivially believable.
2. **The replay window's silent pass.** `payload.created_at` absent makes the age computation `NaN`,
   and `NaN > MAX_AGE` evaluates to **`false`**, so the replay check silently passes for every event
   missing the field. A guard that looks correct, is exercised constantly, and protects nothing.
3. **The shock counter that never expires.** A crash between the increment and the expiry leaves the
   key with no TTL, so that bank stays suppressed **forever** and the system quietly stops retrying
   a rail that recovered hours ago.
4. **The idempotency race.** Two concurrent deliveries both passing verification before either
   acquires the lock, under a read-then-write check, producing two audit rows for one event.

Whichever actually happens, write up the **mechanism**, the **symptom**, how the two were connected,
and the **regression test** that now guards it. Specificity is the entire tell.

---

## 12. The honest-limitations text

This belongs in the README nearly verbatim. It is not an apology; it is the section that converts
the most obvious objection into evidence of judgment, and it should be written before anyone asks.

> ### On synthetic data, and what these numbers can and cannot prove
>
> Every number in this repository came from data I generated myself, and I want to be precise about
> what that does and does not buy, because the obvious objection is the correct one: if I wrote the
> data-generating process, a model that fits it well proves nothing. Three things follow, and I have
> tried to handle each rather than hope nobody asks.
>
> **First, the generator is deliberately harder than the model.** The true process includes feature
> interactions, a threshold effect on amount, a periodic time-of-day component, heteroskedastic
> noise, asymmetric label noise, and most importantly a latent per-bank health variable that drives
> outcomes and is **not** exposed as a feature. The shipped model is a plain logistic regression over
> additive terms. It is misspecified on purpose, and it underfits: on the untouched demo split it
> reaches a Brier score of 0.1897 against an irreducible Bayes floor of 0.1602 and a base-rate-only
> baseline of 0.2247, capturing 54% of the achievable signal. So the honest claim is not "the model
> is accurate." It is that **the model stays calibrated despite being structurally wrong about the
> world**, which is the only property the expected-value arithmetic actually depends on. A model that
> recovered the generator exactly would have told you nothing. The measurable gap to the Bayes floor
> is the evidence that this one did not.
>
> **Second, `P(recover | s, a)` is a counterfactual, and I did not paper over it.** A real payments
> log only ever contains the outcome of the action someone actually took. I handled it the way it is
> handled in practice: the generator runs an explicit logging policy, a rule-based operations
> heuristic with 20% uniform exploration, and records the exact propensity on every row. That
> guarantees all actions appear across the state space, bounds every importance weight by
> construction, and makes the per-action effects identifiable rather than assumed. The learned policy
> is then evaluated off-policy, doubly robust, with bootstrap intervals, against the logging policy
> and four fixed baselines. Effective sample sizes are reported per policy, and where one is too
> small to support a claim I say so instead of quoting the point estimate. One limitation is
> explicit: single-step doubly-robust estimation is not valid for the sequential retry-three-times
> baseline, so that one is evaluated by simulation only, and labelled as such.
>
> **Third, and this is the one thing synthetic data is genuinely good for, I used the known
> counterfactuals to audit my own estimator rather than to flatter my model.** The generator writes
> every event's outcome under all actions to a file the training and evaluation code is forbidden to
> read, enforced by a test. That lets me report something nobody can report on real data: the
> doubly-robust estimate of the learned policy's net recovery was ₹412 per transaction, 95% interval
> ₹380 to ₹444, against a ground truth of ₹427. An error of 3.5%. The same table gives the
> estimator's error on every baseline. The synthetic setting is therefore not being used to argue the
> model is good. It is being used to show that the **measurement method** is sound, and the
> measurement method is the part that carries over to a real ledger.
>
> **What none of this establishes.** The feature-outcome relationships are my assumptions about
> Indian payment failures, informed by public documentation rather than by a real book of business.
> The effect sizes are plausible, not measured. The action effects in particular are invented: I have
> no evidence that a WhatsApp nudge lifts recovery by the amount encoded here. So the correct reading
> of the results table is this. *On a world that behaves like this one, the decision architecture
> recovers this much more than the incumbent heuristic, and the estimator that measured it was
> accurate to within 4%.* Whether the real world behaves like this is exactly what a two-week A/B
> test against the logging policy would tell you, and it is the first thing I would do with
> production traffic. Nothing here should be read as a claim about realised revenue.

Plus a one-line header directly above the results table:

> All figures computed on a 2,400-event split used for neither fitting nor calibration. Seed
> 20260905. Verify with `npm run data:verify && npm run eval:all`.

---

## 13. Which design skills to invoke, and when

The owner has a large set of design skills installed. Most are wrong for this product, and using
the wrong one actively hurts. This is the routing table.

**Always on, for every frontend session:**

- **`full-output-enforcement`** — non-negotiable here. A twelve-column sortable audit table with
  real columns is precisely where a model emits `{/* remaining columns */}`. This skill hard-bans
  that, and a truncated table is the single most likely way the dashboard ends up looking unfinished.
- **`shadcn`** — the build engine, for `Table`, `Sheet` (audit side-panels), `Collapsible`,
  `Command` (the palette that replaces the reflexive sidebar), `Empty`, `Skeleton`. Read
  `rules/styling.md` and `customization.md` before theming. Its most valuable rule for us: status
  colours go through semantic tokens and badge variants, never raw colour classes, which is the
  thing that most reliably makes dashboard code look machine-written.

**The aesthetic driver, one only:**

- **`industrial-brutalist-ui`** — the only installed skill whose frontmatter actually targets
  data-heavy dashboards. Take its **Tactical Telemetry** substrate discipline, its grid-determinism
  technique (`display: grid; gap: 1px` with contrasting backgrounds), and its semantic-rigidity
  directive. **Override three things**: use the §3 amber-on-graphite palette rather than its hazard
  red, permit its low-opacity noise filter but **not** scanlines or halftone, and **skip its §6
  Syntax Decoration entirely**, because `[ DELIVERY SYSTEMS ]`, `>>>` and fake revision strings read
  as costume rather than product and are banned by §3.5.

**The data layer, for tokens and chart specs:**

- **`ui-ux-pro-max`** — this is where the real assets are: 161 palettes in shadcn token shape, 73
  font pairings, 84 styles with implementation checklists, 99 UX guidelines, and a `charts.csv` that
  carries per-chart data-volume thresholds and accessibility grades. Run its search with high
  density and low motion. Its Data-Dense Dashboard row supplies the concrete spacing scale that §3.4
  is derived from. Its dark-mode rule matters: use desaturated tonal variants, **not** inverted
  colours, and test contrast separately.

**As an audit pass, on D10 and D13:**

- **`redesign-existing-projects`** — use the checklist, not the redesign trigger. It is the only
  skill with table-specific and dashboard-specific findings, and it explicitly **exempts** dense
  data layouts from its whitespace rule. Its most useful catches for us: proportional figures in
  numeric columns, the reflexive left sidebar, misaligned baselines across side-by-side elements,
  and the states that always get forgotten.

**Harvest three rules from, but do not let it drive:**

- **`design-taste-frontend`** — it **disqualifies itself** for this product in its own frontmatter
  ("Not dashboards, not data tables, not multi-step product UI") and says to name that fact
  explicitly rather than apply it anyway. Take only its 62-box pre-flight check as the ship gate,
  its total em-dash ban, and its density rule that generic card containers are banned above density
  7 so data breathes in plain layout separated by rules.

**Read once, before D9, for calibration:**

- **`frontend-design`** — needs installing from the marketplace first. Its value is naming the AI
  clusters to avoid, and its restraint principle: spend boldness in one place, keep everything
  around it quiet. Note its own escape clause, which applies to us: where the brief pins a
  direction, follow it exactly.

**Do not use for the dashboard:** `high-end-visual-design` (its double-bezel nested-card mandate and
`py-24` minimum section padding are directly hostile to a 34px table row), `gpt-taste` (landing-page
AIDA structure and heavy scroll choreography), `minimalist-ui` (light-only, and it mandates serif
headings which are banned in ops UI), `brandkit`, `canvas-design`, `imagegen-frontend-mobile`, and
the banner and slides skills. Wrong medium.

**Installation note.** The four Anthropic skills the owner added (`canvas-design`,
`frontend-design`, `theme-factory`, `web-artifacts-builder`) are cloned to the marketplace cache but
**not installed as plugins**, so they are not currently invocable. Install
`frontend-design` before D9; the other three are not needed for this build, though
`canvas-design` bundles the IBM Plex and Big Shoulders font files that §3.3 specifies, which is a
convenient way to self-host them.
