"""
The six-policy bracket (BUILD_PLAN.md §6.5), as a per-row chosen-action function.
B0, B1, B3 are static; `reclaim_action` is a direct Python port of `decide()`
(`src/domain/decide.ts`) restricted to what the offline demo split can see: the
risk gate (`src/domain/risk/rules.ts`'s weighted rule sum, same weights and
threshold as `DEFAULT_RISK_RULES`/`SUBSCRIPTION_DEFAULT_POLICY`), the retry-count
stopping rule, and argmax-by-EV with the same left-to-right, strict-`>` tie-break
(property P5). Contact capability and opt-out are not modelled here — the demo
split carries no such column, so every contact action is treated as available,
matching `ALL_CAPABLE` in `src/app/worker/process-event.ts`. B2 (sequential) and B5
(oracle) are not chosen-action functions at all: BUILD_PLAN.md §6.4 is explicit
that single-step importance weighting is invalid for a sequential policy, so both
are evaluated directly against the oracle counterfactuals in `run_ope.py`, not
through this module.
"""
from __future__ import annotations

from .common import ACTIONS
from .reward import reward_paise
from .q_hat import p_recover

ACTIONS_SET = set(ACTIONS)

# Mirrors DEFAULT_RISK_RULES (src/domain/risk/rules.ts).
RISK_WEIGHTS = {
    "geo_mismatch": 0.2,
    "card_velocity_high": 0.35,
    "amount_far_above_history": 0.15,
    "card_first_seen_recently": 0.3,
}
RISK_THRESHOLD = 0.5  # SUBSCRIPTION_DEFAULT_POLICY.riskThreshold
MAX_RETRIES = 3  # SUBSCRIPTION_DEFAULT_POLICY.maxRetries
NULL_ACTION = "DO_NOTHING"
ESCALATION_ACTION = "ESCALATE_HUMAN"
CONTACT_ACTIONS = {"PAYMENT_LINK", "WHATSAPP_NUDGE"}


def risk_score(row) -> float:
    return sum(w for key, w in RISK_WEIGHTS.items() if bool(row[key]))


def risk_gated(row) -> bool:
    return risk_score(row) >= RISK_THRESHOLD


def b0_do_nothing(row, model) -> str:
    return NULL_ACTION


def b1_retry_everything(row, model) -> str:
    return "RETRY_NOW"


def b3_nudge_everything(row, model) -> str:
    return "WHATSAPP_NUDGE"


def reclaim_action(row, model, features: dict) -> str:
    """Ports `decide()`'s allowed-set + argmax exactly (BUILD_PLAN.md §6.1/§6.5),
    restricted to the signals available offline: no opt-out/capability/shock-
    suppression columns in the demo split, so every action is contact-available and
    unsuppressed here, matching `ALL_CAPABLE` in the live worker."""
    stopping_rule_hit = row["retry_count_so_far"] >= MAX_RETRIES or risk_gated(row)
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
        # Reclaim's own EV uses the standard intervention-cost table, not B1's ₹2
        # gateway-fee assumption — this is `q̂(s, a)` in expectation form, not a
        # single realised draw, which is valid for the same reason `computeEv` in
        # `src/domain/ev.ts` is: reward is linear in the recovery indicator.
        ev = reward_paise(action, p, row["amount_paise"], row["contacts_last_7d"], row["ltv_amount_paise"])
        if best_ev is None or ev > best_ev:
            best_ev, best_action = ev, action
    assert best_action is not None
    return best_action
