"""
D11: checks the risk gate evaluation script against BUILD_PLAN.md §6.6's own
claims — a curve, not a number; the operating point beats both brackets; and
that the weights this script uses are the exact same constants
`src/domain/risk/rules.ts` ships (checked by literal value, since there is no
shared artifact between the two languages here the way the recovery model has).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from scripts.data.common import OUT_DIR
from scripts.data.risk_eval import RISK_WEIGHTS, risk_score, pr_auc, pr_curve, cost_false_negative_paise, cost_false_positive_paise


def test_weights_match_the_shipped_typescript_exactly():
    # src/domain/risk/rules.ts's DEFAULT_RISK_RULES, copied by hand — this test
    # is the only thing standing between the two silently drifting apart.
    assert RISK_WEIGHTS == {
        "geo_mismatch": 0.2,
        "card_velocity_high": 0.35,
        "amount_far_above_history": 0.15,
        "card_first_seen_recently": 0.3,
    }


def test_risk_score_is_the_sum_of_present_signal_weights():
    row = pd.Series({"geo_mismatch": 1, "card_velocity_high": 0, "amount_far_above_history": 1, "card_first_seen_recently": 0})
    assert risk_score(row) == pytest.approx(0.2 + 0.15)

    all_off = pd.Series({"geo_mismatch": 0, "card_velocity_high": 0, "amount_far_above_history": 0, "card_first_seen_recently": 0})
    assert risk_score(all_off) == pytest.approx(0.0)

    all_on = pd.Series({"geo_mismatch": 1, "card_velocity_high": 1, "amount_far_above_history": 1, "card_first_seen_recently": 1})
    assert risk_score(all_on) == pytest.approx(1.0)


def test_pr_curve_recall_is_monotonic_and_bounded():
    y = np.array([1, 1, 0, 0, 1, 0])
    scores = np.array([0.9, 0.7, 0.6, 0.4, 0.3, 0.1])
    points = pr_curve(y, scores)
    recalls = [p["recall"] for p in points]
    assert recalls == sorted(recalls)
    assert recalls[0] >= 0.0
    assert recalls[-1] <= 1.0 + 1e-9


def test_pr_auc_is_perfect_for_a_perfectly_separating_score():
    y = np.array([1, 1, 0, 0])
    scores = np.array([0.9, 0.8, 0.2, 0.1])  # every positive scores above every negative
    points = pr_curve(y, scores)
    assert pr_auc(points) == pytest.approx(1.0, abs=1e-6)


def test_cost_formula_matches_system_spec_11_1():
    # C_FN(i) = amount_i + Rs500 dispute handling + Rs150 representment
    assert cost_false_negative_paise(1000_00) == pytest.approx(1000_00 + 500_00 + 150_00)
    # C_FP(i) = Rs40 agent time + Rs12 churn externality + 0.05*amount_i
    assert cost_false_positive_paise(1000_00) == pytest.approx(40_00 + 12_00 + 0.05 * 1000_00)


@pytest.fixture(scope="module")
def risk_eval_results() -> dict:
    path = OUT_DIR.parent.parent.parent / "docs" / "risk_eval_results.json"
    if not path.exists():
        pytest.skip("docs/risk_eval_results.json not generated yet — run `npm run risk:eval` first")
    return json.loads(path.read_text(encoding="utf-8"))


def test_pr_auc_clears_its_own_prevalence_baseline(risk_eval_results):
    # BUILD_PLAN.md §6.6: "Report PR-AUC against its correct baseline, which
    # equals the prevalence." A gate worth reporting should clear it with margin.
    assert risk_eval_results["pr_auc"] > risk_eval_results["pr_auc_baseline_prevalence"] * 2


def test_the_chosen_operating_point_beats_both_brackets(risk_eval_results):
    # SYSTEM_SPEC.md §11.1's complete argument: "flag nothing costs X, flag
    # everything costs Y, our operating point costs Z" — Z must actually be
    # the cheapest of the three for that sentence to mean anything.
    bracket = risk_eval_results["cost_bracket_inr"]
    assert bracket["at_best_threshold"] < bracket["flag_nothing"]
    assert bracket["at_best_threshold"] < bracket["flag_everything"]


def test_threshold_was_chosen_on_calibration_not_demo(risk_eval_results):
    # A structural check, not a numeric one: the script's own main() computes
    # best_threshold from risk_eval_calibration.csv before ever touching demo
    # scores for anything but reporting — asserted here by re-deriving it and
    # confirming the committed result matches, which would fail if a future
    # edit accidentally threaded demo data into threshold selection.
    from scripts.data.risk_eval import main  # noqa: F401 — imported to prove main is importable/idempotent to reason about
    calib = pd.read_csv(OUT_DIR / "risk_eval_calibration.csv")
    calib_scores = calib.apply(risk_score, axis=1).to_numpy()
    from scripts.data.risk_eval import total_cost_paise
    candidates = sorted(set(calib_scores.tolist()))
    costs = [(t, total_cost_paise(calib, calib_scores, t)) for t in candidates]
    best_threshold, _ = min(costs, key=lambda item: item[1])
    assert best_threshold == pytest.approx(risk_eval_results["best_threshold"])
