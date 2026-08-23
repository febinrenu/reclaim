"""
Entry point: `python -m scripts.data.generate` (wired as `npm run data:generate`).

Generates the full subscription-scenario synthetic dataset from the seed in
common.py, writes every output file under data/synthetic/subscription/, and writes
a manifest hashing all of them — see manifest.py and `data:verify`.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .common import (
    ACTIONS, SEED, OUT_DIR, FEATURE_ORDER, LOGGED_BOOKKEEPING_COLUMNS,
    RISK_SIGNAL_COLUMNS, SPLIT_MONTHS, hours_to_iso,
)
from . import dgp
from .manifest import write_manifest


def _logged_dataframe(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["event_created_at"] = df["event_created_at_hours"].map(hours_to_iso)
    df["month"] = df["event_created_at_hours"].map(dgp.month_of_hours)
    columns = LOGGED_BOOKKEEPING_COLUMNS + FEATURE_ORDER
    return df[columns + ["month"]].sort_values("event_created_at").reset_index(drop=True)


def _risk_dataframe(rows: list[dict], logged_by_id: pd.DataFrame) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df = df.merge(logged_by_id[["event_id", "month", "event_created_at"]], on="event_id", how="left")
    columns = ["event_id", "amount_paise", "would_chargeback"] + RISK_SIGNAL_COLUMNS
    return df[columns + ["month", "event_created_at"]].sort_values("event_created_at").reset_index(drop=True)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    data = dgp.generate(rng)

    logged_df = _logged_dataframe(data.logged_rows)
    risk_df = _risk_dataframe(data.risk_rows, logged_df)
    oracle_df = pd.DataFrame(data.oracle_rows)
    customers_df = pd.DataFrame(data.customers_rows)

    written: list = []

    for split_name, (m_start, m_end) in SPLIT_MONTHS.items():
        subset = logged_df[(logged_df["month"] >= m_start) & (logged_df["month"] <= m_end)]
        path = OUT_DIR / f"{split_name}.csv"
        # lineterminator='\n' pinned explicitly: pandas otherwise defaults to
        # os.linesep for a file path target, which is CRLF on Windows — and this
        # generator has to produce byte-identical output regardless of the platform
        # it runs on, for the same reason .gitattributes normalises these files to
        # LF in the repository. Writing LF directly means there is nothing for git's
        # normalisation to change between "just generated" and "freshly checked out".
        subset.drop(columns=["month"]).to_csv(path, index=False, lineterminator="\n")
        written.append(path)

        risk_subset = risk_df[(risk_df["month"] >= m_start) & (risk_df["month"] <= m_end)]
        risk_path = OUT_DIR / f"risk_eval_{split_name.split('_', 1)[1]}.csv"
        risk_subset.drop(columns=["month"]).to_csv(risk_path, index=False, lineterminator="\n")
        written.append(risk_path)

    customers_path = OUT_DIR / "customers.csv"
    customers_df.to_csv(customers_path, index=False, lineterminator="\n")
    written.append(customers_path)

    oracle_path = OUT_DIR / "oracle_counterfactuals.parquet"
    oracle_df.to_parquet(oracle_path, index=False)
    written.append(oracle_path)

    n_total = len(logged_df)
    n_risky = data.achieved_risky_events
    n_chargeback = data.achieved_would_chargeback
    summary = {
        "total_events": n_total,
        "total_transactions": logged_df["transaction_id"].nunique(),
        "n_customers": len(customers_df),
        "action_counts": logged_df["action"].value_counts().to_dict(),
        "outcome_rate": float(logged_df["outcome"].mean()),
        "truly_risky_events": n_risky,
        "truly_risky_rate": n_risky / n_total,
        "would_chargeback_events": n_chargeback,
        "would_chargeback_rate": n_chargeback / n_total,
        "split_row_counts": {
            name: int(((logged_df["month"] >= a) & (logged_df["month"] <= b)).sum())
            for name, (a, b) in SPLIT_MONTHS.items()
        },
    }

    manifest_path = write_manifest(written, summary)

    print(f"wrote {len(written)} data file(s) to {OUT_DIR}")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    print(f"manifest: {manifest_path}")


if __name__ == "__main__":
    main()
