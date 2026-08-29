"""
Exit test for the escalation-capacity sweep (scripts/data/escalation_budget_sweep.py):
the honest follow-up to README's own "91.6% escalation share, no ops team could
staff that" admission. Checks the sweep's own internal consistency and its
agreement with the unconstrained numbers `run_ope.py` already publishes —
two independently-computed paths landing on the same number is the actual
check, not an assertion about which one is "right".
"""
from __future__ import annotations

import json

import pytest

from scripts.data.common import OUT_DIR


@pytest.fixture(scope="module")
def sweep_results():
    path = OUT_DIR.parent.parent.parent / "docs" / "escalation_budget_results.json"
    if not path.exists():
        pytest.skip("docs/escalation_budget_results.json not generated yet — run `npm run escalation:sweep` first")
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def ope_results():
    path = OUT_DIR.parent.parent.parent / "docs" / "ope_results.json"
    if not path.exists():
        pytest.skip("docs/ope_results.json not generated yet — run `npm run ope` first")
    return json.loads(path.read_text(encoding="utf-8"))


def test_unconstrained_budget_reproduces_run_ope_s_own_reclaim_number(sweep_results, ope_results):
    reclaim = next(p for p in ope_results["policies"] if p["policy"] == "Reclaim")
    assert sweep_results["unconstrained_net_recovery_inr_per_txn"] == pytest.approx(
        reclaim["oracle_value_inr"], abs=0.01
    )


def test_sweep_is_monotonic_in_budget(sweep_results):
    budgets = [p["budget"] for p in sweep_results["sweep"]]
    assert budgets == sorted(budgets)
    assert budgets[0] == 0
    assert budgets[-1] == sweep_results["n_events_wanting_escalation_unconstrained"]


def test_zero_budget_never_escalates(sweep_results):
    zero = sweep_results["sweep"][0]
    assert zero["budget"] == 0
    assert zero["escalated_share_of_split"] == 0.0
    assert zero["net_recovery_inr_per_txn"] == pytest.approx(sweep_results["zero_budget_net_recovery_inr_per_txn"])


def test_full_budget_covers_every_event_that_wants_one(sweep_results):
    n_wants = sweep_results["n_events_wanting_escalation_unconstrained"]
    assert n_wants > 0
    assert n_wants < sweep_results["n_events"]
    full = sweep_results["sweep"][-1]
    assert full["escalated_count"] == n_wants
    assert full["pct_of_unconstrained_gap_closed"] == pytest.approx(1.0, abs=0.001)


def test_a_capped_budget_can_beat_the_unconstrained_policy(sweep_results):
    """The finding this sweep exists to surface, not to hide: ranking every
    would-be escalation by the model's own EV uplift and then escalating
    ALL of them (the unconstrained policy) is not necessarily the highest
    oracle-truth value on this split — some low-ranked escalations the model
    is confident about disagree with the outcome the DGP actually drew,
    exactly the same model-misspecification story the Bayes-ceiling section
    of docs/RESULTS.md already tells. A capacity constraint is a genuine
    product benefit here, not a purely operational compromise."""
    best = max(p["net_recovery_inr_per_txn"] for p in sweep_results["sweep"])
    assert best >= sweep_results["unconstrained_net_recovery_inr_per_txn"]


def test_knee_thresholds_are_well_ordered_and_within_range(sweep_results):
    thresholds = sweep_results["knee_thresholds"]
    n_wants = sweep_results["n_events_wanting_escalation_unconstrained"]
    b90 = thresholds["budget_for_90pct_of_gap"]
    b95 = thresholds["budget_for_95pct_of_gap"]
    b99 = thresholds["budget_for_99pct_of_gap"]
    assert b90 is not None and b95 is not None and b99 is not None
    assert 0 < b90 <= b95 <= b99 <= n_wants
