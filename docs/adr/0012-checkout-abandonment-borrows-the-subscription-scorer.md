# ADR 0012 — Checkout abandonment reuses the subscription scorer, and is therefore uncalibrated

**Status:** Accepted. **Date:** 2026-08-29.

## Context

Track 03's own scope statement names three inputs: *"from payment failures and checkout
abandonment to overdue receivables."* This project covered the first and third and not the
second, which a strict review flagged as the one part of the track's stated scope with zero
coverage.

Adding it is attractive precisely because it should be cheap: if the decision engine is
genuinely a general `(input, policy, scenario) -> decision`, a third input shape ought to
need configuration rather than code. That claim was worth testing rather than asserting.

## Decision

`CHECKOUT_SCENARIO` (`src/domain/scenario/checkout.ts`) is a **restriction of the
subscription scenario, not a new one**. It spreads `SUBSCRIPTION_SCENARIO` and changes two
things:

- **The action menu loses `RETRY_NOW` and `RETRY_LATER`.** An abandoned checkout is an
  order that was created and never charged, so there is no attempt to retry. This is the
  substantive difference, not a cosmetic one: both actions cost ₹0, so leaving them in the
  menu would let the argmax pick a literal no-op over a real intervention. Removing them
  from `actions` is the correct lever because `decide()` maps over exactly that array —
  `capabilityAvailable` would not work, since it only gates actions where `requiresContact`
  is true.
- **The policy sets its own `maxRetries`**, counting *chases* rather than charge attempts.

Everything else — the model, the feature order, `buildModelRow`, the risk rules, the cost
table — is reused by identity, and a unit test asserts that with `toBe` rather than
`toEqual` so a future divergence is caught rather than absorbed.

The pipeline (`src/app/checkout/process-abandoned-checkout.ts`) is additive in the same way
`src/app/b2b/process-invoice-event.ts` is: it reuses `decide()`, the live feature builder,
the live risk signals, the `webhook_events` idempotency authority, the audit trail, the
cap-safe `incrementRetryCount`, and the operator escalation queue. No existing code path
changed to accommodate it.

## The limitation, stated plainly

**The recovery scorer was trained on payment failures, and this scenario borrows it.**

Its features describe a declined charge — `is_soft_decline`, `bank_recent_fail_rate`,
`retry_count_so_far`. An abandoned checkout has no decline, no bank response, and no
retries. So `P(recover | state, action)` here is **an estimate from a model applied to a
distribution it was not trained on, and it is not calibrated for this one.**

Consequences, accepted deliberately:

- **No calibration number is reported for checkout abandonment**, anywhere. There is no
  reliability curve, no Brier score, no ECE. Producing one would require held-out
  abandonment outcomes, which this project does not have and did not generate.
- **No off-policy evaluation number either.** The OPE bracket covers subscription and B2B
  receivables, both of which have their own trained scorer and their own oracle
  counterfactuals. Checkout abandonment has neither, so it appears in no results table.
- **The EV figures this scenario produces are internally consistent and externally
  unvalidated.** They price actions correctly *given* the probability; the probability is
  the part not standing on evidence here.

## Why ship it anyway

Because the claim it supports is a different one, and that claim is true: **the decision
machinery generalises to a third input shape without modification.** The EV arithmetic, the
risk gate, the stopping rule, the contact-fatigue penalty, the audit trail, the idempotency
authority and the escalation queue all work unchanged on an input they were not written
for. That is worth demonstrating, and it is demonstrated honestly as long as nobody reads
it as "and the probabilities are trustworthy too."

The alternative — generating a fourth synthetic dataset and training a fourth scorer — would
produce a calibration number, and that number would measure this project's ability to fit
its own generator rather than anything about real abandoned carts. `docs/EVALUATION.md`
spends its opening section on exactly that trap. A borrowed scorer with a loud caveat is
more honest than a bespoke one with a flattering metric.

## What would change this

Real abandoned-checkout outcomes — which orders eventually converted, and after which
intervention. That is observational data a live merchant has and this project does not.
With it, the scenario gets its own scorer, its own calibration curve, and a row in the
results tables. Until then, the caveat above is repeated in the scenario's own docstring,
in the pipeline's docstring, and in the README, because it is the kind of thing that gets
quietly dropped as a project grows.
