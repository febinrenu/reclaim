"""
The true data-generating process for the B2B receivables chaser (SYSTEM_SPEC.md
§16, BUILD_PLAN.md §6.2's non-circularity discipline applied a second time).

Deliberately richer than the shipped 9-feature-plus-action-interactions logistic
regression, in the ways a competent engineer building the shipped model could
not have seen: a per-customer latent payment-discipline effect distinct from the
noisy `customer_ontime_rate` proxy the model actually sees, one feature-feature
interaction the shipped model omits (`days_overdue x invoice_size_zscore` — a
large overdue invoice is disproportionately harder to collect than either
factor alone suggests), and heteroskedastic noise that grows with how many
chase rounds have already failed (further down the funnel is less predictable).
None of that reaches `logging_policy.py`, which is a function of recorded
features only — the same separation `scripts/data/dgp.py` uses, and for the
same reason: it is what keeps propensities exact rather than estimated.
"""
from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass

import numpy as np

from .common import ACTIONS, N_CUSTOMERS, WARM_UP_MONTHS, OBSERVATION_MONTHS, MAX_CHASE_ROUNDS, SPLIT_ROW_TARGETS
from . import logging_policy
from scripts.data import risk as risk_mod  # shared, read-only infrastructure — see common.py's own docstring

HOURS_PER_DAY = 24.0
DAYS_PER_MONTH = 30.0
WARM_UP_HOURS = WARM_UP_MONTHS * DAYS_PER_MONTH * HOURS_PER_DAY
OBSERVATION_HOURS = OBSERVATION_MONTHS * DAYS_PER_MONTH * HOURS_PER_DAY
CONTACT_WINDOW_HOURS = 14 * HOURS_PER_DAY
CHASE_OFFSETS_HOURS = {0: 0.0, 1: 15 * HOURS_PER_DAY}  # +15 days for the one follow-up round
CONTINUE_CHASE_PROB = 0.68

ACTION_LIFT = {
    "WRITE_OFF": 0.0,
    "SEND_REMINDER": 0.30,
    "OFFER_PAYMENT_PLAN": 0.55,
    "ESCALATE_COLLECTIONS": 0.70,
}

INTERCEPT = -1.55
WEIGHTS = {
    "days_overdue": -0.004,
    "customer_ontime_rate": 0.40,
    "invoice_size_zscore": -0.045,
    "chase_rounds_so_far": -0.06,
    "is_repeat_overdue_this_quarter": -0.09,
    "quarter_sin": 0.02,
    "quarter_cos": -0.006,
    "contacts_last_14d": -0.03,
    "customer_relationship_days": 0.0001,
}
INTERACTION_WEIGHT = -0.03  # days_overdue_z * invoice_size_zscore, omitted by the shipped model
NOISE_BASE_SCALE = 2.3
NOISE_PER_CHASE_ROUND = 0.6  # heteroskedastic: noisier the further into the chase
ASYMMETRIC_NOISE_PAID_TO_UNPAID = 0.02
ASYMMETRIC_NOISE_UNPAID_TO_PAID = 0.01


def sigmoid(z: float) -> float:
    z = min(30.0, max(-30.0, z))
    return 1.0 / (1.0 + math.exp(-z))


@dataclass
class Customer:
    customer_id: str
    created_at_hours: float
    typical_invoice_paise: float
    invoice_sigma: float
    true_discipline: float  # LATENT — never written to any output file
    warm_up_ontime: int
    warm_up_late: int


def generate_customers(rng: np.random.Generator) -> list[Customer]:
    customers = []
    for i in range(N_CUSTOMERS):
        typical = rng.lognormal(mean=math.log(50_000_00), sigma=0.55)  # ~Rs 50,000 typical invoice
        customers.append(Customer(
            customer_id=f"cust_b2b_{i:03d}",
            created_at_hours=-WARM_UP_HOURS - rng.uniform(0, 20 * HOURS_PER_DAY),
            typical_invoice_paise=typical,
            invoice_sigma=typical * 0.4,
            true_discipline=rng.normal(0, 0.9),
            warm_up_ontime=int(rng.poisson(9)),
            warm_up_late=int(rng.poisson(3)),
        ))
    return customers


class Ledger:
    """Strictly backward-looking, as of the event instant — BUILD_PLAN.md §6.7's
    leakage discipline, applied here the same way scripts/data/dgp.py's Ledger does."""

    def __init__(self, customers: list[Customer]):
        self._ontime: dict[str, int] = {c.customer_id: c.warm_up_ontime for c in customers}
        self._late: dict[str, int] = {c.customer_id: c.warm_up_late for c in customers}
        self._overdue_events_this_quarter: dict[str, list[float]] = {c.customer_id: [] for c in customers}
        self._contacts: dict[str, list[float]] = {c.customer_id: [] for c in customers}

    def ontime_rate(self, customer_id: str) -> float:
        n_ontime = self._ontime[customer_id]
        n_late = self._late[customer_id]
        total = n_ontime + n_late
        return n_ontime / total if total > 0 else 0.5

    def is_repeat_overdue_this_quarter(self, customer_id: str, at_hours: float) -> bool:
        quarter_start = (at_hours // (90 * HOURS_PER_DAY)) * 90 * HOURS_PER_DAY
        return any(t >= quarter_start for t in self._overdue_events_this_quarter[customer_id])

    def contacts_last_14d(self, customer_id: str, at_hours: float) -> int:
        window_start = at_hours - CONTACT_WINDOW_HOURS
        return sum(1 for t in self._contacts[customer_id] if window_start <= t < at_hours)

    def record_overdue_event(self, customer_id: str, at_hours: float) -> None:
        self._overdue_events_this_quarter[customer_id].append(at_hours)

    def record_contact(self, customer_id: str, at_hours: float) -> None:
        self._contacts[customer_id].append(at_hours)

    def record_outcome(self, customer_id: str, paid_on_time_equivalent: bool) -> None:
        # A recovered receivable still counts as "late" for the ontime-rate
        # proxy (it required chasing), never silently folded into "ontime" —
        # the two are genuinely different customer behaviours.
        if paid_on_time_equivalent:
            self._ontime[customer_id] += 1
        else:
            self._late[customer_id] += 1


def month_of_hours(t_hours: float) -> int:
    return int(t_hours // (DAYS_PER_MONTH * HOURS_PER_DAY)) + 1


def _feature_vector(cust: Customer, ledger: Ledger, at_hours: float, invoice_paise: float,
                     chase_round: int, days_overdue: float) -> dict:
    quarter_progress = (at_hours % (90 * HOURS_PER_DAY)) / (90 * HOURS_PER_DAY)
    invoice_z = (invoice_paise - cust.typical_invoice_paise) / cust.invoice_sigma
    return {
        "days_overdue": days_overdue,
        "customer_ontime_rate": ledger.ontime_rate(cust.customer_id),
        "invoice_size_zscore": invoice_z,
        "chase_rounds_so_far": float(chase_round),
        "is_repeat_overdue_this_quarter": 1.0 if ledger.is_repeat_overdue_this_quarter(cust.customer_id, at_hours) else 0.0,
        "quarter_sin": math.sin(2 * math.pi * quarter_progress),
        "quarter_cos": math.cos(2 * math.pi * quarter_progress),
        "contacts_last_14d": float(ledger.contacts_last_14d(cust.customer_id, at_hours)),
        "customer_relationship_days": (at_hours - cust.created_at_hours) / HOURS_PER_DAY,
    }


def _true_probability(features: dict, action: str, cust: Customer, noise: float) -> float:
    z = INTERCEPT
    for key, w in WEIGHTS.items():
        z += w * features[key]
    days_overdue_z = (features["days_overdue"] - 30.0) / 20.0
    z += INTERACTION_WEIGHT * days_overdue_z * features["invoice_size_zscore"]
    z += cust.true_discipline
    z += ACTION_LIFT[action]
    z += noise
    return sigmoid(z)


@dataclass
class GeneratedData:
    logged_rows: list[dict]
    oracle_rows: list[dict]
    risk_rows: list[dict]
    customers_rows: list[dict]
    achieved_risky_events: int
    achieved_would_dispute: int


def generate(rng: np.random.Generator) -> GeneratedData:
    customers = generate_customers(rng)
    by_id = {c.customer_id: c for c in customers}
    ledger = Ledger(customers)

    total_target = sum(SPLIT_ROW_TARGETS.values())
    n_invoice_starts = int(total_target / 1.35)

    month_weights = {1: 700, 2: 700, 3: 900, 4: 900}
    months = list(month_weights.keys())
    weights = np.array([month_weights[m] for m in months], dtype=float)
    weights /= weights.sum()
    start_months = rng.choice(months, size=n_invoice_starts, p=weights)

    customer_ids = [c.customer_id for c in customers]
    episodes = risk_mod.make_episodes(rng, customer_ids, OBSERVATION_HOURS, n_episodes=14)

    heap: list[tuple[float, int, dict]] = []
    seq = itertools.count()
    for i in range(n_invoice_starts):
        cust = customers[rng.integers(0, N_CUSTOMERS)]
        month = int(start_months[i])
        day_in_month = rng.uniform(0, DAYS_PER_MONTH)
        start_hours = (month - 1) * DAYS_PER_MONTH * HOURS_PER_DAY + day_in_month * HOURS_PER_DAY
        heapq.heappush(heap, (start_hours, next(seq), {
            "invoice_id": f"inv_{i:06d}",
            "customer_id": cust.customer_id,
            "chase_round": 0,
            "origin_hours": start_hours,
            "days_overdue_at_origin": rng.uniform(1, 10),
        }))

    logged_rows: list[dict] = []
    oracle_rows: list[dict] = []
    risk_rows: list[dict] = []

    while heap:
        t_hours, _, inv = heapq.heappop(heap)
        if t_hours > OBSERVATION_HOURS:
            continue
        cust = by_id[inv["customer_id"]]
        chase_round = inv["chase_round"]
        days_overdue = inv["days_overdue_at_origin"] + (t_hours - inv["origin_hours"]) / HOURS_PER_DAY

        invoice_paise = max(1000.0, rng.lognormal(mean=math.log(cust.typical_invoice_paise), sigma=0.2))

        ledger.record_overdue_event(cust.customer_id, t_hours)
        features = _feature_vector(cust, ledger, t_hours, invoice_paise, chase_round, days_overdue)

        action, propensity = logging_policy.draw_action(
            rng, int(invoice_paise), features["customer_ontime_rate"], chase_round, days_overdue,
        )

        noise_scale = NOISE_BASE_SCALE + NOISE_PER_CHASE_ROUND * chase_round
        noise = rng.normal(0, noise_scale)

        p_true_by_action = {}
        y_true_by_action = {}
        for a in ACTIONS:
            p = _true_probability(features, a, cust, noise)
            p_true_by_action[a] = p
            y_true_by_action[a] = bool(rng.random() < p)

        true_paid = y_true_by_action[action]
        if true_paid and rng.random() < ASYMMETRIC_NOISE_PAID_TO_UNPAID:
            recorded_outcome = False
        elif not true_paid and rng.random() < ASYMMETRIC_NOISE_UNPAID_TO_PAID:
            recorded_outcome = True
        else:
            recorded_outcome = true_paid

        is_truly_risky = episodes.is_truly_risky(cust.customer_id, t_hours)
        signals = risk_mod.emit_signals(rng, is_truly_risky)
        would_dispute = risk_mod.chargeback_label(rng, is_truly_risky)

        event_id = f"evt_{inv['invoice_id']}_{chase_round}"

        logged_rows.append({
            "event_id": event_id,
            "customer_id": cust.customer_id,
            "invoice_id": inv["invoice_id"],
            "event_created_at_hours": t_hours,
            "amount_paise": round(invoice_paise),
            "action": action,
            "propensity": propensity,
            "outcome": int(recorded_outcome),
            **features,
        })
        oracle_rows.append({
            "event_id": event_id,
            "is_truly_risky": int(is_truly_risky),
            **{f"p_true_{a}": p_true_by_action[a] for a in ACTIONS},
            **{f"y_true_{a}": int(y_true_by_action[a]) for a in ACTIONS},
        })
        risk_rows.append({
            "event_id": event_id,
            "amount_paise": round(invoice_paise),
            "would_chargeback": int(would_dispute),  # column name kept generic — reused loader/schema
            **{k: int(v) for k, v in signals.items()},
        })

        if action in ("SEND_REMINDER", "OFFER_PAYMENT_PLAN"):
            ledger.record_contact(cust.customer_id, t_hours)
        ledger.record_outcome(cust.customer_id, recorded_outcome)

        should_continue = (
            not recorded_outcome
            and action not in ("WRITE_OFF", "ESCALATE_COLLECTIONS")
            and chase_round < MAX_CHASE_ROUNDS
            and rng.random() < CONTINUE_CHASE_PROB
        )
        if should_continue:
            next_round = chase_round + 1
            next_hours = t_hours + CHASE_OFFSETS_HOURS[next_round]
            heapq.heappush(heap, (next_hours, next(seq), {
                "invoice_id": inv["invoice_id"],
                "customer_id": cust.customer_id,
                "chase_round": next_round,
                "origin_hours": inv["origin_hours"],
                "days_overdue_at_origin": inv["days_overdue_at_origin"],
            }))

    customers_rows = [
        {
            "customer_id": c.customer_id,
            "typical_invoice_paise": round(c.typical_invoice_paise),
            "warm_up_ontime": c.warm_up_ontime,
            "warm_up_late": c.warm_up_late,
        }
        for c in customers
    ]

    return GeneratedData(
        logged_rows=logged_rows,
        oracle_rows=oracle_rows,
        risk_rows=risk_rows,
        customers_rows=customers_rows,
        achieved_risky_events=sum(1 for r in oracle_rows if r["is_truly_risky"]),
        achieved_would_dispute=sum(1 for r in risk_rows if r["would_chargeback"]),
    )
