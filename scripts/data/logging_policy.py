"""
The incumbent operations heuristic and its epsilon-greedy logging policy
(BUILD_PLAN.md §6.2 Trap 2). `h(s)` is a real, sensible policy — beating it later is a
real result, not a straw man — and every action gets a recorded, exactly-known
propensity, which is what makes the doubly-robust off-policy estimate (D8) unbiased
without having to *estimate* the logging policy from data.
"""
from .common import ACTIONS

N_ACTIONS = len(ACTIONS)
EPSILON = 0.20
GREEDY_MASS = 1.0 - EPSILON  # 0.80


def heuristic_action(amount_paise: int, prior_success_rate: float, retry_index: int,
                      is_soft_decline: bool, is_insufficient_funds: bool) -> str:
    if amount_paise < 200_00 and prior_success_rate < 0.30:
        return "DO_NOTHING"
    if retry_index == 0 and is_soft_decline:
        return "RETRY_NOW"
    if retry_index == 0 and is_insufficient_funds:
        return "RETRY_LATER"
    if amount_paise > 5_000_00:
        return "PAYMENT_LINK"
    if retry_index >= 2:
        return "ESCALATE_HUMAN"
    return "WHATSAPP_NUDGE"


def propensity_of(action: str, h_action: str) -> float:
    """π0(a|s) = 0.80 * 1{a = h(s)} + 0.20/6. Minimum propensity 0.0333 by
    construction, so the maximum importance weight for off-policy evaluation is
    exactly 30 — weight clipping at 30 is therefore a provable no-op, not a variance
    hack that needs defending (BUILD_PLAN.md §6.2)."""
    base = EPSILON / N_ACTIONS
    return base + (GREEDY_MASS if action == h_action else 0.0)


def draw_action(rng, amount_paise: int, prior_success_rate: float, retry_index: int,
                 is_soft_decline: bool, is_insufficient_funds: bool) -> tuple[str, float]:
    """Returns (action, propensity_of_that_action). Positivity holds by
    construction: every action has propensity >= 0.20/6 > 0 in every state."""
    h = heuristic_action(amount_paise, prior_success_rate, retry_index, is_soft_decline, is_insufficient_funds)
    if rng.random() < GREEDY_MASS:
        action = h
    else:
        action = ACTIONS[rng.integers(0, N_ACTIONS)]
    return action, propensity_of(action, h)
