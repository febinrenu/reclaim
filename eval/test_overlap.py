"""
Positivity / overlap (BUILD_PLAN.md §6.2 Trap 2, §6.4): every action must have
genuine support in every region of state space, or an importance-weighted
off-policy estimate (D8) is extrapolating rather than estimating. The epsilon-greedy
logging policy guarantees a propensity floor of 0.20/6 ≈ 0.0333 everywhere by
construction; this test is the empirical check that the floor actually produced
enough *rows*, not just enough probability mass, in the split D5 will fit on.

The D4 exit test's own bar: **every contingency cell has at least 30 rows.**
"""
import pytest

from scripts.data.common import ACTIONS, OUT_DIR
from scripts.data.loader import load_logged_split

MIN_CELL_COUNT = 30


@pytest.fixture(scope="module")
def train_df():
    if not (OUT_DIR / "manifest.json").exists():
        pytest.skip("no generated data — run `npm run data:generate` first")
    return load_logged_split("logged_train")


def test_every_action_appears_at_all(train_df):
    seen = set(train_df["action"].unique())
    missing = set(ACTIONS) - seen
    assert not missing, f"action(s) never logged in logged_train: {missing}"


def test_action_by_retry_index_contingency_has_no_thin_cell(train_df):
    table = train_df.groupby(["retry_count_so_far", "action"]).size()
    thin = table[table < MIN_CELL_COUNT]
    assert thin.empty, f"contingency cell(s) below the {MIN_CELL_COUNT}-row floor:\n{thin}"


def test_action_by_bank_recent_fail_rate_bucket_has_no_thin_cell(train_df):
    # A median split, not a fixed threshold: the overall recorded recovery rate is
    # well under 50%, so bank_recent_fail_rate (1 - trailing recovery rate) usually
    # reads "high" against any fixed cutoff regardless of genuine bank-level
    # variation. A median split checks overlap along this dimension without that
    # baseline-rate artifact skewing which bucket most rows fall into.
    median = train_df["bank_recent_fail_rate"].median()
    buckets = train_df["bank_recent_fail_rate"].apply(lambda x: "above_median" if x >= median else "below_median")
    table = train_df.groupby([buckets, train_df["action"]]).size()
    thin = table[table < MIN_CELL_COUNT]
    assert thin.empty, f"contingency cell(s) below the {MIN_CELL_COUNT}-row floor:\n{thin}"


def test_the_rarest_action_still_gets_a_meaningful_share(train_df):
    counts = train_df["action"].value_counts()
    rarest = counts.min()
    # BUILD_PLAN.md §6.2: "the rarest action still gets roughly 240 pure-exploration
    # rows" on 7,200 training rows. Generation is stochastic, so this checks the
    # spirit of that claim rather than the exact figure.
    assert rarest >= 150, f"rarest action count {rarest} is suspiciously low for {len(train_df)} rows"
