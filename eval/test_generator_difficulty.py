"""
BUILD_PLAN.md §6.2's own words: "fails CI if the task becomes too easy." A test
suite that fails when our own benchmark becomes trivial is the concrete form of
"we are demonstrably not recovering the generator" — the model is deliberately
misspecified relative to the true DGP (scripts/data/dgp.py), and this is where that
claim gets checked against numbers rather than asserted in prose.

This is the one place in the whole eval suite that is *allowed* to touch
`oracle_counterfactuals.parquet` directly: computing the Bayes floor is exactly what
that file is for (BUILD_PLAN.md §6.3, Track B). It is not part of the recovery
scorer's training or evaluation pipeline — see eval/test_oracle_firewall.py, which
checks that pipeline never sees it.
"""
import json

import numpy as np
import pandas as pd
import pytest

from scripts.data.common import OUT_DIR


@pytest.fixture(scope="module")
def model():
    path = OUT_DIR / "recovery_model.json"
    if not path.exists():
        pytest.skip("no trained model — run `npm run scorer:train` first")
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def brier_bayes(model):
    """mean_i[ p_true_i(a_i) * (1 - p_true_i(a_i)) ] over the demo split's actually
    logged action — the irreducible noise floor no model can beat, however well
    specified, because it is a property of the generator's own randomness."""
    demo = pd.read_csv(OUT_DIR / "logged_demo.csv")
    oracle = pd.read_parquet(OUT_DIR / "oracle_counterfactuals.parquet")
    merged = demo[["event_id", "action"]].merge(oracle, on="event_id", how="left")
    p_true_for_chosen = merged.apply(lambda r: r[f"p_true_{r['action']}"], axis=1).to_numpy(dtype="float64")
    return float(np.mean(p_true_for_chosen * (1 - p_true_for_chosen)))


def test_holdout_auc_in_the_expected_band(model):
    auc = model["metrics"]["roc_auc"]
    assert 0.68 <= auc <= 0.82, f"holdout AUC {auc} outside [0.68, 0.82] — task is too easy or too hard"


def test_brier_skill_score_in_the_expected_band(model):
    bss = model["metrics"]["bss"]
    assert 0.08 <= bss <= 0.25, f"BSS {bss} outside [0.08, 0.25] — task is too easy or too hard"


def test_model_genuinely_underfits_the_bayes_floor(model, brier_bayes):
    brier_model = model["metrics"]["brier_after_platt"]
    gap = brier_model - brier_bayes
    assert gap > 0.015, (
        f"brier_model ({brier_model}) - brier_bayes ({brier_bayes}) = {gap}, "
        "which is not enough of a gap — the shipped model is coming suspiciously "
        "close to recovering the generator's own irreducible noise floor."
    )


def test_scaler_fold_was_verified_before_the_json_was_written(model):
    # Belt and suspenders: train_scorer.py already refuses to write the JSON at all
    # if this check fails (BUILD_PLAN.md §6.8), so finding the JSON on disk is
    # already evidence it passed — this re-asserts the recorded number directly.
    assert model["metrics"]["scaler_fold_parity_max_diff"] < 1e-12
