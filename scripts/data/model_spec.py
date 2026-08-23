"""
The shipped recovery scorer's exact feature vector (BUILD_PLAN.md §6.2): thirteen
shared features, five action dummies with DO_NOTHING as the reference level, and
seven hand-picked action interactions — about 25 coefficients, one model rather than
six.

This module is the single source of truth for `MODEL_FEATURE_ORDER` and how a
(feature-dict, action) pair becomes a row. `train_scorer.py` uses it to build the
training design matrix. The identical logic, ported by hand, lives in
`src/domain/scoring/recovery-model.ts` — the golden vectors this module writes into
`recovery_model.json` are what proves the two stayed in sync (BUILD_PLAN.md §6.8),
not an assumption that a hand port was done correctly.

`FEATURE_ORDER` aligned arrays, not `Object.entries` key order, are the whole point
here (§6.8's bug #2) — `MODEL_FEATURE_ORDER` is an explicit, ordered list and every
row this module produces is a plain list in that exact order.
"""
from __future__ import annotations

from .common import ACTIONS, FEATURE_ORDER

ACTION_DUMMY_ACTIONS = [a for a in ACTIONS if a != "DO_NOTHING"]  # 5 actions, in ACTIONS order
ACTION_DUMMY_COLUMNS = [f"action_{a}" for a in ACTION_DUMMY_ACTIONS]

# (column name, action it activates for, base feature it multiplies). Hand-picked
# per BUILD_PLAN.md §6.2 — each pairs an action with the feature most plausibly
# specific to why *that* action works or doesn't.
INTERACTION_SPECS = [
    ("RETRY_NOW_x_is_soft_decline", "RETRY_NOW", "is_soft_decline"),
    ("RETRY_LATER_x_is_insufficient_funds", "RETRY_LATER", "is_insufficient_funds"),
    ("PAYMENT_LINK_x_amount_zscore", "PAYMENT_LINK", "amount_zscore"),
    ("WHATSAPP_NUDGE_x_contacts_last_7d", "WHATSAPP_NUDGE", "contacts_last_7d"),
    ("ESCALATE_HUMAN_x_retry_count_so_far", "ESCALATE_HUMAN", "retry_count_so_far"),
    ("RETRY_NOW_x_bank_recent_fail_rate", "RETRY_NOW", "bank_recent_fail_rate"),
    ("PAYMENT_LINK_x_prior_success_rate", "PAYMENT_LINK", "prior_success_rate"),
]

MODEL_FEATURE_ORDER = list(FEATURE_ORDER) + list(ACTION_DUMMY_COLUMNS) + [s[0] for s in INTERACTION_SPECS]


def build_row(features: dict, action: str) -> list[float]:
    """One row, in `MODEL_FEATURE_ORDER` order, for a single (state, action) pair."""
    row = [float(features[f]) for f in FEATURE_ORDER]
    for dummy_action in ACTION_DUMMY_ACTIONS:
        row.append(1.0 if action == dummy_action else 0.0)
    for _, interaction_action, base_feature in INTERACTION_SPECS:
        row.append(float(features[base_feature]) if action == interaction_action else 0.0)
    return row
