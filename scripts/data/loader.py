"""
The one way anything downstream is allowed to read a logged split
(BUILD_PLAN.md §6.3): "The CSV loader takes a column allowlist derived from
FEATURE_ORDER and raises on anything else." Two independent protections stack here:

  1. `eval/test_oracle_firewall.py` statically greps this module and D5's training
     script for any reference to the oracle file or a banned column name.
  2. This loader *itself* refuses, at read time, to load a logged CSV containing an
     unexpected column — so even a future edit that quietly adds a leaking column to
     a logged CSV fails loudly the next time anything tries to load it, rather than
     depending on the static grep catching every future case.
"""
import re

import pandas as pd

from .common import OUT_DIR, FEATURE_ORDER, LOGGED_BOOKKEEPING_COLUMNS, BANNED_COLUMN_PATTERN

ALLOWED_LOGGED_COLUMNS = set(LOGGED_BOOKKEEPING_COLUMNS) | set(FEATURE_ORDER)
_BANNED = re.compile(BANNED_COLUMN_PATTERN)


def load_logged_split(name: str) -> pd.DataFrame:
    """`name` is one of 'logged_train', 'logged_calibration', 'logged_demo'."""
    path = OUT_DIR / f"{name}.csv"
    df = pd.read_csv(path)

    banned = [c for c in df.columns if _BANNED.search(c)]
    if banned:
        raise ValueError(
            f"{path.name} has oracle-shaped column(s) that must never reach the "
            f"recovery-scorer training or evaluation path: {banned}. See BUILD_PLAN.md §6.3."
        )
    unexpected = [c for c in df.columns if c not in ALLOWED_LOGGED_COLUMNS]
    if unexpected:
        raise ValueError(
            f"{path.name} has column(s) not in the FEATURE_ORDER allowlist: {unexpected}. "
            "If this is a genuinely new feature, add it to FEATURE_ORDER in "
            "scripts/data/common.py first — do not widen this loader to ignore it."
        )
    return df


def feature_matrix(df: pd.DataFrame):
    """The dense, ordered feature block D5's fit and TypeScript's `scoreLogistic`
    must agree on — see BUILD_PLAN.md §6.8's parity contract. Raises on a missing
    or NaN feature rather than silently imputing, for the same reason
    src/domain/scoring/logistic.ts does."""
    missing = [c for c in FEATURE_ORDER if c not in df.columns]
    if missing:
        raise ValueError(f"feature_matrix: missing required feature column(s): {missing}")
    block = df[FEATURE_ORDER]
    if block.isna().any().any():
        bad = block.columns[block.isna().any()].tolist()
        raise ValueError(f"feature_matrix: NaN values in feature column(s): {bad}")
    return block.to_numpy(dtype="float64")
