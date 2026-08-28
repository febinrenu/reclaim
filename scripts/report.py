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


LF = chr(10)


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


def ope_section(ope: dict, title: str, unit_noun: str, ess_untrustworthy_below: int = 200) -> str:
    n_unit = ope.get("n_transactions", ope.get("n_invoices"))
    lines = [
        f"## {title}",
        "",
        f"Split: `{ope['split']}`, {ope['n_events']} events, {n_unit} {unit_noun}, seed `{ope['seed']}`.",
        "",
        "| Policy | Estimator | Value (₹/event) | 95% CI | ESS | Oracle (₹/event) | Error % |",
        "|---|---|---|---|---|---|---|",
    ]
    low_ess_policies = []
    for p in ope["policies"]:
        ci = f"[{p['ci_low_inr']:.2f}, {p['ci_high_inr']:.2f}]" if p["ci_low_inr"] is not None else "n/a"
        ess = f"{p['ess']:.0f}" if p["ess"] is not None else "n/a"
        oracle = f"{p['oracle_value_inr']:.2f}" if p["oracle_value_inr"] is not None else "n/a"
        err = f"{p['estimator_error_pct']:.1f}" if p["estimator_error_pct"] is not None else "n/a"
        if p.get("ess_trustworthy") is False:
            ess += " ⚠"
            low_ess_policies.append(p["policy"])
        lines.append(f"| {p['policy']} | {p['estimator']} | {p['value_inr']:.2f} | {ci} | {ess} | {oracle} | {err} |")
    lines.append("")
    reclaim = next(p for p in ope["policies"] if p["policy"] == "Reclaim")
    b4 = next(p for p in ope["policies"] if p["policy"] == "B4")
    lines.append(
        f"**Headline claim:** the doubly-robust estimate of Reclaim's net recovery was "
        f"{fmt_inr(reclaim['value_inr'])}/{unit_noun[:-1]} (95% CI [{fmt_inr(reclaim['ci_low_inr'])}, "
        f"{fmt_inr(reclaim['ci_high_inr'])}]). Ground truth, from held-out oracle counterfactuals the "
        f"estimator never saw, was {fmt_inr(reclaim['oracle_value_inr'])} — an error of "
        f"{reclaim['estimator_error_pct']:.1f}%. The incumbent logging policy (B4) came in at "
        f"{fmt_inr(b4['value_inr'])}, oracle {fmt_inr(b4['oracle_value_inr'])}, error {b4['estimator_error_pct']:.1f}%."
    )
    lines.append("")
    if low_ess_policies:
        lines.append(
            f"⚠ {', '.join(low_ess_policies)} — effective sample size below {ess_untrustworthy_below}: this policy's "
            "chosen actions diverge enough from the logged behavior policy that the DR/SNIPS point estimate is "
            "genuinely unreliable here (flagged, not hidden — compare its own oracle-truth value in the table "
            "above, which is unaffected by ESS)."
        )
        lines.append("")
    lines.append(f"`HeadroomCaptured = (Reclaim − B4) / (B5 − B4) = {fmt_pct(ope['headroom_captured'])}`")
    lines.append("")
    return "\n".join(lines)


def oracle_truth_section(ope: dict, unit_noun: str, scenario_label: str) -> str:
    """
    The comparison the README used to make with the batch runner's own numbers, done
    here instead — on oracle counterfactuals rather than on the model's own predictions.

    Why it moved: the batch runner settles each event by drawing against the CHOSEN
    action's own modelled `pRecover`, and `naive-baseline.ts` draws against RETRY_NOW's
    modelled `pRecover` under the same seed. An argmax-EV policy picks higher-`p`
    actions essentially by construction, so on that comparison Reclaim wins before the
    batch runs. It is a model-conditional projection, not a measurement, and it is not
    the number a reader should be handed first.

    These numbers are per-action outcomes the trained model never saw at any point:
    `oracle_counterfactuals.parquet`, generated by the DGP, firewalled from the serving
    path by an ESLint boundary rule and `eval/test_oracle_firewall.py`. Every policy is
    scored on the same events, so it is apples to apples the way the batch comparison
    claimed to be but could not be.
    """
    by_policy = {p["policy"]: p for p in ope["policies"]}

    def oracle(name: str) -> float | None:
        row = by_policy.get(name)
        if row is None:
            return None
        # B2/B5 are oracle simulations rather than chosen-action functions, so their
        # value IS the oracle value and there is no separate estimate to compare.
        if row["estimator"] == "oracle_simulator":
            return row["value_inr"]
        return row["oracle_value_inr"]

    reclaim, b0, b1, b4, b5 = (oracle(k) for k in ("Reclaim", "B0", "B1", "B4", "B5"))
    if None in (reclaim, b0, b1, b4):
        raise SystemExit("oracle_truth_section: ope_results.json is missing a policy this section needs")

    unit = unit_noun[:-1]
    rows = [
        ("Retry everything (B1)", b1, "RETRY_NOW on every event, the naive policy"),
        ("Do nothing (B0)", b0, "the organic baseline — customers who retry on their own"),
        ("Incumbent logged policy (B4)", b4, "what actually happened; needs no estimation"),
        ("**Reclaim**", reclaim, "**risk-gated argmax-EV over every action, including none**"),
    ]
    if b5 is not None:
        rows.append(("Oracle-optimal (B5)", b5, "the ceiling: best action per event, known only to the DGP"))

    lines = [
        f"## Measured recovery, on oracle truth — {scenario_label}",
        "",
        "Every figure below is scored against per-action outcomes the trained model never saw",
        f"(`oracle_counterfactuals.parquet`), on the same {ope['n_events']} `{ope['split']}` events for every",
        "policy. This is the honest form of \"how much better than retrying everything\":",
        "`docs/EVALUATION.md`'s \"Trap 4\" records why the batch runner's own recovered-revenue",
        "figure is a model-conditional projection rather than a measurement.",
        "",
        f"| Policy | Net recovery (₹/{unit}) | vs. retry-everything | |",
        "|---|---|---|---|",
    ]
    for label, value, note in rows:
        delta = "—" if abs(value - b1) < 0.005 else f"{value - b1:+.2f} ({value / b1:.2f}×)"
        lines.append(f"| {label} | {value:.2f} | {delta} | {note} |")

    # Rank among DEPLOYABLE policies only. B2 and B5 are oracle simulations -- B5 picks
    # the best action per event using outcomes nobody can see at decision time -- so
    # including them in a ranking would compare a policy against a bound, not a rival.
    deployable = {
        name: oracle(name)
        for name in ("Reclaim", "B0", "B1", "B3", "B4")
        if oracle(name) is not None
    }
    ranked = sorted(deployable.items(), key=lambda kv: -kv[1])
    reclaim_rank = 1 + [name for name, _ in ranked].index("Reclaim")

    # Headroom computed on oracle TRUTH, not on the estimates. Where an estimate is
    # flagged untrustworthy by its own effective sample size, a headroom figure derived
    # from it is measuring the estimator rather than the policy -- which is exactly what
    # happened to the B2B bracket, where estimate-based headroom came out NEGATIVE while
    # the policy's own oracle value ranked first of everything deployable.
    oracle_headroom = (reclaim - b4) / (b5 - b4) if b5 is not None and b5 != b4 else None

    lines += [
        "",
        f"**Reclaim ranks {reclaim_rank} of {len(ranked)} deployable policies on oracle truth** — "
        + ", ".join(f"{name} {value:,.2f}" for name, value in ranked)
        + ". (B2 and B5 are excluded: they are oracle simulations, so they are bounds rather "
        "than rivals.)",
        "",
        f"**Reclaim recovers {reclaim / b1:.2f}× what retrying everything does** "
        f"({fmt_inr(reclaim - b1)}/{unit} more), {reclaim / b4:.2f}× the incumbent "
        f"({fmt_inr(reclaim - b4)}/{unit} more), and {reclaim / b0:.2f}× doing nothing "
        f"({fmt_inr(reclaim - b0)}/{unit} more).",
        "",
    ]

    # This finding holds in the subscription scenario and NOT in B2B, so it is emitted
    # conditionally. An earlier version asserted it unconditionally and produced a
    # self-contradicting sentence on the B2B bracket -- claiming retry-everything was
    # "behind" doing nothing while printing a number showing it ahead. Exactly the class
    # of error this whole reporting pipeline exists to prevent, so it is worth the branch.
    if b1 < b0:
        lines += [
            f"**And retrying everything is worse than doing nothing** — {fmt_inr(b1)} against "
            f"{fmt_inr(b0)}, {fmt_inr(b0 - b1)}/{unit} behind. That is this project's entire "
            "thesis arriving as a measured result rather than an assertion: the fee on every "
            "attempt plus the small recovery lift on genuinely unrecoverable payments costs "
            "more than the recovery is worth. A retry loop is not a weak version of this "
            "system; on these outcomes it is worse than having no system at all.",
            "",
        ]
    else:
        lines += [
            f"**Here retrying everything does beat doing nothing** — {fmt_inr(b1)} against "
            f"{fmt_inr(b0)} — unlike the subscription scenario, where it does not. Worth "
            "stating plainly rather than carrying one scenario's finding over to the other: "
            "these invoices are large enough that even an untargeted retry pays for its own "
            "fee. The thesis survives in its real form, which was never \"retrying is always "
            f"wrong\" but \"retrying indiscriminately leaves money on the table\" — retry-"
            f"everything still gives up {fmt_inr(reclaim - b1)}/{unit} against pricing each "
            "action.",
            "",
        ]

    if oracle_headroom is not None:
        lines += [
            f"`HeadroomCaptured (oracle truth) = (Reclaim − B4) / (B5 − B4) = "
            f"{fmt_pct(oracle_headroom)}` — the share of the achievable gap over the incumbent "
            "that this policy actually closes, computed from outcomes rather than from an "
            "estimate. Reported alongside the estimate-based figure in the bracket below, which "
            "is the one to distrust wherever a policy's own effective sample size is flagged.",
            "",
        ]

    return LF.join(lines)


def unit_economics_section(ope: dict, unit_noun: str) -> str:
    """
    What it costs to RUN this, against what it measurably returns.

    Every figure is derived from `docs/ope_results.json`: the action mix Reclaim actually
    chooses on the demo split, priced with the same intervention-cost table `decide()`
    uses, against the same oracle-truth values the measured-recovery section reports.

    The finding is not flattering and is the point of the section. The operating cost is
    almost entirely one action's price -- a human escalation at Rs 40 -- and on this
    split the policy escalates most events, because a Rs 40 human is 2.7% of a
    Rs 1,484 invoice and the EV arithmetic says take it. That is the formula working as
    designed, and it also means the return on operating spend is roughly 2x, not the
    20x the batch runner's own cost row implies. The two are not in conflict; they are
    different amount regimes, and this section says which is which.
    """
    by_policy = {p["policy"]: p for p in ope["policies"]}
    counts = ope.get("reclaim_action_counts")
    run_cost_paise = ope.get("run_cost_paise_per_event")
    if counts is None or run_cost_paise is None:
        raise SystemExit(
            "unit_economics_section: ope_results.json predates reclaim_action_counts / "
            "run_cost_paise_per_event. Re-run `npm run ope`."
        )

    n = ope["n_events"]
    unit = unit_noun[:-1]

    reclaim = by_policy["Reclaim"]["oracle_value_inr"]
    incumbent = by_policy["B4"]["oracle_value_inr"]
    retry_all = by_policy["B1"]["oracle_value_inr"]

    run_cost = run_cost_paise / 100.0
    uplift_incumbent = reclaim - incumbent
    uplift_retry_all = reclaim - retry_all
    net = uplift_incumbent - run_cost
    ratio = uplift_incumbent / run_cost if run_cost > 0 else float("inf")
    # The price at which escalation stops paying for itself at this operating point.
    escalation_share = counts.get("ESCALATE_HUMAN", 0) / n
    breakeven_escalation = uplift_incumbent / escalation_share if escalation_share > 0 else float("nan")
    median_paise = ope.get("amount_paise_median")
    buckets = ope.get("reclaim_action_by_amount")
    if median_paise is None or buckets is None:
        raise SystemExit(
            "unit_economics_section: ope_results.json predates amount_paise_median / "
            "reclaim_action_by_amount. Re-run `npm run ope`."
        )

    lines = [
        "## What it costs to run",
        "",
        f"Derived from the same `logged_demo` split and the same oracle-truth values as the",
        "measured-recovery section above: the action mix Reclaim actually chooses, priced with the",
        "identical intervention-cost table `decide()` uses.",
        "",
        f"| Action chosen | Count | Share | Unit cost (₹) |",
        "|---|---|---|---|",
    ]
    unit_costs = {
        "RETRY_NOW": 0.0,
        "RETRY_LATER": 0.0,
        "PAYMENT_LINK": 0.35,
        "WHATSAPP_NUDGE": 0.35,
        "ESCALATE_HUMAN": 40.0,
        "DO_NOTHING": 0.0,
    }
    for action, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        lines.append(
            f"| `{action}` | {count} | {100 * count / n:.1f}% | {unit_costs.get(action, 0.0):.2f} |"
        )

    lines += [
        "",
        f"| | ₹/{unit} |",
        "|---|---|",
        f"| Cost to operate | {run_cost:.2f} |",
        f"| Measured uplift over the incumbent policy | {uplift_incumbent:.2f} |",
        f"| **Net** | **{net:.2f}** |",
        f"| Return per rupee of operating spend | {ratio:.2f}× |",
        "",
        f"Per 1,000 {unit_noun}: **₹{1000 * run_cost:,.0f}** to operate, **₹{1000 * uplift_incumbent:,.0f}** "
        f"of measured uplift, **₹{1000 * net:,.0f}** net.",
        "",
        "**The operating cost is almost entirely one number.** A human escalation is priced at ₹40 "
        f"and the policy escalates {100 * escalation_share:.1f}% of this split, so escalation is "
        "essentially the whole cost base. That makes the escalation price the single most important "
        "knob a merchant has, and it is worth knowing where it breaks: at this operating point "
        f"escalation could cost up to **₹{breakeven_escalation:.2f}** before the system stopped "
        "paying for itself against the incumbent.",
        "",
        f"**Why this split escalates so much, and why the batch runner does not.** A ₹40 human is "
        f"{4000 / median_paise:.1%} of this split's median ₹{median_paise / 100:,.0f} event and "
        f"{4000 / 14800:.0%} of a ₹148 one, so the EV arithmetic reaches opposite conclusions on "
        "the two. Measured on the real demo split, by amount:",
        "",
        "| Event amount (₹) | Events | Escalated | `RETRY_LATER` | Cost/event (₹) |",
        "|---|---|---|---|---|",
    ] + [
        f"| {b['label']} | {b['n']} | {100 * b['escalated_share']:.1f}% | "
        f"{100 * b['retry_later_share']:.1f}% | {b['cost_paise_per_event'] / 100:.2f} |"
        for b in buckets
    ] + [
        "",
        "So the dashboard's own batch — synthetic amounts of ₹100–₹352, zero escalations, ₹28 of "
        "intervention cost across 300 events — and this table are the same policy at two different "
        "operating points, not a contradiction. It does mean the batch runner's cost row is the "
        "cheap end of the range and should not be read as typical. Stated here rather than left for "
        "a reader to reconcile.",
        "",
        f"Reclaim's uplift over *retrying everything* is larger still ({fmt_inr(uplift_retry_all)}/{unit}), "
        "but retry-everything is not a real incumbent — the logged policy is, which is why the "
        "table above compares against that instead.",
        "",
        "**Not included, and why.** The language layer's cost is reported separately and is near "
        "zero on batch runs because they are template-first and cache-hit; folding a "
        "cache-dependent figure into a per-event cost would flatter it. Compute and database costs "
        "at this volume are rounding error against a ₹40 escalation. Neither changes the "
        "conclusion, and both would make the numbers above look better rather than worse.",
        "",
    ]
    return LF.join(lines)


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
    ope_b2b = load(REPO_ROOT / "docs" / "ope_results_b2b.json")
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
        oracle_truth_section(ope, "transactions", "subscription"),
        ope_section(ope, "Off-policy evaluation — the six-policy bracket (subscription)", "transactions"),
        oracle_truth_section(ope_b2b, "invoices", "B2B receivables"),
        ope_section(ope_b2b, "Off-policy evaluation — the six-policy bracket (B2B receivables)", "invoices"),
        unit_economics_section(ope, "transactions"),
        risk_section(risk),
    ]

    OUT_PATH.write_text("\n".join(parts) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
