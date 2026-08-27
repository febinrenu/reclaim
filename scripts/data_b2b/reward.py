"""
The off-policy reward for the B2B receivables scenario, in integer paise —
the same shape as `scripts/data/reward.py`:

    r_i = y_i * amount_i - InterventionCost(a_i) - ContactFatigueCost(s_i, a_i)

`INTERVENTION_COST_PAISE` mirrors `B2B_DEFAULT_POLICY.interventionCost`
(`src/domain/scenario/b2b-receivable.ts`). `CHURN_HAZARD_BY_CONTACTS` is
`src/domain/scenario/types.ts`'s own constant — genuinely scenario-agnostic,
reused by both scenarios' real `computeEv`, so reused here unmodified rather
than re-derived. The one real judgment call: B2B has no `ltv_amount_paise`
column (customers.csv's own field is `typical_invoice_paise` — this scenario
has no subscription-style recurring-revenue concept), so this scores contact
fatigue against a customer's typical invoice size instead, the closest real
proxy for "what a churned relationship is worth losing" this dataset actually
has. `contacts_last_14d` (not `_7d`) is B2B's own window — see
`b2b-live-features.ts`'s `CONTACTS_WINDOW_DAYS` and
`process-invoice-event.ts`'s `contactsLast7d: features.contacts_last_14d`
field reuse in the live decision input, which this mirrors for consistency.
"""
from __future__ import annotations

# Mirrors B2B_DEFAULT_POLICY.interventionCost (src/domain/scenario/b2b-receivable.ts).
INTERVENTION_COST_PAISE = {
    "SEND_REMINDER": 20,
    "OFFER_PAYMENT_PLAN": 75,
    "ESCALATE_COLLECTIONS": 7500,
    "WRITE_OFF": 0,
}

# src/domain/scenario/types.ts's CHURN_HAZARD_BY_CONTACTS, indexed by
# clamp(contacts_last_14d, 0, 3) — scenario-agnostic, not re-derived.
CHURN_HAZARD_BY_CONTACTS = [0.0005, 0.002, 0.004, 0.008]

CONTACT_FATIGUE_ACTIONS = {"SEND_REMINDER", "OFFER_PAYMENT_PLAN"}


def churn_hazard(contacts_last_14d: float) -> float:
    idx = min(max(int(contacts_last_14d), 0), len(CHURN_HAZARD_BY_CONTACTS) - 1)
    return CHURN_HAZARD_BY_CONTACTS[idx]


def contact_fatigue_cost_paise(action: str, contacts_last_14d: float, typical_invoice_paise: float) -> float:
    if action not in CONTACT_FATIGUE_ACTIONS:
        return 0.0
    return typical_invoice_paise * churn_hazard(contacts_last_14d)


def reward_paise(
    action: str,
    outcome: int,
    amount_paise: float,
    contacts_last_14d: float,
    typical_invoice_paise: float,
) -> float:
    """`outcome` is a 0/1 realised (or oracle-counterfactual) recovery indicator."""
    gain = outcome * amount_paise
    cost = INTERVENTION_COST_PAISE[action]
    fatigue = contact_fatigue_cost_paise(action, contacts_last_14d, typical_invoice_paise)
    return gain - cost - fatigue
