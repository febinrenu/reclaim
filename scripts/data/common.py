"""
Shared constants for the synthetic data generator (BUILD_PLAN.md D4).

Every number here that looks arbitrary is explained where it is used, not here —
this module is just the single place they live so `generate.py`, `loader.py`, and
the `eval/` test suite never disagree about them.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "data" / "synthetic" / "subscription"

# A fixed synthetic epoch, not "whenever this was generated" — every regeneration
# from the same seed must produce byte-identical files, which a wall-clock timestamp
# would break. The observation window (see WARM_UP_MONTHS/OBSERVATION_MONTHS below)
# starts at this instant.
EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def hours_to_iso(hours: float) -> str:
    return (EPOCH + timedelta(hours=hours)).isoformat()

SEED = 20260824  # the date this generator was written, not tuned for a nice result

ACTIONS = ["RETRY_NOW", "RETRY_LATER", "PAYMENT_LINK", "WHATSAPP_NUDGE", "ESCALATE_HUMAN", "DO_NOTHING"]
NULL_ACTION = "DO_NOTHING"
ESCALATION_ACTION = "ESCALATE_HUMAN"

BANKS = ["HDFC", "ICICI", "SBI", "AXIS", "KOTAK", "YES"]

# A synthetic taxonomy for the generator only — decoupled from BUILD_PLAN.md C10's
# point that Razorpay's real error_reason values are an open, unverified string.
# This generator never claims to reproduce Razorpay's exact enum; it needs *a*
# plausible, internally-consistent failure taxonomy to drive is_soft_decline /
# is_insufficient_funds in the logging heuristic (BUILD_PLAN.md §6.2 Trap 2).
ERROR_CATEGORIES = ["insufficient_funds", "soft_decline", "hard_decline", "gateway_error", "do_not_honor"]
ERROR_CATEGORY_WEIGHTS = [0.30, 0.25, 0.20, 0.15, 0.10]
# How much heteroskedastic noise (BUILD_PLAN.md §6.2 Trap 1) a category's outcome
# gets, on top of the mean-zero logit noise every event already receives. Harder,
# more heterogeneous decline reasons are less predictable.
DECLINE_HARDNESS = {
    "insufficient_funds": 0.3,
    "soft_decline": 0.3,
    "gateway_error": 0.6,
    "hard_decline": 1.0,
    "do_not_honor": 1.0,
}

N_CUSTOMERS = 60
WARM_UP_MONTHS = 6
OBSERVATION_MONTHS = 6
MAX_RETRY_INDEX = 2  # retry_index in {0, 1, 2} — three attempts, matching maxRetries=3

# The exact per-split row counts BUILD_PLAN.md §6.6 asks for. Splits are temporal,
# by event_created_at falling in the corresponding observation month, never random —
# a random split would put the same customer on both sides and leak as-of features.
SPLIT_MONTHS = {
    "logged_train": (1, 4),        # months 1-4 -> 7,200 rows
    "logged_calibration": (5, 5),  # month 5    -> 2,400 rows
    "logged_demo": (6, 6),         # month 6    -> 2,400 rows
}
SPLIT_ROW_TARGETS = {"logged_train": 7200, "logged_calibration": 2400, "logged_demo": 2400}
TOTAL_EVENTS = sum(SPLIT_ROW_TARGETS.values())  # 12,000

# The 13 shared features D5's recovery scorer will fit against (BUILD_PLAN.md §6.2:
# "thirteen shared features, five action dummies ... about 25 coefficients"). Order
# matters for the eventual FEATURE_ORDER parity contract (BUILD_PLAN.md §6.8) even
# though D4 only needs to emit these columns, not yet fit anything against them.
FEATURE_ORDER = [
    "prior_success_rate",
    "days_since_last_failure",
    "amount_zscore",
    "retry_count_so_far",
    "is_recurring_subscription",
    "hour_sin",
    "hour_cos",
    "bank_recent_fail_rate",
    "contacts_last_7d",
    "ltv_zscore",
    "customer_tenure_days",
    "is_soft_decline",
    "is_insufficient_funds",
]

# Bookkeeping columns the loader also passes through — never fed to the model as a
# feature, but needed to fit and evaluate it (the label, the logged action, and the
# propensity of that action under the logging policy).
LOGGED_BOOKKEEPING_COLUMNS = ["event_id", "customer_id", "transaction_id", "event_created_at", "amount_paise", "action", "propensity", "outcome"]

RISK_SIGNAL_COLUMNS = ["geo_mismatch", "card_velocity_high", "amount_far_above_history", "card_first_seen_recently"]

# Column names that must never appear in a file the recovery-scorer training or
# evaluation pipeline reads. `is_truly_risky` and `would_chargeback` belong to the
# *risk gate's* labelled set (risk_eval_*.csv) and to the oracle file, never to the
# recovery scorer's logged CSVs — see BUILD_PLAN.md §6.3 and eval/test_oracle_firewall.py.
BANNED_COLUMN_PATTERN = r"p_true|y_true_|is_truly_risky|would_chargeback"
