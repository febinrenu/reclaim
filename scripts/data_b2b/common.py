"""
Shared constants for the B2B receivables chaser's synthetic generator
(SYSTEM_SPEC.md §16, BUILD_PLAN.md's D12 row). A second, independent instance
of the same pattern `scripts/data/common.py` establishes for the subscription
scenario — proving the *engine* generalizes (D3-D11's `decide()`, `computeEv`,
`evaluateRisk`, the audit schema) by pointing a second, differently-shaped
dataset at it, not by reusing subscription's own generator or seed.

Reuses `scripts/data/risk.py` directly (the compromised-card-episode /
noisy-signal-emission mechanism is generic enough to reinterpret for
receivables — see this module's own `RISK_SIGNAL_COLUMNS` docstring) rather
than duplicating it: that file is read-only shared infrastructure, not scoped
to the subscription scenario specifically, so importing it does not violate
the "no file touched outside the scenario/features/risk/templates/seeds
directories" discipline this second scenario is judged on — nothing in
`scripts/data/` is ever *modified* for B2B's sake.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "data" / "synthetic" / "b2b_receivable"

# A different epoch and a different seed from the subscription scenario's —
# genuinely independent data, not a relabeled copy.
EPOCH = datetime(2026, 2, 1, tzinfo=timezone.utc)


def hours_to_iso(hours: float) -> str:
    return (EPOCH + timedelta(hours=hours)).isoformat()


SEED = 20260901  # this scenario's own build date, unrelated to subscription's seed

ACTIONS = ["SEND_REMINDER", "OFFER_PAYMENT_PLAN", "ESCALATE_COLLECTIONS", "WRITE_OFF"]
NULL_ACTION = "WRITE_OFF"  # SYSTEM_SPEC.md §16: "plays the same structural role as DO_NOTHING"
ESCALATION_ACTION = "ESCALATE_COLLECTIONS"

# A fictional B2B customer base — smaller than subscription's, matching
# BUILD_PLAN.md §16's "half a day, instantiating an architecture" framing
# rather than repeating D4's full six-month warm-up at the same scale.
N_CUSTOMERS = 40
WARM_UP_MONTHS = 3
OBSERVATION_MONTHS = 4
MAX_CHASE_ROUNDS = 1  # at most 2 automated chase attempts (round 0, round 1) before WRITE_OFF/ESCALATE_COLLECTIONS

SPLIT_MONTHS = {
    "logged_train": (1, 2),
    "logged_calibration": (3, 3),
    "logged_demo": (4, 4),
}
SPLIT_ROW_TARGETS = {"logged_train": 6400, "logged_calibration": 2800, "logged_demo": 2800}
TOTAL_EVENTS = sum(SPLIT_ROW_TARGETS.values())  # 6,000

# Nine receivables-specific features — fewer than subscription's thirteen,
# reflecting a genuinely simpler state (an overdue invoice has less live
# telemetry than a card decline does): days overdue, this customer's own
# on-time-payment history, invoice size relative to that customer's own
# average, how many chase rounds have already happened, whether this is a
# repeat overdue for this customer within the quarter, invoice-age-of-week /
# of-quarter cyclicality (the receivables analogue of hour_sin/hour_cos — B2B
# collections calls cluster around month-end), and how many contacts this
# customer has already had in the trailing 14 days (a longer fatigue window
# than subscription's 7d, since a B2B relationship is chased far less often).
FEATURE_ORDER = [
    "days_overdue",
    "customer_ontime_rate",
    "invoice_size_zscore",
    "chase_rounds_so_far",
    "is_repeat_overdue_this_quarter",
    "quarter_sin",
    "quarter_cos",
    "contacts_last_14d",
    "customer_relationship_days",
]

LOGGED_BOOKKEEPING_COLUMNS = ["event_id", "customer_id", "invoice_id", "event_created_at", "amount_paise", "action", "propensity", "outcome"]

# Reuses scripts/data/risk.py's four signal names verbatim, reinterpreted for
# receivables rather than renamed — RiskInput (src/domain/risk/rules.ts) is a
# fixed four-field interface, so a second scenario reusing the risk gate
# populates the same four fields rather than inventing new ones:
#   geo_mismatch              -> billing-address mismatch on the invoice
#   card_velocity_high        -> unusually many large invoices from this
#                                customer in a short window
#   amount_far_above_history  -> literal meaning unchanged: this invoice is far
#                                above this customer's own historical average
#   card_first_seen_recently  -> this is a newly onboarded customer relationship
RISK_SIGNAL_COLUMNS = ["geo_mismatch", "card_velocity_high", "amount_far_above_history", "card_first_seen_recently"]

BANNED_COLUMN_PATTERN = r"p_true|y_true_|is_truly_risky|would_chargeback"
