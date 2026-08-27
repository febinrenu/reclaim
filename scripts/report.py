"""
Entry point: `python -m scripts.report` (wired as `npm run report`).

BUILD_PLAN.md §6.11: "No number in the database, the charts, the docs, or the
README is ever hand-typed." This script is what makes that literally true for
every headline number that appears in `docs/RESULTS.md` and gets quoted from
there into `README.md`: it reads nothing but the artifacts every earlier day
already committed (`recovery_model.json` x2, `ope_results.json`,
`risk_eval_results.json`, each scenario's `manifest.json`) and writes one
markdown file. Nobody hand-types a metric into a doc; they re-run this after
the artifact that produced it changes.

Deliberately does NOT replace `docs/EVALUATION.md`, which is this project's
own development diary — the tuning passes, the bugs found and fixed, the
reasoning behind each choice — written incrementally as each day's work
landed. That narrative has no single source-of-truth artifact to regenerate
from; only the numbers do, and this script owns exactly those.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = REPO_ROOT / "docs" / "RESULTS.md"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def fmt_pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def fmt_inr(x: float) -> str:
    return f"₹{x:,.2f}"


def scenario_section(name: str, model: dict, manifest: dict) -> str:
    m = model["metrics"]
    summary = manifest["summary"]
    lines = [
        f"### {name}",
        "",
        f"Generated from seed `{manifest['seed']}` — `{summary.get('total_events', '?')}` events, "
        f"`{summary.get('n_customers', '?')}` customers. Split sizes: "
        + ", ".join(f"{k}={v}" for k, v in model["trainedOn"].items()) + ".",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Base rate (train) | {fmt_pct(m['train_base_rate'])} |",
        f"| Brier score (after Platt) | {m['brier_after_platt']:.4f} |",
        f"| Brier skill score (BSS) | {m['bss']:.4f} |",
        f"| ROC-AUC | {m['roc_auc']:.4f} |",
        f"| ECE @ k=10 | {m['ece']['10']:.4f} |",
        f"| MCE @ k=10 | {m['mce_k10']:.4f} |",
        f"| Scaler-fold parity (max diff) | {m['scaler_fold_parity_max_diff']:.2e} |",
        "",
    ]
    return "\n".join(lines)


def ope_section(ope: dict) -> str:
    lines = [
        "## Off-policy evaluation — the six-policy bracket",
        "",
        f"Split: `{ope['split']}`, {ope['n_events']} events, {ope['n_transactions']} transactions, seed `{ope['seed']}`.",
        "",
        "| Policy | Estimator | Value (₹/txn) | 95% CI | ESS | Oracle (₹/txn) | Error % |",
        "|---|---|---|---|---|---|---|",
    ]
    for p in ope["policies"]:
        ci = f"[{p['ci_low_inr']:.2f}, {p['ci_high_inr']:.2f}]" if p["ci_low_inr"] is not None else "n/a"
        ess = f"{p['ess']:.0f}" if p["ess"] is not None else "n/a"
        oracle = f"{p['oracle_value_inr']:.2f}" if p["oracle_value_inr"] is not None else "n/a"
        err = f"{p['estimator_error_pct']:.1f}" if p["estimator_error_pct"] is not None else "n/a"
        lines.append(f"| {p['policy']} | {p['estimator']} | {p['value_inr']:.2f} | {ci} | {ess} | {oracle} | {err} |")
    lines.append("")
    reclaim = next(p for p in ope["policies"] if p["policy"] == "Reclaim")
    b4 = next(p for p in ope["policies"] if p["policy"] == "B4")
    lines.append(
        f"**Headline claim:** the doubly-robust estimate of Reclaim's net recovery was "
        f"{fmt_inr(reclaim['value_inr'])}/transaction (95% CI [{fmt_inr(reclaim['ci_low_inr'])}, "
        f"{fmt_inr(reclaim['ci_high_inr'])}]). Ground truth, from held-out oracle counterfactuals the "
        f"estimator never saw, was {fmt_inr(reclaim['oracle_value_inr'])} — an error of "
        f"{reclaim['estimator_error_pct']:.1f}%. The incumbent logging policy (B4) came in at "
        f"{fmt_inr(b4['value_inr'])}, oracle {fmt_inr(b4['oracle_value_inr'])}, error {b4['estimator_error_pct']:.1f}%."
    )
    lines.append("")
    lines.append(f"`HeadroomCaptured = (Reclaim − B4) / (B5 − B4) = {fmt_pct(ope['headroom_captured'])}`")
    lines.append("")
    return "\n".join(lines)


def risk_section(risk: dict) -> str:
    at_best = risk["at_best_threshold"]
    bracket = risk["cost_bracket_inr"]
    lines = [
        "## The risk gate's own evaluation",
        "",
        f"Calibration split n={risk['n_calibration']}, demo split n={risk['n_demo']}. "
        f"Demo prevalence (base rate): {fmt_pct(risk['demo_prevalence'])}.",
        "",
        f"PR-AUC: **{risk['pr_auc']:.4f}** against a prevalence baseline of {risk['pr_auc_baseline_prevalence']:.4f} "
        f"— {risk['pr_auc'] / risk['pr_auc_baseline_prevalence']:.1f}× lift.",
        "",
        f"At the calibration-chosen threshold ({risk['best_threshold']:.2f}): "
        f"precision {fmt_pct(at_best['precision'])}, recall {fmt_pct(at_best['recall'])} "
        f"({at_best['tp']} true positives, {at_best['fp']} false positives, {at_best['fn']} false negatives).",
        "",
        "| Policy | Cost (demo split) |",
        "|---|---|",
        f"| Flag nothing | {fmt_inr(bracket['flag_nothing'])} |",
        f"| Flag everything | {fmt_inr(bracket['flag_everything'])} |",
        f"| Chosen operating point | {fmt_inr(bracket['at_best_threshold'])} |",
        "",
        f"False-positive cost at the chosen threshold: {fmt_inr(at_best['false_positive_cost_inr'])} "
        f"across {at_best['fp']} unnecessary escalations.",
        "",
    ]
    return "\n".join(lines)


def customer_disjoint_section(report: dict) -> str:
    overlap = report["overlap_under_the_shipped_temporal_split"]
    shipped = report["shipped_model_demo_metrics"]
    summary = report["customer_disjoint_summary"]
    lines = [
        "## Customer-disjoint validation — subscription scenario",
        "",
        "The shipped split (`SPLIT_MONTHS`) is chronological, not customer-disjoint: the DGP's",
        "customer pool is fixed once and reused across the whole timeline, so the same",
        "customer can appear in both `logged_train` and `logged_demo`. Full account:",
        "`docs/CUSTOMER_DISJOINT_VALIDATION.md`.",
        "",
        f"**{overlap['n_customers_train_and_demo']} of {overlap['n_customers_demo']}** demo customers"
        f" ({fmt_pct(overlap['fraction_of_demo_customers_also_in_train'])}) also appear in train, accounting for"
        f" {fmt_pct(overlap['fraction_of_demo_rows_from_a_train_customer'])} of demo rows.",
        "",
        "| | Shipped (temporal holdout) | Customer-disjoint holdout |",
        "|---|---|---|",
        f"| Brier (after Platt) | {shipped['brier_after_platt']:.4f} |"
        f" {summary.get('brier_after_platt_mean', float('nan')):.4f} ± {summary.get('brier_after_platt_std', float('nan')):.4f} |",
        f"| ROC-AUC | {shipped['roc_auc']:.4f} |"
        f" {summary.get('roc_auc_mean', float('nan')):.4f} ± {summary.get('roc_auc_std', float('nan')):.4f} |",
        f"| ECE @ k=10 | {shipped['ece_k10']:.4f} |"
        f" {summary.get('ece_k10_mean', float('nan')):.4f} ± {summary.get('ece_k10_std', float('nan')):.4f} |",
        "",
        f"({summary.get('n_valid_seeds', 0)} seeds.) The model measurably underperforms its reported number on",
        "genuinely unseen customers — a real finding, not hidden: the temporal-split Brier this project",
        "otherwise reports throughout is optimistic relative to true cold-customer performance.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    sub_model = load(REPO_ROOT / "data" / "synthetic" / "subscription" / "recovery_model.json")
    sub_manifest = load(REPO_ROOT / "data" / "synthetic" / "subscription" / "manifest.json")
    b2b_model = load(REPO_ROOT / "data" / "synthetic" / "b2b_receivable" / "recovery_model.json")
    b2b_manifest = load(REPO_ROOT / "data" / "synthetic" / "b2b_receivable" / "manifest.json")
    ope = load(REPO_ROOT / "docs" / "ope_results.json")
    risk = load(REPO_ROOT / "docs" / "risk_eval_results.json")
    customer_disjoint = load(REPO_ROOT / "docs" / "customer_disjoint_validation.json")

    parts = [
        "# Results",
        "",
        "**Generated by `scripts/report.py` (`npm run report`) from the committed artifacts each earlier",
        "day's own training/evaluation scripts wrote — never hand-typed. Re-run the generator after any",
        "of those scripts change and this file changes with it, not the other way around.**",
        "",
        "## Recovery scorer",
        "",
        scenario_section("Subscription scenario", sub_model, sub_manifest),
        scenario_section("B2B receivables scenario", b2b_model, b2b_manifest),
        customer_disjoint_section(customer_disjoint),
        ope_section(ope),
        risk_section(risk),
    ]

    OUT_PATH.write_text("\n".join(parts) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
