"""
The incumbent collections heuristic and its epsilon-greedy logging policy —
B2B's own instance of BUILD_PLAN.md §6.2 Trap 2, independent of subscription's
`scripts/data/logging_policy.py`. `h(s)` is a real, sensible policy a
collections team might actually run; every logged row carries its exact
propensity, which is what keeps the D8-style off-policy estimate unbiased
without estimating the logging policy from data.
"""
from .common import ACTIONS

N_ACTIONS = len(ACTIONS)
EPSILON = 0.20
GREEDY_MASS = 1.0 - EPSILON  # 0.80


def heuristic_action(amount_paise: int, ontime_rate: float, chase_round: int, days_overdue: float) -> str:
    if amount_paise < 5_000_00 and ontime_rate < 0.30:
        return "WRITE_OFF"  # not worth chasing a small invoice from an unreliable payer
    if days_overdue <= 15 and chase_round == 0:
        return "SEND_REMINDER"
    if days_overdue <= 30:
        return "OFFER_PAYMENT_PLAN"
    return "ESCALATE_COLLECTIONS"


def propensity_of(action: str, h_action: str) -> float:
    """pi0(a|s) = 0.80 * 1{a = h(s)} + 0.20/4. Minimum propensity 0.05 by
    construction, so the maximum importance weight for off-policy evaluation is
    exactly 20."""
    base = EPSILON / N_ACTIONS
    return base + (GREEDY_MASS if action == h_action else 0.0)


def draw_action(rng, amount_paise: int, ontime_rate: float, chase_round: int, days_overdue: float) -> tuple[str, float]:
    h = heuristic_action(amount_paise, ontime_rate, chase_round, days_overdue)
    if rng.random() < GREEDY_MASS:
        action = h
    else:
        action = ACTIONS[rng.integers(0, N_ACTIONS)]
    return action, propensity_of(action, h)
