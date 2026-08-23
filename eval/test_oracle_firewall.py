"""
BUILD_PLAN.md §6.3's oracle firewall: the recovery-scorer's training and evaluation
sources (the three logged_*.csv splits) must contain no reference to the oracle
counterfactual file's columns, and the loader that reads them must refuse to load a
file that does. `is_truly_risky` and `would_chargeback` belong to the risk gate's own
labelled set (risk_eval_*.csv), not to the recovery scorer's data at all.
"""
import re
from pathlib import Path

import pandas as pd
import pytest

from scripts.data.common import OUT_DIR, BANNED_COLUMN_PATTERN
from scripts.data.loader import load_logged_split, ALLOWED_LOGGED_COLUMNS

LOGGED_SPLITS = ["logged_train", "logged_calibration", "logged_demo"]
RISK_SPLITS = ["risk_eval_train", "risk_eval_calibration", "risk_eval_demo"]

# Narrower than BANNED_COLUMN_PATTERN: risk_eval's own label, would_chargeback, is
# legitimate there — see SYSTEM_SPEC.md §11.1. Only the oracle-shaped columns and the
# raw latent are actually banned from risk_eval too.
RISK_EVAL_BANNED_PATTERN = re.compile(r"p_true|y_true_|is_truly_risky")


@pytest.fixture(scope="module")
def generated():
    if not (OUT_DIR / "manifest.json").exists():
        pytest.skip("no generated data — run `npm run data:generate` first")
    return True


def test_logged_splits_contain_no_oracle_shaped_column(generated):
    pattern = re.compile(BANNED_COLUMN_PATTERN)
    for split in LOGGED_SPLITS:
        df = pd.read_csv(OUT_DIR / f"{split}.csv")
        offending = [c for c in df.columns if pattern.search(c)]
        assert offending == [], f"{split}.csv has banned column(s): {offending}"


def test_logged_splits_load_through_the_allowlisting_loader(generated):
    for split in LOGGED_SPLITS:
        df = load_logged_split(split)  # raises on any unexpected or banned column
        assert set(df.columns) <= ALLOWED_LOGGED_COLUMNS


def test_risk_eval_splits_contain_no_oracle_shaped_column(generated):
    for split in RISK_SPLITS:
        df = pd.read_csv(OUT_DIR / f"{split}.csv")
        offending = [c for c in df.columns if RISK_EVAL_BANNED_PATTERN.search(c)]
        assert offending == [], f"{split}.csv has oracle-shaped column(s): {offending}"
        # would_chargeback is risk_eval's own legitimate label, not a leak.
        assert "would_chargeback" in df.columns


def test_oracle_file_actually_has_the_columns_everything_else_is_forbidden_from_having(generated):
    df = pd.read_parquet(OUT_DIR / "oracle_counterfactuals.parquet")
    assert "is_truly_risky" in df.columns
    assert any(c.startswith("p_true_") for c in df.columns)
    assert any(c.startswith("y_true_") for c in df.columns)


def test_loader_source_never_references_the_oracle_file_by_name():
    # Checks the literal filename, not the word "oracle" — this module's own
    # docstring explains *why* the loader must stay oblivious to the oracle file,
    # which necessarily uses the word "oracle" in prose. What must never appear is
    # a reference to the file itself.
    loader_src = Path("scripts/data/loader.py").read_text(encoding="utf-8")
    assert "oracle_counterfactuals" not in loader_src, (
        "scripts/data/loader.py must never reference the oracle file by name — "
        "doing so is exactly the leak this firewall exists to catch."
    )


def test_loader_refuses_a_logged_csv_carrying_a_banned_column(tmp_path, monkeypatch):
    import scripts.data.loader as loader_module

    poisoned = tmp_path / "logged_train.csv"
    poisoned.write_text("event_id,prior_success_rate,would_chargeback\nevt_1,0.5,1\n", encoding="utf-8")
    monkeypatch.setattr(loader_module, "OUT_DIR", tmp_path)

    with pytest.raises(ValueError, match="oracle-shaped"):
        loader_module.load_logged_split("logged_train")
