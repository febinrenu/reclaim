"""
The B2B receivables chaser's shipped recovery scorer feature vector — its own
instance of BUILD_PLAN.md §6.2's "one model with action features" design, nine
shared features, three action dummies (WRITE_OFF as the reference level,
matching its role as the null action), and three hand-picked interactions.

`FEATURE_ORDER` aligned arrays, not `Object.entries` key order, for the exact
same reason `scripts/data/model_spec.py`'s own docstring gives (BUILD_PLAN.md
§6.8's bug #2) — the golden vectors this module's caller writes into
`recovery_model.json` are what proves the hand-ported TypeScript
(`src/domain/scenario/b2b-receivable-model.ts`) stayed in sync.
"""
from __future__ import annotations

from .common import ACTIONS, FEATURE_ORDER

ACTION_DUMMY_ACTIONS = [a for a in ACTIONS if a != "WRITE_OFF"]  # 3 actions, in ACTIONS order
ACTION_DUMMY_COLUMNS = [f"action_{a}" for a in ACTION_DUMMY_ACTIONS]

# (column name, action it activates for, base feature it multiplies).
INTERACTION_SPECS = [
    ("SEND_REMINDER_x_days_overdue", "SEND_REMINDER", "days_overdue"),
    ("OFFER_PAYMENT_PLAN_x_customer_ontime_rate", "OFFER_PAYMENT_PLAN", "customer_ontime_rate"),
    ("ESCALATE_COLLECTIONS_x_chase_rounds_so_far", "ESCALATE_COLLECTIONS", "chase_rounds_so_far"),
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
