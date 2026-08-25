"""
B2B's own instance of the column-allowlist loader (BUILD_PLAN.md §6.3) — see
`scripts/data/loader.py`'s docstring for the full rationale; identical
discipline, independent of subscription's `FEATURE_ORDER`/`OUT_DIR`.
"""
import re

import pandas as pd

from .common import OUT_DIR, FEATURE_ORDER, LOGGED_BOOKKEEPING_COLUMNS, BANNED_COLUMN_PATTERN

ALLOWED_LOGGED_COLUMNS = set(LOGGED_BOOKKEEPING_COLUMNS) | set(FEATURE_ORDER)
_BANNED = re.compile(BANNED_COLUMN_PATTERN)


def load_logged_split(name: str) -> pd.DataFrame:
    path = OUT_DIR / f"{name}.csv"
    df = pd.read_csv(path)

    banned = [c for c in df.columns if _BANNED.search(c)]
    if banned:
        raise ValueError(
            f"{path.name} has oracle-shaped column(s) that must never reach the "
            f"recovery-scorer training or evaluation path: {banned}."
        )
    unexpected = [c for c in df.columns if c not in ALLOWED_LOGGED_COLUMNS]
    if unexpected:
        raise ValueError(
            f"{path.name} has column(s) not in the FEATURE_ORDER allowlist: {unexpected}. "
            "If this is a genuinely new feature, add it to FEATURE_ORDER in "
            "scripts/data_b2b/common.py first — do not widen this loader to ignore it."
        )
    return df


def feature_matrix(df: pd.DataFrame):
    missing = [c for c in FEATURE_ORDER if c not in df.columns]
    if missing:
        raise ValueError(f"feature_matrix: missing required feature column(s): {missing}")
    block = df[FEATURE_ORDER]
    if block.isna().any().any():
        bad = block.columns[block.isna().any()].tolist()
        raise ValueError(f"feature_matrix: NaN values in feature column(s): {bad}")
    return block.to_numpy(dtype="float64")
