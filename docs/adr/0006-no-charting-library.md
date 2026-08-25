# ADR 0006 — No charting library; hand-rolled SVG and plain divs

**Status:** Accepted. **Date:** 2026-08-25 (D10).

## Context

D9 and D10 need several visualisations: the reliability curve and prediction
histogram on `/model`, and the EV explorer's component bars on `/audit`. A charting
library (Recharts, Chart.js, D3, Nivo) is the default reach for any of these.

## Decision

None. `/model`'s reliability curve and histogram (`app/model/calibration-chart.tsx`)
are hand-written inline SVG — axes, points, error-bar whiskers, and histogram bars all
computed directly from `recovery_model.json`'s `calibration_bins`/`prediction_histogram`
fields. The EV explorer's component bars (`app/audit/ev-explorer.tsx`) are plain
proportionally-widthed `<div>`s, the same pattern the D1 homepage's test-coverage bar
chart already used.

## Rationale

BUILD_PLAN.md's own risk table names "dashboard scope creep eating D9 and D10" as a
named, medium-severity risk, with the explicit mitigation "Server Components, plain
tables, Tailwind, and roughly 120 lines of hand-rolled SVG. No charting library on the
critical path. The EV explorer is worth more than any animation." A charting library
adds a real dependency, a client-bundle cost, and — for the reliability curve
specifically — a translation layer between the exact bin data `train_scorer.py`
computed and whatever shape the library's own API wants, which is one more place for
the static PNG (`docs/calibration_recovery_v1.png`) and the in-app SVG to silently
drift apart if the two ever compute the bins differently. Reading `calibration_bins`
directly and drawing points/whiskers by hand means both consumers of that field
(matplotlib on the Python side, this SVG on the TypeScript side) are reading the exact
same committed numbers, not two independently-derived approximations of them.

## Consequence

Every chart in this project is capped at what plain SVG primitives and CSS can express
— no smooth interpolation, no built-in tooltips, no animation. `app/audit/ev-explorer.tsx`
and `app/model/calibration-chart.tsx` both also render the identical data as a plain
`<table>` beneath the visual (BUILD_PLAN.md §3.8: "every chart needs the same data
reachable as a table"), which the hand-rolled approach makes close to free — the same
array that drives the SVG also drives the table rows, with no library-specific
data-table plugin needed to keep the two in sync.
