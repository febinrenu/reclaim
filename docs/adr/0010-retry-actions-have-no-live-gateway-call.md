# ADR 0010 — RETRY_NOW and RETRY_LATER have no live payments-side call, investigated not assumed

**Status:** Accepted, and **re-tested to exhaustion on 2026-08-28** — see "Update"
at the end. The decision is unchanged; the *reason* for it turned out to be
different from, and narrower than, what this ADR originally argued.
**Date:** 2026-08-26.

## Context

A strict outside review of this project (kept, verbatim reasoning, in the session
history — not invented after the fact) named this the single most damaging
technical fact in the whole submission: `executeAction`
(`src/ports/executor.ts`) only ever calls the real Razorpay API for the
`PAYMENT_LINK` action. `RETRY_NOW` and `RETRY_LATER` — the two most common
actions the trained scorer actually chooses — return `{ outcome: 'pending',
receipt: null }` with no payments-side call at all, live or otherwise. The
comment in the code said so outright, with no explanation of *why*, which read
as an unexamined gap rather than a considered constraint.

This ADR exists to answer the question the review correctly raised: was this
ever actually investigated, or just left alone because it was convenient?

## What was actually tried

Empirically, this same session, against real Razorpay test-mode credentials:

1. **Direct server-to-server payment creation** (`POST /v1/payments/create/upi`,
   the API a merchant backend would need to silently re-attempt a UPI collect
   without a customer touching a checkout page) returned `400 BAD_REQUEST_ERROR
   — "The requested URL was not found on the server"` — this endpoint requires
   a Razorpay account with S2S/Seamless integration explicitly enabled by
   Razorpay, which is not available on a standard test-mode account created for
   a hackathon, and was not granted here.
2. Razorpay's real, working retry mechanism for *recurring* charges —
   Subscriptions' own automatic dunning — requires a tokenized mandate
   (e-NACH/UPI Autopay/saved-card-with-consent) registered at subscription
   creation time. This project's webhook path models one-time
   `payment.failed` events, not a Subscriptions-API-backed recurring charge,
   so there is no token on file to retry against even if that API were used.

## Decision

`RETRY_NOW`/`RETRY_LATER` continue to have no live payments-side call,
**because there structurally isn't a safe one available to this build** — not
because building one was skipped. This is not a Razorpay-specific gap: no
card network or UPI rail permits a merchant backend to silently re-charge a
customer without either a registered recurring mandate or a fresh
customer-facing authorization. A real production integration of this exact
idea would need one of:

- **Razorpay Subscriptions**, with a real tokenized mandate captured at
  signup — a materially larger integration (real subscription plans, real
  customers, a consent-capture flow) than a hackathon build can responsibly
  stand up and demo safely, and out of scope here.
- **A fresh Payment Link per retry**, which is exactly what the `PAYMENT_LINK`
  action already does — meaning `RETRY_NOW`/`RETRY_LATER` are not silently
  broken alternatives to `PAYMENT_LINK`, they are the model's own more
  conservative choice: try again later without spending the customer's
  attention (a WhatsApp nudge or a link) yet, which the EV math prices lower
  in intervention cost for exactly that reason (`SUBSCRIPTION_DEFAULT_POLICY`
  prices their `interventionCost` at ₹0, booking only the real ₹2 gateway fee
  — `src/domain/scenario/subscription.ts`).

**What is real here, and was already built before this review, not after:**
`src/app/worker/schedule-followup.ts` schedules a genuine future re-evaluation
— a new synthetic-but-real-shaped webhook event, drained through the identical
`processEvent` pipeline a live delivery uses, at the real +2h/+24h spacing
SYSTEM_SPEC.md §14's stopping rule names. That re-evaluation can itself
choose `PAYMENT_LINK` and create a real Payment Link, or escalate, or stop.
`RETRY_NOW`/`RETRY_LATER`'s real substance is *that they drive a second real
decision cycle*, not that they silently move money on the first one — a
materially different, smaller, and more honest claim than "this recovers
money automatically," and the one this project can actually stand behind.

## What would change this

If this project ever integrates Razorpay Subscriptions for real (tokenized
mandate at signup), `RETRY_NOW` should call the real subscription-retry API
directly, and this ADR should be superseded, not silently forgotten.

---

## Update, 2026-08-28 — the mandate was obtained, and it changed nothing

This ADR ended with a promise: *"If this project ever integrates Razorpay Subscriptions
for real (tokenized mandate at signup), `RETRY_NOW` should call the real subscription-retry
API directly, and this ADR should be superseded, not silently forgotten."*

That was attempted properly rather than left as a hypothetical. A real mandate was
registered. The charge still cannot be made. **The token was never the binding
constraint**, which means the reasoning above was incomplete even though its conclusion
was right.

### What was done

1. **Probed which surfaces the account actually has** (`npm run probe:razorpay`,
   read-only). Plans, Subscriptions and Customers all return `200`, so a mandate is
   reachable — the precondition this ADR names.

2. **Established which rails can carry one.** `/v1/preferences` — the endpoint Checkout
   itself calls to decide which buttons to render — reports `recurring: {card, emandate,
   nach}` and **`upi: false`**. UPI Autopay is not enabled on this account at all, so the
   "UPI Autopay" route this ADR gestures at was never available here.

3. **Card mandate registration failed, twice, inside Razorpay.** Both attempts reached
   `error_step: card_mandate_process` with `error_source: internal` and
   `error_code: SERVER_ERROR` (`pay_TVHZCe4VMNepha`, `pay_TVHcrk8T00jpYt`). The card and
   the OTP were both accepted; the step that failed was Razorpay registering the mandate.
   Not a payload problem and not user error.

4. **Bank e-mandate registration succeeded.** Via
   `POST /v1/subscription_registration/auth_links` with `method: emandate`,
   `auth_type: netbanking`, authorised through test mode's mock bank page
   (`inv_TVHebxkv2NDdt8`, `pay_TVHhhz3Sj8p6D7`, status `captured`). It produced a genuine
   recurring token:

   ```
   token_TVHhiAaRWtRKqZ
     method      emandate
     recurring   true
     auth_type   netbanking
     max_amount  100000   (₹1,000)
   ```

   This is exactly the object whose absence this ADR blamed.

5. **With that token in hand, the server-initiated charge was attempted** against
   `POST /v1/payments/create/recurring`, with a real order (`order_TVHjKpAjb0M8dV`, ₹499,
   under the mandate cap).

### The result, and why it is not a payload mistake

The endpoint **validates the request in full** before refusing it. Sent incrementally, it
walks the payload honestly:

| Request | Response |
|---|---|
| `{}` | `The amount field is required.` |
| `{amount}` | `The currency field is required.` |
| full payload, no `method` | `The requested URL was not found on the server.` |
| full payload, `method: emandate` | `The bank field is required when method is emandate.` |
| full payload, `method: emandate`, `bank: HDFC` | **`The requested URL was not found on the server.`** |

So the route exists, parses, and enforces its own field contract — and then, once the
payload is complete and there is nothing left to complain about, returns a `404`-shaped
`BAD_REQUEST_ERROR` with `source: internal`. Deterministic: 3 identical attempts, 3
identical responses, and **no payment object was created by any of them**.

That is the same signature this ADR already recorded for `POST /v1/payments/create/upi`,
and `/v1/payments/create/json` returns it too. Meanwhile `POST /v1/payment_links` returns
`200` on the identical credentials, so this is not an authentication or account-health
problem. It is the S2S/Seamless payment-creation family being unprovisioned, and it
persists **after** a valid mandate exists.

### What this actually establishes

The original decision stands, but the reason changes:

- **Was argued:** `RETRY_NOW` cannot charge because this project's one-time
  `payment.failed` path has no token to charge against.
- **Is now known:** obtaining a token does not help. This account cannot initiate a
  server-side charge at all, mandate or no mandate, because the endpoints that would do
  it are not enabled for it.

The distinction matters. Razorpay itself *can* charge this mandate — Subscriptions' own
dunning would do it on schedule, which is why the mandate is a real, useful object. What
is unavailable is **this system deciding when that charge happens**, which is precisely
what `RETRY_NOW` would need to be more than a scheduled re-evaluation. A recovery engine
whose retry timing is chosen by the payment processor rather than by its own expected-value
calculation is not the thing this project claims to be.

### What would change it now

Narrower and more concrete than the original list, because three of its four unknowns are
now settled:

- **S2S/Seamless enabled on the account by Razorpay.** This is the single remaining
  blocker, it is an account-provisioning decision rather than an integration task, and it
  is not something a hackathon test account is granted.
- Everything else — Subscriptions access, a supported rail, a registered recurring token
  — is already in place and demonstrably insufficient on its own.

The mandate and token are deliberately left registered on the test account rather than
cleaned up, so this finding can be re-checked rather than taken on trust.
