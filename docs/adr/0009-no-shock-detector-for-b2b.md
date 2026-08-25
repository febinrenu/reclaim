# ADR 0009 — No systemic-shock detector for the B2B scenario

**Status:** Accepted. **Date:** 2026-08-26 (D12).

## Context

SYSTEM_SPEC.md §15's shock detector models one specific failure shape: a shared
payment-gateway or bank-side outage correlated across many otherwise-unrelated card
transactions, detected as a burst of failures sharing a `(bank, errorCode)` pair. B2B
receivables have no payment gateway in the loop at all — an overdue invoice does not
"fail" the way a card charge does, and there is no shared upstream service whose outage
would correlate many customers' invoices going overdue at once.

## Decision

`B2B_DEFAULT_POLICY.shockSuppressedActions` (`src/domain/scenario/b2b-receivable.ts`)
is an empty array. No B2B-specific shock-detection mechanism was built.

## Rationale

The domain-layer mechanism (`decide()`'s `shockSuppressed` check against
`policy.shockSuppressedActions`) already generalizes for free — any scenario can
populate that list, and an empty list is a legitimate, honest answer rather than a gap
that needs a stub filled in. Building a shock detector for B2B would mean inventing a
plausible systemic-correlation story for receivables (a shared macroeconomic shock
across one industry's customers, say) with no real signal in this project's synthetic
data to detect it from, and no equivalent of SYSTEM_SPEC.md's own worked example to
validate against. That is manufacturing a feature to look complete rather than building
one the scenario's own economics call for.

## Consequence

`tests/property/decide.property.test.ts`'s P14 ("a shocked decision is never an
immediate retry, and never beats the unsuppressed EV") is checked against the
subscription scenario only, since B2B has no shocked state to construct one against —
stated here rather than silently generalized without evidence. If a future scenario's
own domain genuinely has a correlated-failure story (a shared logistics-carrier outage
delaying many shipments at once, for a hypothetical e-commerce fulfillment scenario,
say), the mechanism is already there to reuse; this ADR records only that B2B
specifically does not need it, not that no future scenario ever will.
