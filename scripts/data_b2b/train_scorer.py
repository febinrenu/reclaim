"""
Entry point: `python -m scripts.data_b2b.train_scorer` (wired as `npm run
scorer:train:b2b`). Fits the B2B receivables recovery scorer against
`logged_train`, calibrates on `logged_calibration`, and writes
`recovery_model.json` under `data/synthetic/b2b_receivable/` — the same
scaler-folding, Platt-calibration, and golden-vector discipline
`scripts/data/train_scorer.py` established, applied to a second, independently
seeded dataset. SYSTEM_SPEC.md §16: "the same scorer architecture retrained on
different features."
"""
from __future__ import annotations

import json
import math

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

from .common import OUT_DIR, REPO_ROOT, ACTIONS, FEATURE_ORDER
from .loader import load_logged_split
from .model_spec import MODEL_FEATURE_ORDER, build_row

MODEL_PATH = OUT_DIR / "recovery_model.json"
CHART_PATH = REPO_ROOT / "docs" / "calibration_b2b_receivable_v1.png"
PARITY_TOLERANCE = 1e-12
N_PARITY_ROWS = 1000


def _design_matrix(df) -> np.ndarray:
    rows = [build_row(record, record["action"]) for record in df.to_dict("records")]
    return np.array(rows, dtype="float64")


def _fold_scaler(coef: np.ndarray, intercept: float, scaler: StandardScaler) -> tuple[np.ndarray, float]:
    folded_coef = coef / scaler.scale_
    folded_intercept = intercept - float(np.sum(coef * scaler.mean_ / scaler.scale_))
    return folded_coef, folded_intercept


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def _wilson_interval(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = successes / n
    denom = 1 + z ** 2 / n
    centre = p + z ** 2 / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n)
    return (centre - margin) / denom, (centre + margin) / denom


def _ece(y: np.ndarray, p: np.ndarray, k: int) -> float:
    order = np.argsort(p)
    y, p = y[order], p[order]
    n = len(p)
    bounds = np.linspace(0, n, k + 1, dtype=int)
    total = 0.0
    for i in range(k):
        lo, hi = bounds[i], bounds[i + 1]
        if hi <= lo:
            continue
        bin_p, bin_y = p[lo:hi], y[lo:hi]
        total += len(bin_p) * abs(bin_p.mean() - bin_y.mean())
    return total / n


def _mce(y: np.ndarray, p: np.ndarray, k: int = 10) -> float:
    order = np.argsort(p)
    y, p = y[order], p[order]
    n = len(p)
    bounds = np.linspace(0, n, k + 1, dtype=int)
    worst = 0.0
    for i in range(k):
        lo, hi = bounds[i], bounds[i + 1]
        if hi <= lo:
            continue
        bin_p, bin_y = p[lo:hi], y[lo:hi]
        worst = max(worst, abs(bin_p.mean() - bin_y.mean()))
    return worst


def _murphy_decomposition(y: np.ndarray, p: np.ndarray, k: int = 10) -> dict:
    order = np.argsort(p)
    y_sorted, p_sorted = y[order], p[order]
    n = len(p)
    ybar = y.mean()
    bounds = np.linspace(0, n, k + 1, dtype=int)
    reliability = 0.0
    resolution = 0.0
    for i in range(k):
        lo, hi = bounds[i], bounds[i + 1]
        if hi <= lo:
            continue
        bin_p, bin_y = p_sorted[lo:hi], y_sorted[lo:hi]
        nb = len(bin_p)
        obar = bin_y.mean()
        reliability += nb * (bin_p.mean() - obar) ** 2
        resolution += nb * (obar - ybar) ** 2
    reliability /= n
    resolution /= n
    uncertainty = ybar * (1 - ybar)
    return {"reliability": reliability, "resolution": resolution, "uncertainty": uncertainty}


def _calibration_bins(y: np.ndarray, p: np.ndarray, k: int = 10) -> list[dict]:
    order = np.argsort(p)
    y_sorted, p_sorted = y[order], p[order]
    n = len(p)
    bounds = np.linspace(0, n, k + 1, dtype=int)
    bins = []
    for i in range(k):
        lo, hi = bounds[i], bounds[i + 1]
        if hi <= lo:
            continue
        bin_p, bin_y = p_sorted[lo:hi], y_sorted[lo:hi]
        wlo, whi = _wilson_interval(int(bin_y.sum()), len(bin_y))
        bins.append({
            "n": int(len(bin_p)),
            "meanPredicted": float(bin_p.mean()),
            "observedRate": float(bin_y.mean()),
            "wilsonLow": float(wlo),
            "wilsonHigh": float(whi),
        })
    return bins


def _make_calibration_chart(y: np.ndarray, p: np.ndarray, path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    k = 10
    order = np.argsort(p)
    y_sorted, p_sorted = y[order], p[order]
    n = len(p)
    bounds = np.linspace(0, n, k + 1, dtype=int)

    mean_pred, obs_rate, lo_ci, hi_ci = [], [], [], []
    for i in range(k):
        lo, hi = bounds[i], bounds[i + 1]
        if hi <= lo:
            continue
        bin_p, bin_y = p_sorted[lo:hi], y_sorted[lo:hi]
        mean_pred.append(bin_p.mean())
        obs_rate.append(bin_y.mean())
        wlo, whi = _wilson_interval(int(bin_y.sum()), len(bin_y))
        lo_ci.append(bin_y.mean() - wlo)
        hi_ci.append(whi - bin_y.mean())

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(6, 8), height_ratios=[2, 1], sharex=True)
    ax1.plot([0, 1], [0, 1], linestyle="--", color="grey", label="perfect calibration")
    ax1.errorbar(mean_pred, obs_rate, yerr=[lo_ci, hi_ci], fmt="o", capsize=3,
                 color="#2c6e49", label="observed (Wilson 95% CI)")
    ax1.set_ylabel("observed payment rate")
    ax1.set_title("B2B receivables scorer calibration — logged_demo, 10 equal-frequency bins")
    ax1.legend()

    ax2.hist(p, bins=30, color="#2c6e49", alpha=0.7)
    ax2.set_xlabel("predicted P(paid)")
    ax2.set_ylabel("count")

    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def _golden_vectors(folded_coef: np.ndarray, folded_intercept: float, platt_a: float, platt_b: float,
                     medians: dict, sigmas: dict, holdout_rows: np.ndarray,
                     holdout_actions: list[str], rng: np.random.Generator) -> list[dict]:
    def score(row: list[float]) -> float:
        z = float(np.dot(np.array(row), folded_coef) + folded_intercept)
        return float(_sigmoid(np.array([platt_a * z + platt_b]))[0])

    vectors = []

    zero_features = {f: 0.0 for f in medians}
    vectors.append({"action": "WRITE_OFF", "features": zero_features})

    median_features = dict(medians)
    vectors.append({"action": "WRITE_OFF", "features": median_features})

    for feature in medians:
        for sign, label in ((3, "plus3sigma"), (-3, "minus3sigma")):
            feats = dict(medians)
            feats[feature] = medians[feature] + sign * sigmas.get(feature, 1.0)
            vectors.append({"action": "WRITE_OFF", "features": feats, "note": f"{feature}_{label}"})

    for action in ACTIONS:
        vectors.append({"action": action, "features": dict(medians)})

    extreme_high = {f: medians[f] + 3 * sigmas.get(f, 1.0) for f in medians}
    extreme_low = {f: medians[f] - 3 * sigmas.get(f, 1.0) for f in medians}
    vectors.append({"action": "WRITE_OFF", "features": extreme_high, "note": "all_plus3sigma"})
    vectors.append({"action": "WRITE_OFF", "features": extreme_low, "note": "all_minus3sigma"})

    coldstart = {
        "days_overdue": 5.0, "customer_ontime_rate": 0.5, "invoice_size_zscore": 0.0,
        "chase_rounds_so_far": 0.0, "is_repeat_overdue_this_quarter": 0.0, "quarter_sin": 0.0,
        "quarter_cos": 1.0, "contacts_last_14d": 0.0, "customer_relationship_days": 0.0,
    }
    vectors.append({"action": "SEND_REMINDER", "features": coldstart, "note": "coldstart"})

    idx = rng.choice(len(holdout_rows), size=5, replace=False)
    for i in idx:
        feats = {f: float(v) for f, v in zip(medians.keys(), holdout_rows[i][: len(medians)])}
        vectors.append({"action": holdout_actions[i], "features": feats, "note": "random_holdout"})

    out = []
    for v in vectors:
        row = build_row(v["features"], v["action"])
        out.append({
            "action": v["action"],
            "features": v["features"],
            "row": row,
            "expectedProbability": score(row),
        })
    return out


def main() -> None:
    train_df = load_logged_split("logged_train")
    calib_df = load_logged_split("logged_calibration")
    demo_df = load_logged_split("logged_demo")

    X_train = _design_matrix(train_df)
    y_train = train_df["outcome"].to_numpy(dtype="float64")

    scaler = StandardScaler()
    Xs_train = scaler.fit_transform(X_train)

    clf = LogisticRegression(max_iter=2000)
    clf.fit(Xs_train, y_train)

    folded_coef, folded_intercept = _fold_scaler(clf.coef_[0], float(clf.intercept_[0]), scaler)

    X_demo = _design_matrix(demo_df)
    n_check = min(N_PARITY_ROWS, len(X_demo))
    check_idx = np.arange(n_check)
    pipeline_proba = clf.predict_proba(scaler.transform(X_demo[check_idx]))[:, 1]
    folded_proba = _sigmoid(X_demo[check_idx] @ folded_coef + folded_intercept)
    max_diff = float(np.max(np.abs(pipeline_proba - folded_proba)))
    if max_diff >= PARITY_TOLERANCE:
        raise RuntimeError(
            f"scaler-folding parity check failed: max |folded - pipeline| = {max_diff} "
            f">= {PARITY_TOLERANCE} over {n_check} holdout rows"
        )

    X_calib = _design_matrix(calib_df)
    y_calib = calib_df["outcome"].to_numpy(dtype="float64")
    raw_logit_calib = (X_calib @ folded_coef + folded_intercept).reshape(-1, 1)
    platt = LogisticRegression()
    platt.fit(raw_logit_calib, y_calib)
    platt_a = float(platt.coef_[0][0])
    platt_b = float(platt.intercept_[0])

    y_demo = demo_df["outcome"].to_numpy(dtype="float64")
    raw_logit_demo = X_demo @ folded_coef + folded_intercept
    p_before = _sigmoid(raw_logit_demo)
    p_after = _sigmoid(platt_a * raw_logit_demo + platt_b)

    brier_ref = float(y_train.mean() * (1 - y_train.mean()))
    brier_before = float(brier_score_loss(y_demo, p_before))
    brier_after = float(brier_score_loss(y_demo, p_after))
    auc = float(roc_auc_score(y_demo, p_after))
    murphy = _murphy_decomposition(y_demo, p_after)

    metrics = {
        "n_demo": len(y_demo),
        "n_train": len(y_train),
        "train_base_rate": float(y_train.mean()),
        "brier_ref": brier_ref,
        "brier_before_platt": brier_before,
        "brier_after_platt": brier_after,
        "bss": 1.0 - brier_after / brier_ref,
        "roc_auc": auc,
        "ece": {str(k): _ece(y_demo, p_after, k) for k in (5, 10, 20)},
        "mce_k10": _mce(y_demo, p_after, 10),
        "murphy_decomposition": murphy,
        "scaler_fold_parity_max_diff": max_diff,
        "calibration_bins": _calibration_bins(y_demo, p_after, 10),
        "prediction_histogram": {
            "counts": [int(c) for c in np.histogram(p_after, bins=20, range=(0.0, 1.0))[0]],
            "binEdges": [float(e) for e in np.histogram(p_after, bins=20, range=(0.0, 1.0))[1]],
        },
    }

    medians = {f: float(train_df[f].median()) for f in FEATURE_ORDER}
    sigmas = {f: float(train_df[f].std()) or 1.0 for f in FEATURE_ORDER}

    rng = np.random.default_rng(20260901)
    golden_vectors = _golden_vectors(
        folded_coef, folded_intercept, platt_a, platt_b,
        medians, sigmas, X_demo, demo_df["action"].tolist(), rng,
    )

    model = {
        "featureOrder": MODEL_FEATURE_ORDER,
        "intercept": folded_intercept,
        "coefficients": folded_coef.tolist(),
        "plattA": platt_a,
        "plattB": platt_b,
        "goldenVectors": golden_vectors,
        "metrics": metrics,
        "trainedOn": {
            "nTrain": len(y_train),
            "nCalibration": len(y_calib),
            "nDemo": len(y_demo),
        },
    }

    MODEL_PATH.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8", newline="\n")
    _make_calibration_chart(y_demo, p_after, CHART_PATH)

    print(f"wrote {MODEL_PATH}")
    print(f"wrote {CHART_PATH}")
    print("metrics:")
    for k, v in metrics.items():
        if k in ("calibration_bins", "prediction_histogram"):
            continue
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
