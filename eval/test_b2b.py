"""
D12's second scenario, checked with the exact same discipline
`eval/test_oracle_firewall.py`, `eval/test_overlap.py`, and
`eval/test_generator_difficulty.py` apply to subscription — one file, since
B2B's own generator/model are smaller (SYSTEM_SPEC.md §16's own "half a day,
instantiating an architecture" framing), not because the checks matter less.
"""
import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from scripts.data_b2b.common import OUT_DIR, BANNED_COLUMN_PATTERN, ACTIONS
from scripts.data_b2b.loader import load_logged_split, ALLOWED_LOGGED_COLUMNS

LOGGED_SPLITS = ["logged_train", "logged_calibration", "logged_demo"]
RISK_SPLITS = ["risk_eval_train", "risk_eval_calibration", "risk_eval_demo"]
RISK_EVAL_BANNED_PATTERN = re.compile(r"p_true|y_true_|is_truly_risky")
MIN_CELL_COUNT = 30


@pytest.fixture(scope="module")
def generated():
    if not (OUT_DIR / "manifest.json").exists():
        pytest.skip("no generated B2B data — run `npm run data:generate:b2b` first")
    return True


# ── Oracle firewall ──────────────────────────────────────────────────────────

def test_logged_splits_contain_no_oracle_shaped_column(generated):
    pattern = re.compile(BANNED_COLUMN_PATTERN)
    for split in LOGGED_SPLITS:
        df = pd.read_csv(OUT_DIR / f"{split}.csv")
        offending = [c for c in df.columns if pattern.search(c)]
        assert offending == [], f"{split}.csv has banned column(s): {offending}"


def test_logged_splits_load_through_the_allowlisting_loader(generated):
    for split in LOGGED_SPLITS:
        df = load_logged_split(split)
        assert set(df.columns) <= ALLOWED_LOGGED_COLUMNS


def test_risk_eval_splits_contain_no_oracle_shaped_column(generated):
    for split in RISK_SPLITS:
        df = pd.read_csv(OUT_DIR / f"{split}.csv")
        offending = [c for c in df.columns if RISK_EVAL_BANNED_PATTERN.search(c)]
        assert offending == [], f"{split}.csv has oracle-shaped column(s): {offending}"
        assert "would_chargeback" in df.columns  # risk_eval's own label, not a leak


def test_oracle_file_has_the_columns_everything_else_is_forbidden_from_having(generated):
    df = pd.read_parquet(OUT_DIR / "oracle_counterfactuals.parquet")
    assert "is_truly_risky" in df.columns
    assert any(c.startswith("p_true_") for c in df.columns)
    assert any(c.startswith("y_true_") for c in df.columns)


def test_loader_source_never_references_the_oracle_file_by_name():
    loader_src = Path("scripts/data_b2b/loader.py").read_text(encoding="utf-8")
    assert "oracle_counterfactuals" not in loader_src


def test_loader_refuses_a_logged_csv_carrying_a_banned_column(tmp_path, monkeypatch):
    import scripts.data_b2b.loader as loader_module

    poisoned = tmp_path / "logged_train.csv"
    poisoned.write_text("event_id,days_overdue,would_chargeback\nevt_1,5,1\n", encoding="utf-8")
    monkeypatch.setattr(loader_module, "OUT_DIR", tmp_path)

    with pytest.raises(ValueError, match="oracle-shaped"):
        loader_module.load_logged_split("logged_train")


# ── Overlap / positivity ─────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def train_df(generated):
    return load_logged_split("logged_train")


def test_every_action_appears_at_all(train_df):
    seen = set(train_df["action"].unique())
    missing = set(ACTIONS) - seen
    assert not missing, f"action(s) never logged in logged_train: {missing}"


def test_action_by_chase_round_contingency_has_no_thin_cell(train_df):
    table = train_df.groupby(["chase_rounds_so_far", "action"]).size()
    thin = table[table < MIN_CELL_COUNT]
    assert thin.empty, f"contingency cell(s) below the {MIN_CELL_COUNT}-row floor:\n{thin}"


def test_the_rarest_action_still_gets_a_meaningful_share(train_df):
    counts = train_df["action"].value_counts()
    rarest = counts.min()
    assert rarest >= MIN_CELL_COUNT, f"rarest action count {rarest} is suspiciously low for {len(train_df)} rows"


# ── Generator difficulty ─────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def model():
    import json
    path = OUT_DIR / "recovery_model.json"
    if not path.exists():
        pytest.skip("no trained B2B model — run `npm run scorer:train:b2b` first")
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def brier_bayes(model):
    demo = pd.read_csv(OUT_DIR / "logged_demo.csv")
    oracle = pd.read_parquet(OUT_DIR / "oracle_counterfactuals.parquet")
    merged = demo[["event_id", "action"]].merge(oracle, on="event_id", how="left")
    p_true_for_chosen = merged.apply(lambda r: r[f"p_true_{r['action']}"], axis=1).to_numpy(dtype="float64")
    return float(np.mean(p_true_for_chosen * (1 - p_true_for_chosen)))


def test_holdout_auc_in_a_defensible_band(model):
    auc = model["metrics"]["roc_auc"]
    assert 0.6 <= auc <= 0.85, f"holdout AUC {auc} outside [0.6, 0.85] — task is too easy or too hard"


def test_brier_skill_score_in_a_defensible_band(model):
    bss = model["metrics"]["bss"]
    assert 0.05 <= bss <= 0.35, f"BSS {bss} outside [0.05, 0.35] — task is too easy or too hard"


def test_model_genuinely_underfits_the_bayes_floor(model, brier_bayes):
    brier_model = model["metrics"]["brier_after_platt"]
    gap = brier_model - brier_bayes
    assert gap > 0.01, (
        f"brier_model ({brier_model}) - brier_bayes ({brier_bayes}) = {gap}, "
        "not enough of a gap — the shipped model is coming suspiciously close to "
        "recovering the generator's own irreducible noise floor."
    )


def test_scaler_fold_was_verified_before_the_json_was_written(model):
    assert model["metrics"]["scaler_fold_parity_max_diff"] < 1e-12
