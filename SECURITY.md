# Security posture

Written directly, in the same spirit as this project's "Honest limitations" —
what is real, what is not, and what was never claimed.

## What is actually protected

- **The webhook route (`/api/webhooks/razorpay`) verifies an HMAC signature
  before anything else touches the request body** (`verifyWebhookSignature`,
  `src/domain/webhooks/verify-signature.ts`) — the raw bytes, not a re-serialized
  copy, checked before any parsing or persistence. This is the real perimeter
  for the one route that accepts external, untrusted input claiming to be a
  payment event.
- **A replay window** (`src/domain/webhooks/replay-window.ts`) rejects a
  correctly-signed but stale delivery.
- **Idempotency is a database UNIQUE constraint in the same transaction as the
  write** (`webhook_events.event_id`), not a lock in a separate store that
  could disagree with what actually got written — see `src/ports/kv.ts`'s own
  docstring on exactly why that distinction matters.
- **Exactly one file reads `process.env`** (`src/config/env.ts`), enforced by
  an ESLint boundary rule, so no adapter can read a credential the capability
  banner doesn't already know about and report honestly.
- **`RAZORPAY_KEY_ID` starting with `rzp_live_` fails to boot.** Not a warning
  — a hard refusal, so this project structurally cannot move real money by
  accident, in any deployment.
- **`/api/batches` and `/api/simulate`, the two unauthenticated public routes
  that do real work per call, are rate-limited per client IP** (5 batches / 5
  minutes, 20 simulations / 5 minutes — `src/app/rate-limit.ts`, verified live:
  6 real requests against the running instance, 5 accepted, the 6th a real
  `429`). Added after a strict outside review named the *absence* of this
  directly.
- **A pre-commit hook and a CI job both scan every diff for secret-shaped
  strings** (`scripts/scan-secrets.mjs`) before anything reaches the remote.

## Run for real, not assumed

`npm audit` was actually run against this exact dependency tree: **0
vulnerabilities**, at every severity level, as of the commit this file was
added in. Wired into CI (`.github/workflows/ci.yml`'s `audit` job, failing the
build on any high/critical finding) so this stays a checked fact rather than a
one-time snapshot that silently goes stale.

## What is genuinely not done, stated plainly rather than left for a reader to discover

- **No authentication on any route.** The dashboard, the audit ledger, the
  queue page, and the batch/simulate endpoints are all open to anyone who can
  reach the instance. For a hackathon demo instance this is the point — a
  reviewer should not need credentials to see it work. For any real
  deployment, this would need a real auth layer before anything else on this
  list matters.
- **The operator queue has no authentication, so `assignee` is self-asserted.**
  `PATCH /api/escalations/<id>` is rate-limited (120/60s per client IP) and its
  state transitions are safe against concurrency — each is one conditional
  UPDATE, so two callers cannot both claim one item. What it cannot do is tell
  you *who* acted: the assignee is a string the caller types, recorded as
  `'unattributed'` when omitted. For a demo instance that is the point, and the
  audit trail says plainly that nobody put their name to it. For anything real,
  this is the route that most needs authentication first, because it is the one
  that writes human-attributed outcomes into a customer's history.
- **No OWASP-style review, no penetration test.** `npm audit` is now real and
  wired into CI (see above), but that covers known dependency CVEs only — it
  says nothing about this project's own code.
- **The rate limits above are per-IP via `x-forwarded-for`**, which a
  motivated attacker can spoof or route around (a botnet, or simply omitting
  the header behind a proxy that doesn't set it, falls into one shared
  bucket). This raises the bar for casual abuse of a demo instance; it is not
  a defense against a determined one.
- **The webhook route's own rate limit is deliberately generous, and that is a
  real residual.** It *is* rate-limited now (300 requests / 60s per client IP,
  `app/api/webhooks/razorpay/route.ts`), which closes the volumetric-flooding
  hole that existed when only `/api/batches` and `/api/simulate` were limited.
  But 300/60s is set high on purpose — a real burst of legitimate Razorpay
  deliveries for one merchant must never be dropped — so it stops casual abuse
  of a public URL, not a determined flood. A flood of *correctly signed*
  duplicate deliveries under that ceiling still lands on the database and the
  connection pool; `docs/LOAD_TEST.md` measured what that ceiling actually is.
- **`/api/health` publishes less than it used to, and the reason is not
  flattering.** Unauthenticated, it was returning each port's `target` — which
  on a configured instance meant a real Supabase database hostname, a real
  Upstash hostname, and the Groq model id, to anyone who asked. That is free
  reconnaissance and no part of what a health endpoint is for. Setting
  `RECLAIM_PUBLIC_INSTANCE` now withholds `target`; adapter names, `live`
  flags, and the human-readable `reason` still come through, so the endpoint
  still answers the question it exists to answer. Locally the full table is
  genuinely useful, which is why the flag is opt-in rather than keyed off
  `NODE_ENV` — the documented demo path runs a real production build.
- **`/api/dev/*` was named "dev" and gated by nothing.** Both routes
  (`audit-count`, `audit-actions`) answered on a production build,
  unauthenticated, and `?eventIds=` was an unbounded list fanned into a SQL
  `= ANY($1)` — parameterised, so never an injection, but an arbitrarily long
  array is cheap to send and not cheap to answer. Now: `RECLAIM_PUBLIC_INSTANCE`
  turns them off entirely (404, not 403 — a route that is off should not
  confirm it exists), and the list is capped at 500 on every instance either
  way (`src/app/dev-route-guard.ts`, `tests/unit/dev-route-guard.test.ts`).
  They still exist because the reason they exist is real: `scripts/replay.ts`
  must not open a second connection to a single-process embedded database.
- **No secrets manager.** Real credentials live in a gitignored `.env`,
  scanned for on every commit, but that is a development-time safeguard, not
  a production secrets-management story (rotation, access auditing, a vault).

## If this were going into real production tomorrow, in order

1. Real authentication on every route that is not the public webhook endpoint.
   Still the first thing, and still not done.
2. A Python dependency audit (`pip-audit`) wired into CI the way `npm audit`
   already is. The npm half of this list item was done and the item was never
   updated, which is exactly the kind of stale claim this file should not make;
   the Python half genuinely is still open.
3. A real penetration test or at minimum a structured OWASP Top 10 pass, by
   someone other than the person who wrote the code.
4. Moving IP-based limiting to something that survives a spoofed or absent
   `x-forwarded-for` header (a real reverse proxy or WAF setting that header
   itself, not trusting a client-supplied one). Rate limiting the webhook route
   itself was the other half of this item and is now done — see above.
5. A real secrets manager and a documented rotation policy for the Razorpay
   webhook secret and API keys.
