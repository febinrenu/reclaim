"""
Entry point: `python -m scripts.data.benchmark_gbm` (wired as `npm run benchmark:gbm`).

Closes a real, named gap: `docs/DECISIONS.md` #2 states plainly "we did not measure
this — no side-by-side comparison was built" between logistic regression (what
ships) and gradient boosting (the alternative SYSTEM_SPEC.md §10 names). This
script runs that comparison for real, on the exact same `logged_train` /
`logged_calibration` / `logged_demo` splits the shipped model uses, with the exact
same metrics (`_ece`, `_murphy_decomposition`, Platt calibration fit on the
calibration split, never on demo).

This does NOT change what ships. `recovery_model.json` and the logistic-regression
pipeline in `train_scorer.py` are untouched — this is a measurement, written to
`docs/model_comparison.json` and `docs/MODEL_COMPARISON.md`, that lets the ADR
state a real number instead of an honest absence. If gradient boosting wins by a
wide margin, that is worth knowing and saying; if it does not, that is worth
knowing too, and confirms the original decision's own reasoning (a 25-multiply-add
model a reviewer can read as JSON, versus a compiled blob) was not just made for
convenience.
"""
from __future__ import annotations

import json
import time

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

from .common import REPO_ROOT
from .loader import load_logged_split
from .model_spec import build_row
from .train_scorer import _ece, _murphy_decomposition, _sigmoid, _fold_scaler

COMPARISON_JSON = REPO_ROOT / "docs" / "model_comparison.json"
COMPARISON_MD = REPO_ROOT / "docs" / "MODEL_COMPARISON.md"


def _design_matrix(df) -> np.ndarray:
    rows = [build_row(record, record["action"]) for record in df.to_dict("records")]
    return np.array(rows, dtype="float64")


def _platt_calibrate(raw_logit_calib: np.ndarray, y_calib: np.ndarray, raw_logit_demo: np.ndarray):
    platt = LogisticRegression()
    platt.fit(raw_logit_calib.reshape(-1, 1), y_calib)
    a, b = float(platt.coef_[0][0]), float(platt.intercept_[0])
    return _sigmoid(a * raw_logit_demo + b), a, b


def _score(y_demo: np.ndarray, p_after: np.ndarray, brier_ref: float) -> dict:
    brier_after = float(brier_score_loss(y_demo, p_after))
    return {
        "brier_after_platt": brier_after,
        "bss": 1.0 - brier_after / brier_ref,
        "roc_auc": float(roc_auc_score(y_demo, p_after)),
        "ece_10": _ece(y_demo, p_after, 10),
        "murphy_decomposition": _murphy_decomposition(y_demo, p_after),
    }


def main() -> None:
    train_df = load_logged_split("logged_train")
    calib_df = load_logged_split("logged_calibration")
    demo_df = load_logged_split("logged_demo")

    X_train = _design_matrix(train_df)
    y_train = train_df["outcome"].to_numpy(dtype="float64")
    X_calib = _design_matrix(calib_df)
    y_calib = calib_df["outcome"].to_numpy(dtype="float64")
    X_demo = _design_matrix(demo_df)
    y_demo = demo_df["outcome"].to_numpy(dtype="float64")

    brier_ref = float(y_train.mean() * (1 - y_train.mean()))

    # ── Logistic regression, refit here identically to train_scorer.py, so this ─
    # comparison is self-contained and cannot silently drift from what that
    # script actually does — same StandardScaler, same class_weight default.
    scaler = StandardScaler()
    Xs_train = scaler.fit_transform(X_train)
    t0 = time.perf_counter()
    logreg = LogisticRegression(max_iter=2000)
    logreg.fit(Xs_train, y_train)
    logreg_train_s = time.perf_counter() - t0
    folded_coef, folded_intercept = _fold_scaler(logreg.coef_[0], float(logreg.intercept_[0]), scaler)

    raw_logit_calib_lr = X_calib @ folded_coef + folded_intercept
    raw_logit_demo_lr = X_demo @ folded_coef + folded_intercept
    p_lr, platt_a_lr, platt_b_lr = _platt_calibrate(raw_logit_calib_lr, y_calib, raw_logit_demo_lr)
    t0 = time.perf_counter()
    logreg.predict_proba(scaler.transform(X_demo))
    logreg_infer_ms_per_1k = (time.perf_counter() - t0) / len(X_demo) * 1000 * 1000

    # ── Gradient boosting: HistGradientBoostingClassifier — scikit-learn's own ──
    # LightGBM-style histogram-binned GBM, no external dependency, no ONNX export
    # needed to run this comparison in Python. Trees need no feature scaling.
    t0 = time.perf_counter()
    gbm = HistGradientBoostingClassifier(
        max_iter=200, max_depth=4, learning_rate=0.05, random_state=20260826,
    )
    gbm.fit(X_train, y_train)
    gbm_train_s = time.perf_counter() - t0

    raw_logit_calib_gbm = gbm.decision_function(X_calib)
    raw_logit_demo_gbm = gbm.decision_function(X_demo)
    p_gbm, platt_a_gbm, platt_b_gbm = _platt_calibrate(raw_logit_calib_gbm, y_calib, raw_logit_demo_gbm)
    t0 = time.perf_counter()
    gbm.predict_proba(X_demo)
    gbm_infer_ms_per_1k = (time.perf_counter() - t0) / len(X_demo) * 1000 * 1000

    lr_metrics = _score(y_demo, p_lr, brier_ref)
    gbm_metrics = _score(y_demo, p_gbm, brier_ref)

    result = {
        "n_train": len(y_train),
        "n_calibration": len(y_calib),
        "n_demo": len(y_demo),
        "brier_ref_train_base_rate": brier_ref,
        "logistic_regression": {
            **lr_metrics,
            "train_seconds": logreg_train_s,
            "inference_us_per_prediction": logreg_infer_ms_per_1k,
            "n_parameters": int(len(folded_coef) + 1),
            "platt_a": platt_a_lr,
            "platt_b": platt_b_lr,
        },
        "gradient_boosting": {
            **gbm_metrics,
            "train_seconds": gbm_train_s,
            "inference_us_per_prediction": gbm_infer_ms_per_1k,
            "n_trees": int(gbm.n_iter_),
            "platt_a": platt_a_gbm,
            "platt_b": platt_b_gbm,
        },
        "bss_delta_gbm_minus_logreg": gbm_metrics["bss"] - lr_metrics["bss"],
        "roc_auc_delta_gbm_minus_logreg": gbm_metrics["roc_auc"] - lr_metrics["roc_auc"],
    }

    COMPARISON_JSON.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    delta = result["bss_delta_gbm_minus_logreg"]
    winner = "gradient boosting" if delta > 0 else "logistic regression"
    margin = abs(delta)
    # A BSS delta this small on a synthetic, single-seed dataset is well within
    # what a different random_state or a slightly different feature draw could
    # move — framed as a real tie rather than a false "won by X" precision.
    is_meaningful = margin > 0.02

    md = f"""# Model comparison: logistic regression vs. gradient boosting

Generated by `npm run benchmark:gbm` (`scripts/data/benchmark_gbm.py`).
Never hand-typed — closes `docs/DECISIONS.md` #2's stated absence ("we did not
measure this") with a real side-by-side run on the identical `logged_train` /
`logged_calibration` / `logged_demo` splits, same Platt calibration methodology,
same metrics, as `train_scorer.py` uses for the model that actually ships.

| Metric | Logistic regression (ships) | Gradient boosting (HistGBM) |
|---|---|---|
| BSS | {lr_metrics['bss']:.4f} | {gbm_metrics['bss']:.4f} |
| ROC-AUC | {lr_metrics['roc_auc']:.4f} | {gbm_metrics['roc_auc']:.4f} |
| Brier (after Platt) | {lr_metrics['brier_after_platt']:.4f} | {gbm_metrics['brier_after_platt']:.4f} |
| ECE (k=10) | {lr_metrics['ece_10']:.4f} | {gbm_metrics['ece_10']:.4f} |
| Parameters / trees | {result['logistic_regression']['n_parameters']} coefficients | {result['gradient_boosting']['n_trees']} trees |
| Train time | {logreg_train_s:.2f}s | {gbm_train_s:.2f}s |
| Inference | {logreg_infer_ms_per_1k:.1f}us/prediction | {gbm_infer_ms_per_1k:.1f}us/prediction |

**Real result: {"logistic regression wins" if winner == "logistic regression" and is_meaningful else "gradient boosting wins" if is_meaningful else "the two are effectively tied"} on BSS, by {margin:.4f}**, on this dataset, at this
size ({len(y_train)} training rows). {(
    "This validates the original decision for a real, measured reason, not just "
    "convenience: the simpler model is not merely easier to read as committed "
    "JSON here, it is also the better-performing one on this data."
) if winner == "logistic regression" and is_meaningful else (
    "This is a real discrimination/calibration gain for gradient boosting, worth "
    "reconsidering the ADR's decision if this system ever needs to scale past "
    "what a reviewer can hand-verify as JSON."
) if is_meaningful else (
    "A gap this small, on a single random seed and a synthetic dataset, is not "
    "a real difference either way — logistic regression's other real advantages "
    "(readable as committed JSON, no ONNX runtime dependency, the scaler-folding "
    "parity contract stays hand-verifiable to 1e-12) settle the choice, not BSS."
)}

Not measured here, and worth naming rather than silently omitting: this comparison
still trains on the same synthetic, invented-effect-size data every other number in
this project is honest about (README's "Honest limitations", BUILD_PLAN.md's D4
notes) — a real discrimination gain on synthetic data is not evidence the same gain
would appear on real transaction logs.
"""
    COMPARISON_MD.write_text(md, encoding="utf-8")

    print(f"Logistic regression: BSS={lr_metrics['bss']:.4f} ROC-AUC={lr_metrics['roc_auc']:.4f}")
    print(f"Gradient boosting:   BSS={gbm_metrics['bss']:.4f} ROC-AUC={gbm_metrics['roc_auc']:.4f}")
    print(f"Winner: {winner}, BSS delta {result['bss_delta_gbm_minus_logreg']:+.4f}")
    print(f"Wrote {COMPARISON_JSON} and {COMPARISON_MD}")


if __name__ == "__main__":
    main()
