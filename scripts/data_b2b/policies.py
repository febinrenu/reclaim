"""
The B2B receivables scenario's own policy bracket — a structural port of
`scripts/data/policies.py`, restricted to this scenario's own action
vocabulary and policy constants (`B2B_DEFAULT_POLICY`,
`src/domain/scenario/b2b-receivable.ts`). `reclaim_action` is the same
restricted port of `decide()`'s allowed-set + argmax logic, using this
scenario's own risk gate (same weights/threshold — `DEFAULT_RISK_RULES` is
scenario-agnostic, reused unmodified), stopping rule (`maxRetries = 2`), and
escalation/null actions.
"""
from __future__ import annotations

from .common import ACTIONS
from .reward import reward_paise
from .q_hat import p_recover

ACTIONS_SET = set(ACTIONS)

# src/domain/risk/rules.ts's DEFAULT_RISK_RULES — genuinely scenario-agnostic
# (B2B_RECEIVABLE_SCENARIO.riskRules reuses it verbatim, meanings reinterpreted
# per src/domain/scenario/b2b-receivable.ts's own docstring, weights unchanged).
RISK_WEIGHTS = {
    "geo_mismatch": 0.2,
    "card_velocity_high": 0.35,
    "amount_far_above_history": 0.15,
    "card_first_seen_recently": 0.3,
}
RISK_THRESHOLD = 0.5  # B2B_DEFAULT_POLICY.riskThreshold
MAX_RETRIES = 2  # B2B_DEFAULT_POLICY.maxRetries
NULL_ACTION = "WRITE_OFF"
ESCALATION_ACTION = "ESCALATE_COLLECTIONS"
CONTACT_ACTIONS = {"SEND_REMINDER", "OFFER_PAYMENT_PLAN"}


def risk_score(row) -> float:
    return sum(w for key, w in RISK_WEIGHTS.items() if bool(row[key]))


def risk_gated(row) -> bool:
    return risk_score(row) >= RISK_THRESHOLD


def b0_write_off(row, model) -> str:
    return NULL_ACTION


def b1_remind_everything(row, model) -> str:
    return "SEND_REMINDER"


def b3_offer_plan_everything(row, model) -> str:
    return "OFFER_PAYMENT_PLAN"


def reclaim_action(row, model, features: dict) -> str:
    """Ports `decide()`'s allowed-set + argmax exactly, restricted to what the
    offline demo split can see: no opt-out/capability/shock-suppression
    columns, so every action is contact-available (matching `ALL_CAPABLE` in
    `process-invoice-event.ts`), and B2B never shock-suppresses any action
    (`B2B_DEFAULT_POLICY.shockSuppressedActions` is empty)."""
    stopping_rule_hit = row["chase_rounds_so_far"] >= MAX_RETRIES or risk_gated(row)
    best_action = None
    best_ev = None
    for action in ACTIONS:
        if stopping_rule_hit:
            allowed = action == ESCALATION_ACTION
        else:
            allowed = True
        if not allowed:
            continue
        p = p_recover(model, features, action)
        ev = reward_paise(
            action, p, row["amount_paise"], row["contacts_last_14d"], row["typical_invoice_paise"]
        )
        if best_ev is None or ev > best_ev:
            best_ev, best_action = ev, action
    assert best_action is not None
    return best_action
