"""
D11: the risk gate's own evaluation (SYSTEM_SPEC.md §11.1, BUILD_PLAN.md §6.6).
Mirrors `src/domain/risk/rules.ts`'s weighted rule sum exactly — same four
weights, same signals — evaluated against `risk_eval_calibration.csv` (to pick
the threshold) and reported on `risk_eval_demo.csv` (the only split whose
numbers are allowed to appear anywhere, same discipline as the recovery
scorer). Not ML, not tuned by gradient descent: the weights are fixed constants
copied from the shipped TypeScript, and this script only ever *reports on* the
gate, never fits it.

Usage: `npm run risk:eval` (== `python -m scripts.data.risk_eval`). Writes
`docs/risk_eval_results.json`.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .common import OUT_DIR

# Mirrors src/domain/risk/rules.ts's DEFAULT_RISK_RULES exactly.
RISK_WEIGHTS = {
    "geo_mismatch": 0.2,
    "card_velocity_high": 0.35,
    "amount_far_above_history": 0.15,
    "card_first_seen_recently": 0.3,
}

# SYSTEM_SPEC.md §11.1's own cost formula, in paise.
DISPUTE_HANDLING_PAISE = 500_00
REPRESENTMENT_PAISE = 150_00
AGENT_TIME_PAISE = 40_00
CHURN_EXTERNALITY_PAISE = 12_00
CHURN_EXTERNALITY_AMOUNT_FRACTION = 0.05


def risk_score(row: pd.Series) -> float:
    return sum(w * float(row[key]) for key, w in RISK_WEIGHTS.items())


def cost_false_negative_paise(amount_paise: float) -> float:
    return amount_paise + DISPUTE_HANDLING_PAISE + REPRESENTMENT_PAISE


def cost_false_positive_paise(amount_paise: float) -> float:
    return AGENT_TIME_PAISE + CHURN_EXTERNALITY_PAISE + CHURN_EXTERNALITY_AMOUNT_FRACTION * amount_paise


def total_cost_paise(df: pd.DataFrame, scores: np.ndarray, threshold: float) -> float:
    flagged = scores >= threshold
    y = df["would_chargeback"].to_numpy()
    amounts = df["amount_paise"].to_numpy()
    fn = (~flagged) & (y == 1)
    fp = flagged & (y == 0)
    return float(np.sum(cost_false_negative_paise(amounts[fn]))) + float(np.sum(cost_false_positive_paise(amounts[fp])))


def pr_curve(y: np.ndarray, scores: np.ndarray) -> list[dict]:
    """The standard rank-based PR curve (as `sklearn.metrics.precision_recall_curve`
    computes it): sort by score descending, and at each unique score value —
    equivalently, at each point where the threshold could plausibly sit — report
    precision/recall as if everything scoring at or above it were flagged.
    Recall is non-decreasing by construction (each step only ever *adds* points
    to the flagged set), which is what makes AUC-over-recall a well-formed
    integral rather than the earlier, wrong implementation's arbitrary threshold
    sweep, which could double back to a *lower* precision at the *same* recall
    once low-scoring negatives got swept in below the last positive."""
    total_positives = int(np.sum(y == 1))
    order = np.argsort(-scores, kind="stable")
    y_sorted, scores_sorted = y[order], scores[order]

    points = [{"threshold": float("inf"), "precision": 1.0, "recall": 0.0, "flagged": 0}]
    tp = 0
    fp = 0
    n = len(scores_sorted)
    i = 0
    while i < n:
        # Group by identical score, since "the threshold sits here" must flag
        # every row tied at that score together, not arbitrarily split them.
        j = i
        while j < n and scores_sorted[j] == scores_sorted[i]:
            if y_sorted[j] == 1:
                tp += 1
            else:
                fp += 1
            j += 1
        recall = tp / total_positives if total_positives > 0 else 0.0
        precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
        points.append({"threshold": float(scores_sorted[i]), "precision": precision, "recall": recall, "flagged": tp + fp})
        i = j
    return points


def pr_auc(points: list[dict]) -> float:
    # Trapezoidal integration over recall (x) vs precision (y), points already
    # sorted by recall ascending.
    auc = 0.0
    for a, b in zip(points, points[1:]):
        dx = b["recall"] - a["recall"]
        auc += dx * (a["precision"] + b["precision"]) / 2
    return auc


def main() -> None:
    calib = pd.read_csv(OUT_DIR / "risk_eval_calibration.csv")
    demo = pd.read_csv(OUT_DIR / "risk_eval_demo.csv")

    calib_scores = calib.apply(risk_score, axis=1).to_numpy()
    demo_scores = demo.apply(risk_score, axis=1).to_numpy()

    # Threshold chosen on calibration, reported on demo — SYSTEM_SPEC.md §11.1's
    # own discipline, mirroring the recovery scorer's Platt-fit split boundary.
    candidate_thresholds = sorted(set(calib_scores.tolist()))
    costs_by_threshold = [(t, total_cost_paise(calib, calib_scores, t)) for t in candidate_thresholds]
    best_threshold, _ = min(costs_by_threshold, key=lambda item: item[1])

    demo_y = demo["would_chargeback"].to_numpy()
    demo_prevalence = float(demo_y.mean())

    points = pr_curve(demo_y, demo_scores)
    auc = pr_auc(points)

    flagged_at_best = demo_scores >= best_threshold
    tp = int(np.sum(flagged_at_best & (demo_y == 1)))
    fp = int(np.sum(flagged_at_best & (demo_y == 0)))
    fn = int(np.sum((~flagged_at_best) & (demo_y == 1)))
    precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    fp_cost_total_paise = float(np.sum(cost_false_positive_paise(demo["amount_paise"].to_numpy()[flagged_at_best & (demo_y == 0)])))

    cost_flag_nothing = total_cost_paise(demo, demo_scores, threshold=1.0 + 1e-9)  # nothing clears this
    cost_flag_everything = total_cost_paise(demo, demo_scores, threshold=0.0)
    cost_at_best = total_cost_paise(demo, demo_scores, best_threshold)

    out = {
        "n_calibration": len(calib),
        "n_demo": len(demo),
        "demo_prevalence": demo_prevalence,
        "pr_auc": auc,
        "pr_auc_baseline_prevalence": demo_prevalence,
        "best_threshold": best_threshold,
        "at_best_threshold": {
            "precision": precision,
            "recall": recall,
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "false_positive_cost_inr": fp_cost_total_paise / 100,
        },
        "cost_bracket_inr": {
            "flag_nothing": cost_flag_nothing / 100,
            "flag_everything": cost_flag_everything / 100,
            "at_best_threshold": cost_at_best / 100,
        },
        "pr_curve": points,
    }

    out_path = OUT_DIR.parent.parent.parent / "docs" / "risk_eval_results.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8", newline="\n")

    print(f"Risk gate evaluation — calibration n={len(calib)}, demo n={len(demo)}\n")
    print(f"Demo prevalence (base rate): {demo_prevalence:.4f}")
    print(f"PR-AUC: {auc:.4f} (baseline = prevalence = {demo_prevalence:.4f})")
    print(f"Best threshold (chosen on calibration): {best_threshold:.4f}")
    print(f"At best threshold: precision={precision:.4f}, recall={recall:.4f}, tp={tp}, fp={fp}, fn={fn}")
    print(f"False-positive cost at best threshold: Rs {fp_cost_total_paise / 100:,.2f}")
    print(f"\nCost bracket (demo split):")
    print(f"  flag nothing:   Rs {cost_flag_nothing / 100:,.2f}")
    print(f"  flag everything: Rs {cost_flag_everything / 100:,.2f}")
    print(f"  at best threshold: Rs {cost_at_best / 100:,.2f}")
    print(f"\nWritten: {out_path}")


if __name__ == "__main__":
    main()
