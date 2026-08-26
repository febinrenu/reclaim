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
- **No OWASP-style review, no penetration test.** `npm audit` is now real and
  wired into CI (see above), but that covers known dependency CVEs only — it
  says nothing about this project's own code.
- **The rate limits above are per-IP via `x-forwarded-for`**, which a
  motivated attacker can spoof or route around (a botnet, or simply omitting
  the header behind a proxy that doesn't set it, falls into one shared
  bucket). This raises the bar for casual abuse of a demo instance; it is not
  a defense against a determined one.
- **No rate limiting on the webhook route itself.** The signature check is
  real protection against forged events, but a flood of *correctly signed*
  duplicate deliveries (which a legitimate but misbehaving webhook sender can
  produce) has no independent throttle beyond whatever the database and
  connection pool can absorb — see `docs/LOAD_TEST.md` for what that ceiling
  actually measured to be.
- **No secrets manager.** Real credentials live in a gitignored `.env`,
  scanned for on every commit, but that is a development-time safeguard, not
  a production secrets-management story (rotation, access auditing, a vault).

## If this were going into real production tomorrow, in order

1. Real authentication on every route that is not the public webhook endpoint.
2. `npm audit` (and Python's equivalent) wired into CI, not run once by hand.
3. A real penetration test or at minimum a structured OWASP Top 10 pass, by
   someone other than the person who wrote the code.
4. Rate limiting the webhook route itself, and moving IP-based limiting to
   something that survives a spoofed or absent `x-forwarded-for` header (a
   real reverse proxy or WAF setting that header itself, not trusting a
   client-supplied one).
5. A real secrets manager and a documented rotation policy for the Razorpay
   webhook secret and API keys.
