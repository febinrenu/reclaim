"""
The escalation-capacity sweep this project's own README named as a gap:
README's unconstrained policy escalates 91.6% of the demo split, and no real
ops team can staff that. This asks the honest follow-up question — if a
merchant can only staff `B` human escalations per day, which `B` events
should get one, and what does net recovery look like as `B` grows from zero
to "everyone who wants one"?

Two rules, both mirroring `src/domain/decide.ts`'s own two-pass design
(`src/app/worker/escalation-budget.ts`'s docstring) rather than inventing a
separate allocation scheme:

  1. **Which events get ranked at all.** Only the events `reclaim_action`
     (the unconstrained policy) already chose to escalate. An event the
     policy was never going to escalate must not compete for a slot — the
     same reservation discipline the live worker path uses.
  2. **How they are ranked.** By `qhat_ESCALATE_HUMAN - qhat_<fallback>` —
     the scorer's own estimated EV uplift of spending a slot here over this
     event's best non-escalation action — never by the oracle outcome. A
     real system has to rank *before* it knows who would actually have paid;
     using the oracle to rank would be hindsight the policy does not have.
     The oracle is used only afterward, to measure what actually happened
     under the resulting allocation — same split of labour as every other
     number in this project: decide with the model, evaluate with the truth.

Usage: `npm run escalation:sweep` (== `python -m scripts.data.escalation_budget_sweep`).
Writes `docs/escalation_budget_results.json`, which `scripts/report.py` turns
into `docs/RESULTS.md`'s capacity-curve table and `/capacity` renders as a chart.
"""
from __future__ import annotations

import json

import numpy as np

from .common import ACTIONS, OUT_DIR
from .q_hat import p_recover
from .reward import reward_paise
from . import policies as pol
from .run_ope import _load, _prepare_rows, _features_of, _oracle_reward_at  # noqa: F401 (shared, not duplicated)

PAISE_PER_RUPEE = 100
NON_ESCALATION_ACTIONS = [a for a in ACTIONS if a != pol.ESCALATION_ACTION]


def fallback_action(row: dict, model: dict, features: dict) -> str:
    """The action `decide()` falls back to when escalation is unavailable —
    a direct port of `resolveAllowed`'s own fallback (src/domain/decide.ts):
    the null action if the stopping rule also fired (nothing else was ever
    allowed), otherwise the argmax over every *other* action."""
    stopping_rule_hit = row["retry_count_so_far"] >= pol.MAX_RETRIES or pol.risk_gated(row)
    if stopping_rule_hit:
        return pol.NULL_ACTION
    best_action = None
    best_ev = None
    for action in NON_ESCALATION_ACTIONS:
        p = p_recover(model, features, action)
        ev = reward_paise(action, p, row["amount_paise"], row["contacts_last_7d"], row["ltv_amount_paise"])
        if best_ev is None or ev > best_ev:
            best_ev, best_action = ev, action
    assert best_action is not None
    return best_action


def main() -> None:
    df, model = _load()
    df = _prepare_rows(df, model)

    rows = df.to_dict("records")
    wants_escalation = [r for r in rows if r["reclaim_action"] == pol.ESCALATION_ACTION]

    slots = []
    for row in wants_escalation:
        features = _features_of(row)
        fallback = fallback_action(row, model, features)
        qhat_uplift_paise = row[f"qhat_{pol.ESCALATION_ACTION}"] - row[f"qhat_{fallback}"]
        slots.append({
            "fallback": fallback,
            "qhat_uplift_paise": qhat_uplift_paise,
            "oracle_escalate_paise": _oracle_reward_at(row, pol.ESCALATION_ACTION),
            "oracle_fallback_paise": _oracle_reward_at(row, fallback),
        })
    # Rank by the model's own estimated uplift, descending — never by the oracle
    # columns above, which exist only to score the allocation afterward.
    slots.sort(key=lambda s: s["qhat_uplift_paise"], reverse=True)

    baseline_oracle_paise = sum(_oracle_reward_at(r, r["reclaim_action"]) for r in rows if r["reclaim_action"] != pol.ESCALATION_ACTION)
    n = len(df)
    n_wants = len(wants_escalation)

    def net_recovery_inr_at(budget: int) -> float:
        escalated = slots[:budget]
        held_back = slots[budget:]
        total_paise = (
            baseline_oracle_paise
            + sum(s["oracle_escalate_paise"] for s in escalated)
            + sum(s["oracle_fallback_paise"] for s in held_back)
        )
        return total_paise / n / PAISE_PER_RUPEE

    # ~40 points across [0, n_wants], plus every exact value near the low end
    # (0-10) where the curve's knee actually is, since that is the part a
    # reader will stare at.
    step = max(1, round(n_wants / 40)) if n_wants > 0 else 1
    budgets = sorted(set([0, *range(0, min(11, n_wants + 1)), *range(0, n_wants + 1, step), n_wants]))

    sweep = []
    for b in budgets:
        net = net_recovery_inr_at(b)
        sweep.append({
            "budget": b,
            "escalated_count": b,
            "escalated_share_of_split": b / n,
            "net_recovery_inr_per_txn": net,
        })

    unconstrained_net_recovery_inr = net_recovery_inr_at(n_wants)
    # How much of the budget-0 -> unconstrained gap does the FIRST b slots close?
    zero_budget_net = net_recovery_inr_at(0)
    total_gap = unconstrained_net_recovery_inr - zero_budget_net
    for point in sweep:
        gap_closed = (point["net_recovery_inr_per_txn"] - zero_budget_net) / total_gap if total_gap > 0 else None
        point["pct_of_unconstrained_gap_closed"] = gap_closed

    # The headline: smallest budget that closes >= 90% / 95% / 99% of the gap.
    thresholds = {}
    for pct in (0.90, 0.95, 0.99):
        hit = next((p for p in sweep if p["pct_of_unconstrained_gap_closed"] is not None and p["pct_of_unconstrained_gap_closed"] >= pct), None)
        thresholds[f"budget_for_{int(pct * 100)}pct_of_gap"] = hit["budget"] if hit is not None else None

    out = {
        "n_events": n,
        "n_events_wanting_escalation_unconstrained": n_wants,
        "unconstrained_escalation_share": n_wants / n,
        "zero_budget_net_recovery_inr_per_txn": zero_budget_net,
        "unconstrained_net_recovery_inr_per_txn": unconstrained_net_recovery_inr,
        "sweep": sweep,
        "knee_thresholds": thresholds,
    }

    out_path = OUT_DIR.parent.parent.parent / "docs" / "escalation_budget_results.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8", newline="\n")

    print(f"\nEscalation-budget sweep — {n} demo events, {n_wants} want escalation unconstrained ({n_wants / n:.1%})\n")
    print(f"{'Budget':<10}{'Escalated':<20}{'Net recovery (Rs/txn)':<26}{'% of gap closed':<16}")
    for p in sweep:
        gap_s = f"{p['pct_of_unconstrained_gap_closed']:.1%}" if p["pct_of_unconstrained_gap_closed"] is not None else "n/a"
        print(f"{p['budget']:<10}{p['escalated_share_of_split']:<20.1%}{p['net_recovery_inr_per_txn']:<26.2f}{gap_s:<16}")
    print(f"\nBudget 0 (never escalate): Rs {zero_budget_net:.2f}/txn")
    print(f"Unconstrained ({n_wants} escalations): Rs {unconstrained_net_recovery_inr:.2f}/txn")
    for k, v in thresholds.items():
        print(f"{k}: {v}")
    print(f"\nWritten: {out_path}")


if __name__ == "__main__":
    main()
