"""
The D8 off-policy reward, in integer paise (BUILD_PLAN.md §6.4):

    r_i = y_i * amount_i - InterventionCost(a_i) - ContactFatigueCost(s_i, a_i)

This is deliberately a smaller formula than `src/domain/ev.ts`'s `computeEv` — no
`computeCost` (still zero for every action pre-language-layer-cost-accounting) and
no `riskPenalty` (the risk gate is a hard feasibility constraint on the *policy*
being evaluated, not a term subtracted from a realised reward). `INTERVENTION_COST_PAISE`
and `CHURN_HAZARD_BY_CONTACTS` are the exact numbers `src/domain/scenario/subscription.ts`
and `src/domain/scenario/types.ts` ship, kept here as plain paise integers rather than
re-deriving `MilliPaise` arithmetic that this evaluation script has no parity
contract with.
"""
from __future__ import annotations

# Mirrors SUBSCRIPTION_DEFAULT_POLICY.interventionCost (src/domain/scenario/subscription.ts).
INTERVENTION_COST_PAISE = {
    "RETRY_NOW": 0,
    "RETRY_LATER": 0,
    "PAYMENT_LINK": 35,
    "WHATSAPP_NUDGE": 35,
    "ESCALATE_HUMAN": 4000,
    "DO_NOTHING": 0,
}

# Mirrors CHURN_HAZARD_BY_CONTACTS (src/domain/scenario/types.ts), indexed by
# clamp(contacts_last_7d, 0, 3).
CHURN_HAZARD_BY_CONTACTS = [0.0005, 0.002, 0.004, 0.008]

CONTACT_FATIGUE_ACTIONS = {"WHATSAPP_NUDGE", "PAYMENT_LINK"}

# B1's own assumption (BUILD_PLAN.md §6.5): "retry once, immediately, everything"
# costs a real ₹2 gateway fee per attempt, on top of the usual (zero) RETRY_NOW
# intervention cost. Not applied to any other policy's RETRY_NOW.
B1_GATEWAY_FEE_PAISE = 200


def churn_hazard(contacts_last_7d: float) -> float:
    idx = min(max(int(contacts_last_7d), 0), len(CHURN_HAZARD_BY_CONTACTS) - 1)
    return CHURN_HAZARD_BY_CONTACTS[idx]


def contact_fatigue_cost_paise(action: str, contacts_last_7d: float, ltv_amount_paise: float) -> float:
    if action not in CONTACT_FATIGUE_ACTIONS:
        return 0.0
    return ltv_amount_paise * churn_hazard(contacts_last_7d)


def reward_paise(
    action: str,
    outcome: int,
    amount_paise: float,
    contacts_last_7d: float,
    ltv_amount_paise: float,
    extra_intervention_cost_paise: float = 0.0,
) -> float:
    """`outcome` is a 0/1 realised (or oracle-counterfactual) recovery indicator."""
    gain = outcome * amount_paise
    cost = INTERVENTION_COST_PAISE[action] + extra_intervention_cost_paise
    fatigue = contact_fatigue_cost_paise(action, contacts_last_7d, ltv_amount_paise)
    return gain - cost - fatigue
