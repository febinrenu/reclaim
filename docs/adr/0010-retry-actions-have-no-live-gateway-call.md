# ADR 0010 — RETRY_NOW and RETRY_LATER have no live payments-side call, investigated not assumed

**Status:** Accepted. **Date:** 2026-08-26.

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
