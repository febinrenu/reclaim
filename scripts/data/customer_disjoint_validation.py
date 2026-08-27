"""
Entry point: `python -m scripts.data.customer_disjoint_validation`
(wired as `npm run scorer:validate-customer-disjoint`).

A real gap named honestly in this project's own docs: `logged_train`/
`logged_calibration`/`logged_demo` are split *chronologically* (months 1-4 /
5 / 6 — common.py's own SPLIT_MONTHS), specifically to respect the
backward-looking feature contract (a customer's month-6 `prior_success_rate`
legitimately depends on their own months 1-5 history — that is the feature
working as intended, not leakage). What that split does NOT check: the same
customer_id can appear in both `logged_train` and `logged_demo` (the DGP's
customer pool, `dgp.py`'s `generate_customers`, is fixed once and reused
across the whole 6-month timeline), so the demo-split metrics `recovery_model.
json` reports could be optimistically biased for a model that has effectively
already seen a fraction of its "held out" customers' behavior.

This script answers two separate questions the temporal split alone cannot:

  1. How much customer overlap actually exists between the shipped model's
     train and demo splits? (a factual count, not a guess)
  2. If customers, not rows, are held out — a genuinely unseen-customer
     evaluation — does the SAME model architecture (identical feature set,
     identical fit/calibrate/evaluate pipeline, reusing train_scorer.py's own
     private helpers so there is no drift between what "the model" means in
     both places) perform meaningfully differently?

Never overwrites `recovery_model.json` — this is a validation report, the same
non-authoritative role `benchmark_gbm.py` and `run_ope.py` already play.
Reuses train_scorer.py's own design-matrix/scaler-folding/metric functions
directly (not duplicated) so both scripts are provably scoring the same model
shape the same way.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

from .common import OUT_DIR, REPO_ROOT
from .loader import load_logged_split
from .train_scorer import _design_matrix, _fold_scaler, _sigmoid, _ece, _mce, MODEL_PATH

REPORT_PATH = REPO_ROOT / "docs" / "customer_disjoint_validation.json"
MD_PATH = REPO_ROOT / "docs" / "CUSTOMER_DISJOINT_VALIDATION.md"
SEEDS = [20260827, 20260828, 20260829, 20260830, 20260831]
SPLIT_FRACTIONS = {"train": 0.60, "calibration": 0.20, "demo": 0.20}  # matches SPLIT_ROW_TARGETS' ratio


def _overlap_report(train_df: pd.DataFrame, calib_df: pd.DataFrame, demo_df: pd.DataFrame) -> dict:
    train_ids = set(train_df["customer_id"])
    calib_ids = set(calib_df["customer_id"])
    demo_ids = set(demo_df["customer_id"])
    train_demo_overlap = train_ids & demo_ids
    train_calib_overlap = train_ids & calib_ids
    return {
        "n_customers_train": len(train_ids),
        "n_customers_calibration": len(calib_ids),
        "n_customers_demo": len(demo_ids),
        "n_customers_train_and_demo": len(train_demo_overlap),
        "n_customers_train_and_calibration": len(train_calib_overlap),
        "fraction_of_demo_customers_also_in_train": (
            len(train_demo_overlap) / len(demo_ids) if demo_ids else 0.0
        ),
        "fraction_of_demo_rows_from_a_train_customer": float(
            demo_df["customer_id"].isin(train_demo_overlap).mean()
        ),
    }


def _fit_evaluate(train_df: pd.DataFrame, calib_df: pd.DataFrame, demo_df: pd.DataFrame) -> dict:
    """Identical pipeline to train_scorer.py's `main()`: scaler-fold, Platt
    calibration on the calibration split's raw logit, metrics on the demo
    split. Returns only the metrics — never writes a model artifact."""
    X_train = _design_matrix(train_df)
    y_train = train_df["outcome"].to_numpy(dtype="float64")

    scaler = StandardScaler()
    Xs_train = scaler.fit_transform(X_train)
    clf = LogisticRegression(max_iter=2000)
    clf.fit(Xs_train, y_train)
    folded_coef, folded_intercept = _fold_scaler(clf.coef_[0], float(clf.intercept_[0]), scaler)

    X_calib = _design_matrix(calib_df)
    y_calib = calib_df["outcome"].to_numpy(dtype="float64")
    raw_logit_calib = (X_calib @ folded_coef + folded_intercept).reshape(-1, 1)
    platt = LogisticRegression()
    platt.fit(raw_logit_calib, y_calib)
    platt_a = float(platt.coef_[0][0])
    platt_b = float(platt.intercept_[0])

    X_demo = _design_matrix(demo_df)
    y_demo = demo_df["outcome"].to_numpy(dtype="float64")
    raw_logit_demo = X_demo @ folded_coef + folded_intercept
    p_after = _sigmoid(platt_a * raw_logit_demo + platt_b)

    brier_ref = float(y_train.mean() * (1 - y_train.mean()))
    brier_after = float(brier_score_loss(y_demo, p_after))
    return {
        "n_train": int(len(y_train)),
        "n_calibration": int(len(y_calib)),
        "n_demo": int(len(y_demo)),
        "brier_after_platt": brier_after,
        "bss": 1.0 - brier_after / brier_ref if brier_ref > 0 else None,
        "roc_auc": float(roc_auc_score(y_demo, p_after)),
        "ece_k10": _ece(y_demo, p_after, 10),
        "mce_k10": _mce(y_demo, p_after, 10),
    }


def _customer_disjoint_split(all_df: pd.DataFrame, seed: int) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Splits by CUSTOMER, not by row or by time — every row for a given
    customer_id lands in exactly one of the three resulting frames. This is
    the actual "has never seen this customer" holdout a temporal split does
    not guarantee."""
    customer_ids = np.array(sorted(all_df["customer_id"].unique()))
    rng = np.random.default_rng(seed)
    shuffled = rng.permutation(customer_ids)
    n = len(shuffled)
    n_train = int(round(n * SPLIT_FRACTIONS["train"]))
    n_calib = int(round(n * SPLIT_FRACTIONS["calibration"]))
    train_ids = set(shuffled[:n_train])
    calib_ids = set(shuffled[n_train:n_train + n_calib])
    demo_ids = set(shuffled[n_train + n_calib:])
    train_df = all_df[all_df["customer_id"].isin(train_ids)]
    calib_df = all_df[all_df["customer_id"].isin(calib_ids)]
    demo_df = all_df[all_df["customer_id"].isin(demo_ids)]
    return train_df, calib_df, demo_df


def main() -> None:
    train_df = load_logged_split("logged_train")
    calib_df = load_logged_split("logged_calibration")
    demo_df = load_logged_split("logged_demo")
    all_df = pd.concat([train_df, calib_df, demo_df], ignore_index=True)

    overlap = _overlap_report(train_df, calib_df, demo_df)

    shipped_metrics = json.loads(MODEL_PATH.read_text(encoding="utf-8"))["metrics"]

    runs = []
    for seed in SEEDS:
        disjoint_train, disjoint_calib, disjoint_demo = _customer_disjoint_split(all_df, seed)
        # A customer with very few rows can end up entirely on one side and
        # produce a demo/calibration split with too few outcome-1 rows for a
        # stable Brier/AUC — report what happened rather than crash, honest
        # about a rare edge case a fixed-seed run might hit.
        if disjoint_demo["outcome"].nunique() < 2 or disjoint_calib["outcome"].nunique() < 2:
            runs.append({"seed": seed, "skipped": "degenerate split — demo or calibration outcome not both classes"})
            continue
        metrics = _fit_evaluate(disjoint_train, disjoint_calib, disjoint_demo)
        runs.append({"seed": seed, **metrics})

    valid_runs = [r for r in runs if "skipped" not in r]
    if valid_runs:
        briers = np.array([r["brier_after_platt"] for r in valid_runs])
        aucs = np.array([r["roc_auc"] for r in valid_runs])
        eces = np.array([r["ece_k10"] for r in valid_runs])
        summary = {
            "n_valid_seeds": len(valid_runs),
            "brier_after_platt_mean": float(briers.mean()),
            "brier_after_platt_std": float(briers.std()),
            "roc_auc_mean": float(aucs.mean()),
            "roc_auc_std": float(aucs.std()),
            "ece_k10_mean": float(eces.mean()),
            "ece_k10_std": float(eces.std()),
        }
    else:
        summary = {"n_valid_seeds": 0}

    report = {
        "overlap_under_the_shipped_temporal_split": overlap,
        "shipped_model_demo_metrics": {
            "brier_after_platt": shipped_metrics["brier_after_platt"],
            "roc_auc": shipped_metrics["roc_auc"],
            "ece_k10": shipped_metrics["ece"]["10"],
        },
        "customer_disjoint_runs": runs,
        "customer_disjoint_summary": summary,
    }

    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")

    lines = [
        "# Customer-disjoint validation",
        "",
        "Not a replacement for the shipped model or its metrics — a robustness check,",
        "generated by `python -m scripts.data.customer_disjoint_validation`, answering a",
        "question the shipped temporal split (`SPLIT_MONTHS`, chronological by design, for",
        "the reason its own comment states) cannot: does the model hold up on customers it",
        "has genuinely never seen any row from, not just future events from customers it has",
        "partially already seen?",
        "",
        "## Overlap under the shipped temporal split",
        "",
        f"- {overlap['n_customers_train']} distinct customers in `logged_train`,"
        f" {overlap['n_customers_demo']} in `logged_demo`.",
        f"- **{overlap['n_customers_train_and_demo']} customers appear in both**"
        f" ({overlap['fraction_of_demo_customers_also_in_train'] * 100:.1f}% of demo customers),"
        f" accounting for {overlap['fraction_of_demo_rows_from_a_train_customer'] * 100:.1f}%"
        " of all `logged_demo` rows.",
        "- This is expected, not a bug: the DGP's customer pool is fixed once and reused across",
        "  the full 6-month timeline (`dgp.py`'s `generate_customers`), and a repeat customer's",
        "  own history legitimately informs their own later `prior_success_rate` feature — the",
        "  split was never designed to prevent this, only to respect event chronology.",
        "",
        "## Shipped model (temporal holdout) vs. customer-disjoint holdout",
        "",
        f"Shipped (`recovery_model.json`, `logged_demo`): Brier {shipped_metrics['brier_after_platt']:.4f},"
        f" AUC {shipped_metrics['roc_auc']:.4f}, ECE(k=10) {shipped_metrics['ece']['10']:.4f}.",
        "",
    ]
    if valid_runs:
        lines += [
            f"Customer-disjoint, {summary['n_valid_seeds']} seeds"
            f" ({', '.join(str(r['seed']) for r in valid_runs)}), same architecture, refit fresh each seed:",
            f"- Brier: {summary['brier_after_platt_mean']:.4f} ± {summary['brier_after_platt_std']:.4f}",
            f"- AUC: {summary['roc_auc_mean']:.4f} ± {summary['roc_auc_std']:.4f}",
            f"- ECE(k=10): {summary['ece_k10_mean']:.4f} ± {summary['ece_k10_std']:.4f}",
            "",
        ]
        brier_delta = summary["brier_after_platt_mean"] - shipped_metrics["brier_after_platt"]
        lines.append(
            f"Delta vs. shipped: {brier_delta:+.4f} Brier"
            f" ({'worse' if brier_delta > 0 else 'better or equal'} on unseen customers)."
        )
    else:
        lines.append("All seeds produced a degenerate split (see the JSON report) — no summary to report.")
    lines.append("")
    lines.append("Full per-seed numbers: `docs/customer_disjoint_validation.json`.")

    MD_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    print(f"wrote {REPORT_PATH}")
    print(f"wrote {MD_PATH}")
    print(f"customer overlap: {overlap['n_customers_train_and_demo']} of {overlap['n_customers_demo']} demo customers also in train")
    if valid_runs:
        print(f"customer-disjoint brier: {summary['brier_after_platt_mean']:.4f} +/- {summary['brier_after_platt_std']:.4f} (shipped: {shipped_metrics['brier_after_platt']:.4f})")


if __name__ == "__main__":
    main()
