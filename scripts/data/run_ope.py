"""
D8's off-policy evaluation (BUILD_PLAN.md §6.4/§6.5): estimate the value (net
rupees per transaction) of five deterministic-or-behavior policies from
`logged_demo` alone, using the trained recovery scorer as `q_hat`; simulate two
more (B2, B5) directly against the oracle counterfactuals, which single-step
importance weighting cannot validly evaluate; and audit every estimated policy's
error against oracle ground truth it was never allowed to see while estimating.

Usage: `npm run ope` (== `python -m scripts.data.run_ope`). Writes
`docs/ope_results.json` (the numbers `docs/EVALUATION.md`'s D8 section and
`model_evaluations` rows draw from) and prints the bracket table.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .common import ACTIONS, OUT_DIR, SEED
from .q_hat import load_model, p_recover
from .reward import reward_paise, B1_GATEWAY_FEE_PAISE, INTERVENTION_COST_PAISE
from . import policies as pol
from . import ope

PAISE_PER_RUPEE = 100


def _load() -> tuple[pd.DataFrame, dict]:
    demo = pd.read_csv(OUT_DIR / "logged_demo.csv")
    customers = pd.read_csv(OUT_DIR / "customers.csv")[["customer_id", "ltv_amount_paise"]]
    risk = pd.read_csv(OUT_DIR / "risk_eval_demo.csv").drop(columns=["amount_paise", "event_created_at"])
    oracle = pd.read_parquet(OUT_DIR / "oracle_counterfactuals.parquet")

    df = demo.merge(customers, on="customer_id", how="left", validate="many_to_one")
    df = df.merge(risk, on="event_id", how="left", validate="one_to_one")
    df = df.merge(oracle, on="event_id", how="left", validate="one_to_one")
    assert df["ltv_amount_paise"].notna().all(), "every demo row must join a customer"
    assert df["is_truly_risky"].notna().all(), "every demo row must join its oracle counterfactuals"

    model = load_model(OUT_DIR / "recovery_model.json")
    return df, model


def _features_of(row) -> dict:
    return {
        "prior_success_rate": row["prior_success_rate"],
        "days_since_last_failure": row["days_since_last_failure"],
        "amount_zscore": row["amount_zscore"],
        "retry_count_so_far": row["retry_count_so_far"],
        "is_recurring_subscription": row["is_recurring_subscription"],
        "hour_sin": row["hour_sin"],
        "hour_cos": row["hour_cos"],
        "bank_recent_fail_rate": row["bank_recent_fail_rate"],
        "contacts_last_7d": row["contacts_last_7d"],
        "ltv_zscore": row["ltv_zscore"],
        "customer_tenure_days": row["customer_tenure_days"],
        "is_soft_decline": row["is_soft_decline"],
        "is_insufficient_funds": row["is_insufficient_funds"],
    }


def _oracle_reward_at(row, action: str, extra_cost: float = 0.0) -> float:
    y = row[f"y_true_{action}"]
    return reward_paise(action, y, row["amount_paise"], row["contacts_last_7d"], row["ltv_amount_paise"], extra_cost)


def _prepare_rows(df: pd.DataFrame, model: dict) -> pd.DataFrame:
    """One pass over the demo split computing, per row: the realised reward under
    the logged action (`r`), the scorer's q_hat under the logged action
    (`q_logged`, the DR residual anchor), q_hat under every one of the six
    actions (`qhat_<ACTION>`, so any deterministic policy's `q_hat(s, pi(s))` is a
    column lookup), and this row's own feature dict (reused by `reclaim_action`,
    which needs the raw dict, not just the qhat columns)."""
    records = []
    for row in df.itertuples(index=False):
        r = row._asdict()
        features = _features_of(r)
        qhats = {a: p_recover(model, features, a) for a in ACTIONS}
        r["q_logged"] = reward_paise(
            r["action"], qhats[r["action"]], r["amount_paise"], r["contacts_last_7d"], r["ltv_amount_paise"]
        )
        r["r"] = reward_paise(
            r["action"], r["outcome"], r["amount_paise"], r["contacts_last_7d"], r["ltv_amount_paise"]
        )
        for a in ACTIONS:
            r[f"qhat_{a}"] = reward_paise(a, qhats[a], r["amount_paise"], r["contacts_last_7d"], r["ltv_amount_paise"])
        r["reclaim_action"] = pol.reclaim_action(r, model, features)
        records.append(r)
    return pd.DataFrame.from_records(records)


def _evaluate_deterministic(name: str, chosen: np.ndarray, df: pd.DataFrame, rng: np.random.Generator) -> dict:
    logged_action = df["action"].to_numpy()
    propensity = df["propensity"].to_numpy()
    w = ope.importance_weight(chosen, logged_action, propensity)
    q_chosen = _lookup_qhat(df, chosen)
    q_logged = df["q_logged"].to_numpy()
    r = df["r"].to_numpy()

    value_dm = ope.dm(q_chosen)
    value_snips = ope.snips(w, r)
    value_dr = ope.dr(q_chosen, w, r, q_logged)
    value_ess = ope.ess(w)

    def dr_estimator(w, r, q_chosen, q_logged):
        return ope.dr(q_chosen, w, r, q_logged)

    ci_lo, ci_hi = ope.bootstrap_ci(dr_estimator, rng, w=w, r=r, q_chosen=q_chosen, q_logged=q_logged)

    oracle_extra = {"RETRY_NOW": B1_GATEWAY_FEE_PAISE} if name == "B1" else {}
    oracle_value = float(
        np.mean([
            _oracle_reward_at(row, a, oracle_extra.get(a, 0.0))
            for row, a in zip(df.to_dict("records"), chosen)
        ])
    ) / PAISE_PER_RUPEE

    value_dr_inr = value_dr / PAISE_PER_RUPEE
    return {
        "policy": name,
        "estimator": "doubly_robust",
        "value_inr": value_dr_inr,
        "ci_low_inr": ci_lo / PAISE_PER_RUPEE,
        "ci_high_inr": ci_hi / PAISE_PER_RUPEE,
        "dm_inr": value_dm / PAISE_PER_RUPEE,
        "snips_inr": value_snips / PAISE_PER_RUPEE,
        "ess": value_ess,
        "ess_trustworthy": value_ess >= ope.ESS_UNTRUSTWORTHY_BELOW,
        "n": len(df),
        "oracle_value_inr": oracle_value,
        "estimator_error_pct": abs(value_dr_inr - oracle_value) / abs(oracle_value) * 100 if oracle_value != 0 else float("nan"),
    }


def _lookup_qhat(df: pd.DataFrame, chosen: np.ndarray) -> np.ndarray:
    out = np.empty(len(df))
    for a in ACTIONS:
        mask = chosen == a
        out[mask] = df.loc[mask, f"qhat_{a}"].to_numpy()
    return out


def _evaluate_b4_logging_policy(df: pd.DataFrame, rng: np.random.Generator) -> dict:
    """The incumbent heuristic's own logged policy: every row's action WAS drawn
    from it, so its value is the on-policy sample mean of realised reward,
    directly observable from the logs with no importance weighting at all
    (BUILD_PLAN.md §6.5) — the best-anchored number in the whole table."""
    r = df["r"].to_numpy()
    value = float(np.mean(r))
    boot = np.empty(ope.N_BOOTSTRAP)
    n = len(r)
    for b in range(ope.N_BOOTSTRAP):
        idx = rng.integers(0, n, size=n)
        boot[b] = np.mean(r[idx])
    lo, hi = np.percentile(boot, [2.5, 97.5])
    oracle_value = float(np.mean([_oracle_reward_at(row, row["action"]) for row in df.to_dict("records")])) / PAISE_PER_RUPEE
    value_inr = value / PAISE_PER_RUPEE
    return {
        "policy": "B4",
        "estimator": "on_policy_mean",
        "value_inr": value_inr,
        "ci_low_inr": lo / PAISE_PER_RUPEE,
        "ci_high_inr": hi / PAISE_PER_RUPEE,
        "dm_inr": value_inr,
        "snips_inr": value_inr,
        "ess": float(n),
        "ess_trustworthy": True,
        "n": n,
        "oracle_value_inr": oracle_value,
        "estimator_error_pct": abs(value_inr - oracle_value) / abs(oracle_value) * 100 if oracle_value != 0 else float("nan"),
    }


def _evaluate_b5_oracle(df: pd.DataFrame) -> dict:
    def best(row) -> float:
        return max(_oracle_reward_at(row, a) for a in ACTIONS)

    values = [best(row) for row in df.to_dict("records")]
    return {
        "policy": "B5",
        "estimator": "oracle_simulator",
        "value_inr": float(np.mean(values)) / PAISE_PER_RUPEE,
        "ci_low_inr": None,
        "ci_high_inr": None,
        "dm_inr": None,
        "snips_inr": None,
        "ess": None,
        "ess_trustworthy": None,
        "n": len(df),
        "oracle_value_inr": None,
        "estimator_error_pct": None,
        "note": "Oracle-file only, per-event single-decision optimum. Not comparable to an estimator error, it is the ground truth.",
    }


def _evaluate_b2_sequential(df: pd.DataFrame) -> dict:
    """BUILD_PLAN.md §6.4: single-step (SN)IPS/DR is invalid for a sequential
    'retry up to three times, stop on success' policy, so B2 is simulated
    directly against the oracle. Documented limitation: each transaction's
    observed up-to-three-attempt chain reflects the state transitions that
    actually happened under whatever action the logging policy took at each
    step, not a hypothetical all-RETRY_NOW trajectory — a true retry-conditional
    simulation would need the generator itself to emit decayed state under a
    forced RETRY_NOW at every step (BUILD_PLAN.md §6.4's "retry-conditional
    counterfactuals with decay"), which D4 did not build. This uses each observed
    attempt's own state to ask the narrower, still-honest question "if RETRY_NOW
    had been tried instead, at each state that was actually reached," which is a
    first-order approximation, not a validated multi-step simulation. Recorded
    here rather than silently presented as exact."""
    values = []
    for _txn_id, group in df.groupby("transaction_id"):
        group = group.sort_values("retry_count_so_far")
        total = 0.0
        for row in group.to_dict("records"):
            y = row["y_true_RETRY_NOW"]
            total += reward_paise("RETRY_NOW", y, row["amount_paise"], row["contacts_last_7d"], row["ltv_amount_paise"])
            if y == 1:
                break  # stop on success; RETRY_NOW's own intervention cost is zero either way
        values.append(total)
    return {
        "policy": "B2",
        "estimator": "oracle_simulator",
        "value_inr": float(np.mean(values)) / PAISE_PER_RUPEE,
        "ci_low_inr": None,
        "ci_high_inr": None,
        "dm_inr": None,
        "snips_inr": None,
        "ess": None,
        "ess_trustworthy": None,
        "n": df["transaction_id"].nunique(),
        "oracle_value_inr": None,
        "estimator_error_pct": None,
        "note": "Oracle-simulator only, per-transaction retry chain. See docstring: single-step importance weighting is invalid for a sequential policy, and this simulation reuses observed (not re-simulated) state transitions between attempts.",
    }


def main() -> None:
    rng = np.random.default_rng(SEED)
    df, model = _load()
    df = _prepare_rows(df, model)

    results = []
    results.append(_evaluate_deterministic("B0", np.full(len(df), "DO_NOTHING"), df, rng))
    results.append(_evaluate_deterministic("B1", np.full(len(df), "RETRY_NOW"), df, rng))
    results.append(_evaluate_b2_sequential(df))
    results.append(_evaluate_deterministic("B3", np.full(len(df), "WHATSAPP_NUDGE"), df, rng))
    results.append(_evaluate_b4_logging_policy(df, rng))
    results.append(_evaluate_deterministic("Reclaim", df["reclaim_action"].to_numpy(), df, rng))
    results.append(_evaluate_b5_oracle(df))

    by_policy = {r["policy"]: r for r in results}
    v_b4 = by_policy["B4"]["value_inr"]
    v_b5 = by_policy["B5"]["value_inr"]
    v_reclaim = by_policy["Reclaim"]["value_inr"]
    headroom_captured = (v_reclaim - v_b4) / (v_b5 - v_b4) if v_b5 != v_b4 else float("nan")

    # The action mix Reclaim actually chooses on this split, and what running it costs
    # per event. Recorded here rather than computed in the report generator because this
    # is the only place the policy is actually applied to every row -- deriving it a
    # second time elsewhere would be a second implementation that could disagree.
    #
    # `run_cost_paise_per_event` is the operating cost of the system: the intervention
    # cost of whatever it chose, averaged over the split. It is what a merchant pays to
    # run this, and the number the README's unit economics divides the measured uplift
    # by. It deliberately does NOT include the language layer, which is reported
    # separately: batch runs are template-first and cache-hit, so a per-event LLM cost
    # averaged over a batch is close to zero and would flatter the figure.
    action_counts = df["reclaim_action"].value_counts().to_dict()
    run_cost_paise = float(
        sum(INTERVENTION_COST_PAISE[a] * n for a, n in action_counts.items())
    )

    # The same mix broken out by event amount, because the mix turns out to be almost
    # entirely a function of it: a Rs 40 human escalation is 2.7% of a Rs 1,484 event and
    # 27% of a Rs 148 one, so the EV arithmetic reaches opposite conclusions on the two.
    # Emitted here rather than hardcoded in the report generator for the same reason
    # everything else here is: a table typed once goes stale the next time the model is
    # retrained or the cost table is changed.
    bucket_edges_paise = [0, 25_000, 50_000, 100_000, 150_000, 250_000, None]
    bucket_labels = ["<250", "250-500", "500-1k", "1k-1.5k", "1.5k-2.5k", "2.5k+"]
    amount_buckets = []
    for i, label in enumerate(bucket_labels):
        lo = bucket_edges_paise[i]
        hi = bucket_edges_paise[i + 1]
        sel = df["amount_paise"] >= lo
        if hi is not None:
            sel &= df["amount_paise"] < hi
        sub = df[sel]
        if len(sub) == 0:
            continue
        counts = sub["reclaim_action"].value_counts().to_dict()
        amount_buckets.append(
            {
                "label": label,
                "n": int(len(sub)),
                "escalated_share": float((sub["reclaim_action"] == "ESCALATE_HUMAN").mean()),
                "retry_later_share": float((sub["reclaim_action"] == "RETRY_LATER").mean()),
                "cost_paise_per_event": float(
                    sum(INTERVENTION_COST_PAISE[a] * c for a, c in counts.items()) / len(sub)
                ),
            }
        )

    out = {
        "seed": int(SEED),
        "split": "logged_demo",
        "n_events": len(df),
        "n_transactions": int(df["transaction_id"].nunique()),
        "policies": results,
        "headroom_captured": headroom_captured,
        "reclaim_action_counts": {str(a): int(n) for a, n in sorted(action_counts.items())},
        "run_cost_paise_per_event": run_cost_paise / len(df),
        "amount_paise_median": float(df["amount_paise"].median()),
        "reclaim_action_by_amount": amount_buckets,
        "bracket_order_expected": ["B0", "B3", "B1", "B2", "B4", "Reclaim", "B5"],
        "bracket_order_actual": [r["policy"] for r in sorted(results, key=lambda r: r["value_inr"])],
    }

    out_path = OUT_DIR.parent.parent.parent / "docs" / "ope_results.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8", newline="\n")

    print(f"\nOff-policy evaluation — {out['split']} ({out['n_events']} events, {out['n_transactions']} transactions)\n")
    header = f"{'Policy':<10}{'Estimator':<18}{'Value (Rs/txn)':<18}{'95% CI':<24}{'ESS':<10}{'Oracle':<12}{'Error %':<10}"
    print(header)
    print("-" * len(header))
    for r in results:
        ci = f"[{r['ci_low_inr']:.2f}, {r['ci_high_inr']:.2f}]" if r["ci_low_inr"] is not None else "n/a"
        ess_s = f"{r['ess']:.0f}" if r["ess"] is not None else "n/a"
        oracle_s = f"{r['oracle_value_inr']:.2f}" if r["oracle_value_inr"] is not None else "n/a"
        err_s = f"{r['estimator_error_pct']:.1f}" if r["estimator_error_pct"] is not None else "n/a"
        print(f"{r['policy']:<10}{r['estimator']:<18}{r['value_inr']:<18.2f}{ci:<24}{ess_s:<10}{oracle_s:<12}{err_s:<10}")

    print(f"\nBracket order (ascending value): {' <= '.join(out['bracket_order_actual'])}")
    print(f"Expected order:                  {' <= '.join(out['bracket_order_expected'])}")
    print(f"HeadroomCaptured = (Reclaim - B4) / (B5 - B4) = {headroom_captured:.1%}")
    print(f"\nWritten: {out_path}")


if __name__ == "__main__":
    main()
