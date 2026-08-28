# ADR 0011 — Smart Collect is the right rail for the B2B scenario, and this account cannot have it

**Status:** Accepted. **Date:** 2026-08-28.

## Context

The B2B receivables scenario (`src/domain/scenario/b2b-receivable.ts`) chases overdue
invoices. Razorpay has a product built for exactly that — **Smart Collect**, which issues a
per-customer or per-invoice virtual bank account and UPI ID, so an inbound payment
auto-reconciles to the right invoice without anyone matching a UTR by hand.

A strict review of this project raised it directly: the second scenario is *receivables*,
and it does not use Razorpay's receivables product. That is a fair criticism, and it is the
kind of gap worth closing because it would deepen the integration rather than add a
feature — the scenario already models invoices, ageing, and partial recovery.

So it was attempted, following the same rule as ADR 0010: ask the account rather than read
the docs and assume.

## What was actually tried

Against the real test-mode credentials, `2026-08-28`:

| Request | Result |
|---|---|
| `GET /v1/virtual_accounts?count=1` | `BAD_REQUEST_ERROR` — *"The requested URL was not found on the server."* |
| `POST /v1/virtual_accounts` with a valid `receivers` body | `BAD_REQUEST_ERROR` — *"The requested URL was not found on the server."* |
| `POST /v1/payment_links` (control, same credentials) | `200` |
| `GET /v1/payments/downtimes` (control, same credentials) | `200`, 15 records |

A list endpoint returning a 404-shaped error while two other endpoints answer normally on
the identical credentials is not an authentication problem, a payload problem, or an
account-health problem. Smart Collect is simply not provisioned for this account.

This is the same signature ADR 0010 recorded for `POST /v1/payments/create/upi` and, after
a real mandate was registered, for `POST /v1/payments/create/recurring`.

## Decision

The B2B scenario continues to run through its own additive pipeline
(`src/app/b2b/process-invoice-event.ts`) rather than through Smart Collect virtual
accounts, **because the product is unavailable to this account**, not because the fit was
misjudged. Smart Collect remains the correct answer for a production build of this idea and
should be the first thing added if the account is ever enabled for it.

What the scenario does instead is unchanged and stands on its own: a real invoice event
runs through the real `decide()`, against real database state, producing a real
`transactions` row, a real `action_attempts` intent, and a real `recovery_audit` row,
reusing the atomic cap-safe `incrementRetryCount` and the same `webhook_events`-backed
idempotency authority as the subscription path.

## What is deliberately *not* claimed

That this is equivalent to Smart Collect. It is not. Without virtual accounts there is no
automatic reconciliation of an inbound bank transfer to a specific invoice, which is the
single most valuable thing Smart Collect does and the thing a real receivables operator
would care about most. The gap is real; it is a provisioning constraint rather than a
design choice, and saying so is more useful than working around it and implying parity.

## What would change this

Smart Collect enabled on the account by Razorpay. It is an account-provisioning decision
rather than an integration task — the same class of blocker as ADR 0010's S2S gate, and
not something a hackathon test account is granted.

Re-checkable at any time with `npm run probe:razorpay`, which now includes the
`virtual_accounts` surface for exactly this reason: the answer is a property of the
account and can change, so it deserves a command rather than a paragraph.
