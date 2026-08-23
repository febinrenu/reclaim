"""
The true data-generating process (BUILD_PLAN.md §6.2 Trap 1).

The shipped recovery scorer (D5) will be a 13-feature-plus-action-interactions
logistic regression. This module's `true_probability` is deliberately richer than
that hypothesis class in exactly the ways a competent engineer building the shipped
model could not have seen: a per-bank latent health process, a per-customer latent
intent effect, a threshold effect at each customer's own 90th-percentile amount, one
feature-feature interaction the shipped model omits, heteroskedastic noise scaled by
how hard the decline reason is, and asymmetric recording noise on top of the true
outcome. None of that reaches the *logging policy* — see `logging_policy.py`, which
is a function of recorded features only. That separation is what keeps propensities
exact rather than estimated (BUILD_PLAN.md §6.2's "load-bearing decision").

Everything is driven by one seeded `numpy.random.Generator`, so the whole dataset
regenerates byte-for-byte from the seed in `common.py` — see `generate.py` and
`manifest.py`.
"""
from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .common import (
    ACTIONS, BANKS, ERROR_CATEGORIES, ERROR_CATEGORY_WEIGHTS, DECLINE_HARDNESS,
    N_CUSTOMERS, WARM_UP_MONTHS, OBSERVATION_MONTHS, MAX_RETRY_INDEX, SPLIT_ROW_TARGETS,
)
from . import logging_policy
from . import risk as risk_mod

HOURS_PER_DAY = 24.0
DAYS_PER_MONTH = 30.0  # a synthetic calendar, not a real one — every month is 30 days
WARM_UP_HOURS = WARM_UP_MONTHS * DAYS_PER_MONTH * HOURS_PER_DAY
OBSERVATION_HOURS = OBSERVATION_MONTHS * DAYS_PER_MONTH * HOURS_PER_DAY
BANK_FAIL_WINDOW_HOURS = 24.0
CONTACT_WINDOW_HOURS = 7 * HOURS_PER_DAY
RETRY_OFFSETS_HOURS = {0: 0.0, 1: 2.0, 2: 24.0}  # SYSTEM_SPEC.md §14: immediate, +2h, +24h from the original failure
CONTINUE_RETRY_PROB = 0.65

# Action lift in logit space — the *only* source of variation across actions in the
# true model, on top of the shared state term. DO_NOTHING is the reference level.
ACTION_LIFT = {
    "DO_NOTHING": 0.0,
    "RETRY_NOW": 0.15,
    "RETRY_LATER": 0.22,
    "PAYMENT_LINK": 0.42,
    "WHATSAPP_NUDGE": 0.28,
    "ESCALATE_HUMAN": 0.65,
}

# Hand-set so that an all-zero feature vector with DO_NOTHING lands near the ~0.11
# organic recovery rate BUILD_PLAN.md §6.1 uses, and so the shipped 13-feature model
# has genuine, recoverable signal to find without the task being trivial (that bound
# gets checked for real once D5 fits it, in eval/test_generator_difficulty.py).
INTERCEPT = -2.10
WEIGHTS = {
    "prior_success_rate": 0.95,
    "days_since_last_failure": -0.009,
    "amount_zscore": -0.11,
    "retry_count_so_far": -0.20,
    "is_recurring_subscription": 0.13,
    "hour_sin": 0.06,
    "hour_cos": -0.03,
    "bank_recent_fail_rate": -0.50,
    "contacts_last_7d": -0.07,
    "ltv_zscore": 0.09,
    "customer_tenure_days": 0.00035,
    "is_soft_decline": 0.20,
    "is_insufficient_funds": -0.13,
}
THRESHOLD_WEIGHT = -0.45       # amount > customer's own p90 — a threshold effect, not linear in amount_zscore
INTERACTION_WEIGHT = -0.08     # days_since_last_failure_z * amount_zscore — omitted by the shipped model
NOISE_SCALE = 1.3              # heteroskedastic noise scale, multiplied by DECLINE_HARDNESS[category]
ASYMMETRIC_NOISE_SUCCESS_TO_FAIL = 0.02
ASYMMETRIC_NOISE_FAIL_TO_SUCCESS = 0.01


def sigmoid(z: float) -> float:
    z = min(30.0, max(-30.0, z))
    return 1.0 / (1.0 + math.exp(-z))


@dataclass
class Customer:
    customer_id: str
    created_at_hours: float  # negative: before the observation window starts
    bank: str
    primary_card_id: str
    typical_amount_paise: float
    amount_sigma: float
    p90_amount_paise: float
    ltv_amount_paise: float
    ltv_zscore: float
    intent_effect: float  # LATENT — never written to any output file
    warm_up_successful: int
    warm_up_failed: int


def generate_customers(rng: np.random.Generator) -> list[Customer]:
    customers = []
    ltv_draws = rng.lognormal(mean=math.log(6_000_00), sigma=0.5, size=N_CUSTOMERS)
    ltv_mean, ltv_std = ltv_draws.mean(), ltv_draws.std()

    for i in range(N_CUSTOMERS):
        cust_id = f"cust_{i:03d}"
        # Customers join at slightly different times, so tenure genuinely varies.
        created_at_hours = -WARM_UP_HOURS - rng.uniform(0, 30 * HOURS_PER_DAY)
        bank = BANKS[rng.integers(0, len(BANKS))]
        typical_amount = rng.lognormal(mean=math.log(1_500_00), sigma=0.6)
        amount_sigma = typical_amount * 0.35
        # p90 of a lognormal(mu, sigma) is exp(mu + 1.2816*sigma); typical_amount is
        # the median (exp(mu)), so p90 = median * exp(1.2816 * sigma).
        p90_amount = typical_amount * math.exp(1.2816 * 0.6)
        warm_up_successful = int(rng.poisson(67))
        warm_up_failed = int(rng.poisson(9))

        customers.append(Customer(
            customer_id=cust_id,
            created_at_hours=created_at_hours,
            bank=bank,
            primary_card_id=f"card_{cust_id}_0",
            typical_amount_paise=typical_amount,
            amount_sigma=amount_sigma,
            p90_amount_paise=p90_amount,
            ltv_amount_paise=ltv_draws[i],
            ltv_zscore=(ltv_draws[i] - ltv_mean) / ltv_std,
            intent_effect=rng.normal(0, 0.7),
            warm_up_successful=warm_up_successful,
            warm_up_failed=warm_up_failed,
        ))
    return customers


def build_bank_health_paths(rng: np.random.Generator, banks: list[str], total_hours: float,
                             bucket_minutes: float = 5.0):
    """A slow mean-reverting per-bank latent health process, in logit-space units,
    with a handful of sharper dips layered on top to model degraded-authentication
    episodes. Enters the outcome only — see the module docstring."""
    n_buckets = int(total_hours * 60 / bucket_minutes) + 2
    paths = {}
    phi = 0.985
    for bank in banks:
        eps = rng.normal(0, 0.07, size=n_buckets)
        path = np.zeros(n_buckets)
        for i in range(1, n_buckets):
            path[i] = phi * path[i - 1] + eps[i]
        n_dips = rng.integers(2, 5)
        for _ in range(n_dips):
            idx = rng.integers(0, n_buckets)
            dip_len = rng.integers(6, 30)  # 30 min to 2.5 h, at 5-minute resolution
            depth = rng.uniform(0.9, 2.0)
            end = min(n_buckets, idx + dip_len)
            path[idx:end] -= depth
        paths[bank] = path
    return paths, n_buckets, bucket_minutes


def bank_health_at(paths, n_buckets: int, bucket_minutes: float, bank: str, t_hours: float) -> float:
    idx = int((t_hours + WARM_UP_HOURS) * 60 / bucket_minutes)
    idx = min(max(idx, 0), n_buckets - 1)
    return float(paths[bank][idx])


class Ledger:
    """Strictly backward-looking running state, updated only as events are
    *processed* in chronological order — never touched by an event's own outcome
    before that outcome is computed. This is what makes `prior_success_rate`,
    `days_since_last_failure`, `bank_recent_fail_rate`, and `contacts_last_7d`
    honestly as-of rather than leaking the future (BUILD_PLAN.md §6.7)."""

    def __init__(self, customers: list[Customer]):
        self.successes: dict[str, int] = {c.customer_id: c.warm_up_successful for c in customers}
        self.failures: dict[str, int] = {c.customer_id: c.warm_up_failed for c in customers}
        self.last_failure_hours: dict[str, float] = {}
        self.contact_events: dict[str, list[float]] = {c.customer_id: [] for c in customers}
        self.bank_outcomes: dict[str, list[tuple[float, bool]]] = {b: [] for b in BANKS}
        self.card_first_seen: dict[str, float] = {}

    def prior_success_rate(self, customer_id: str) -> float:
        s, f = self.successes[customer_id], self.failures[customer_id]
        total = s + f
        return s / total if total > 0 else 0.5

    def days_since_last_failure(self, customer_id: str, at_hours: float) -> float:
        last = self.last_failure_hours.get(customer_id)
        if last is None:
            return 180.0  # a large default: "no recent failure on record"
        return max(0.0, (at_hours - last) / HOURS_PER_DAY)

    def contacts_last_7d(self, customer_id: str, at_hours: float) -> int:
        window_start = at_hours - CONTACT_WINDOW_HOURS
        return sum(1 for t in self.contact_events[customer_id] if window_start <= t < at_hours)

    def bank_recent_fail_rate(self, bank: str, at_hours: float) -> float:
        window_start = at_hours - BANK_FAIL_WINDOW_HOURS
        recent = [ok for (t, ok) in self.bank_outcomes[bank] if window_start <= t < at_hours]
        if not recent:
            return 0.10  # an uninformative prior for a bank with no recent history yet
        return 1.0 - (sum(recent) / len(recent))

    def card_first_seen_hours_ago(self, card_id: str, at_hours: float) -> float:
        first = self.card_first_seen.setdefault(card_id, at_hours)
        return max(0.0, at_hours - first)

    def record_contact(self, customer_id: str, at_hours: float) -> None:
        self.contact_events[customer_id].append(at_hours)

    def record_outcome(self, customer_id: str, bank: str, at_hours: float, recovered: bool) -> None:
        if recovered:
            self.successes[customer_id] += 1
        else:
            self.failures[customer_id] += 1
            self.last_failure_hours[customer_id] = at_hours
        self.bank_outcomes[bank].append((at_hours, recovered))


CONTACT_ACTIONS = {"WHATSAPP_NUDGE", "PAYMENT_LINK"}


@dataclass
class GeneratedData:
    logged_rows: list[dict]
    oracle_rows: list[dict]
    risk_rows: list[dict]
    customers_rows: list[dict]
    achieved_risky_events: int
    achieved_would_chargeback: int


def month_of_hours(t_hours: float) -> int:
    return int(t_hours // (DAYS_PER_MONTH * HOURS_PER_DAY)) + 1  # 1-indexed


def _feature_vector(cust: Customer, ledger: Ledger, at_hours: float, amount_paise: float,
                     retry_index: int, error_category: str, is_soft_decline: bool,
                     is_insufficient_funds: bool) -> dict:
    hour_of_day = (at_hours % HOURS_PER_DAY)
    amount_z = (amount_paise - cust.typical_amount_paise) / cust.amount_sigma
    return {
        "prior_success_rate": ledger.prior_success_rate(cust.customer_id),
        "days_since_last_failure": ledger.days_since_last_failure(cust.customer_id, at_hours),
        "amount_zscore": amount_z,
        "retry_count_so_far": float(retry_index),
        "is_recurring_subscription": 1.0,
        "hour_sin": math.sin(2 * math.pi * hour_of_day / 24.0),
        "hour_cos": math.cos(2 * math.pi * hour_of_day / 24.0),
        "bank_recent_fail_rate": ledger.bank_recent_fail_rate(cust.bank, at_hours),
        "contacts_last_7d": float(ledger.contacts_last_7d(cust.customer_id, at_hours)),
        "ltv_zscore": cust.ltv_zscore,
        "customer_tenure_days": (at_hours - cust.created_at_hours) / HOURS_PER_DAY,
        "is_soft_decline": 1.0 if is_soft_decline else 0.0,
        "is_insufficient_funds": 1.0 if is_insufficient_funds else 0.0,
    }


def _true_probability(features: dict, action: str, cust: Customer, bank_health: float,
                       amount_over_p90: bool, noise: float) -> float:
    z = INTERCEPT
    for key, w in WEIGHTS.items():
        z += w * features[key]
    z += THRESHOLD_WEIGHT * (1.0 if amount_over_p90 else 0.0)
    days_since_z = (features["days_since_last_failure"] - 30.0) / 30.0  # loosely centred/scaled
    z += INTERACTION_WEIGHT * days_since_z * features["amount_zscore"]
    z += bank_health
    z += cust.intent_effect
    z += ACTION_LIFT[action]
    z += noise
    return sigmoid(z)


def generate(rng: np.random.Generator) -> GeneratedData:
    customers = generate_customers(rng)
    by_id = {c.customer_id: c for c in customers}
    ledger = Ledger(customers)
    bank_paths, n_buckets, bucket_minutes = build_bank_health_paths(rng, BANKS, WARM_UP_HOURS + OBSERVATION_HOURS)

    total_target = sum(SPLIT_ROW_TARGETS.values())
    # A divisor tuned empirically against CONTINUE_RETRY_PROB so the realised total
    # lands within shouting distance of BUILD_PLAN.md §6.6's 12,000, with enough
    # margin at retry_index 2 (the rarest cell in the contingency table
    # eval/test_overlap.py checks) to clear the 30-row floor comfortably rather than
    # marginally. Not a promise of an exact count — the actual achieved totals are
    # computed and reported honestly by generate.py afterwards, not forced to match.
    n_transaction_starts = int(total_target / 1.4)

    # Relative monthly weights matching the target row counts per month, so demo
    # months (5, 6) genuinely have a higher event rate than early training months.
    month_weights = {1: 1800, 2: 1800, 3: 1800, 4: 1800, 5: 2400, 6: 2400}
    months = list(month_weights.keys())
    weights = np.array([month_weights[m] for m in months], dtype=float)
    weights /= weights.sum()
    start_months = rng.choice(months, size=n_transaction_starts, p=weights)

    card_ids = [c.primary_card_id for c in customers]
    episodes = risk_mod.make_episodes(rng, card_ids, OBSERVATION_HOURS, n_episodes=22)

    heap: list[tuple[float, int, dict]] = []
    seq = itertools.count()
    for i in range(n_transaction_starts):
        cust = customers[rng.integers(0, N_CUSTOMERS)]
        month = int(start_months[i])
        day_in_month = rng.uniform(0, DAYS_PER_MONTH)
        start_hours = (month - 1) * DAYS_PER_MONTH * HOURS_PER_DAY + day_in_month * HOURS_PER_DAY
        heapq.heappush(heap, (start_hours, next(seq), {
            "transaction_id": f"pay_{i:06d}",
            "customer_id": cust.customer_id,
            "retry_index": 0,
            "origin_hours": start_hours,
        }))

    logged_rows: list[dict] = []
    oracle_rows: list[dict] = []
    risk_rows: list[dict] = []

    while heap:
        t_hours, _, txn = heapq.heappop(heap)
        if t_hours > OBSERVATION_HOURS:
            continue
        cust = by_id[txn["customer_id"]]
        retry_index = txn["retry_index"]

        error_category = ERROR_CATEGORIES[rng.choice(len(ERROR_CATEGORIES), p=ERROR_CATEGORY_WEIGHTS)]
        is_soft_decline = error_category == "soft_decline"
        is_insufficient_funds = error_category == "insufficient_funds"

        amount_paise = max(100.0, rng.lognormal(mean=math.log(cust.typical_amount_paise), sigma=0.15))
        # A small chance of a fresh replacement card, which is what makes
        # card_first_seen_recently a real, sometimes-true signal rather than always false.
        card_id = cust.primary_card_id
        if rng.random() < 0.08:
            card_id = f"card_{cust.customer_id}_{int(t_hours)}"

        features = _feature_vector(cust, ledger, t_hours, amount_paise, retry_index,
                                    error_category, is_soft_decline, is_insufficient_funds)

        action, propensity = logging_policy.draw_action(
            rng, int(amount_paise), features["prior_success_rate"], retry_index,
            is_soft_decline, is_insufficient_funds,
        )

        bank_health = bank_health_at(bank_paths, n_buckets, bucket_minutes, cust.bank, t_hours)
        amount_over_p90 = amount_paise > cust.p90_amount_paise
        hardness = DECLINE_HARDNESS[error_category]
        # One noise draw shared across every action's counterfactual for this event:
        # it represents this event's own idiosyncratic conditions, not something that
        # differs depending on which hypothetical action had been taken.
        noise = rng.normal(0, NOISE_SCALE * hardness)

        p_true_by_action = {}
        y_true_by_action = {}
        for a in ACTIONS:
            p = _true_probability(features, a, cust, bank_health, amount_over_p90, noise)
            p_true_by_action[a] = p
            y_true_by_action[a] = bool(rng.random() < p)

        true_recovered = y_true_by_action[action]
        # Asymmetric recording noise (BUILD_PLAN.md §6.2 Trap 1) — applied to the
        # *recorded* outcome only. Oracle values above stay clean.
        if true_recovered and rng.random() < ASYMMETRIC_NOISE_SUCCESS_TO_FAIL:
            recorded_outcome = False
        elif not true_recovered and rng.random() < ASYMMETRIC_NOISE_FAIL_TO_SUCCESS:
            recorded_outcome = True
        else:
            recorded_outcome = true_recovered

        is_truly_risky = episodes.is_truly_risky(card_id, t_hours)
        signals = risk_mod.emit_signals(rng, is_truly_risky)
        would_chargeback = risk_mod.chargeback_label(rng, is_truly_risky)

        event_id = f"evt_{txn['transaction_id']}_{retry_index}"
        month = month_of_hours(t_hours)

        logged_rows.append({
            "event_id": event_id,
            "customer_id": cust.customer_id,
            "transaction_id": txn["transaction_id"],
            "event_created_at_hours": t_hours,
            "amount_paise": round(amount_paise),
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
            "amount_paise": round(amount_paise),
            "would_chargeback": int(would_chargeback),
            **{k: int(v) for k, v in signals.items()},
        })

        if action in CONTACT_ACTIONS:
            ledger.record_contact(cust.customer_id, t_hours)
        ledger.record_outcome(cust.customer_id, cust.bank, t_hours, recorded_outcome)
        ledger.card_first_seen_hours_ago(card_id, t_hours)  # registers first-seen if new

        should_continue = (
            not recorded_outcome
            and action not in ("DO_NOTHING", "ESCALATE_HUMAN")
            and retry_index < MAX_RETRY_INDEX
            and rng.random() < CONTINUE_RETRY_PROB
        )
        if should_continue:
            next_index = retry_index + 1
            origin_hours = txn["origin_hours"]
            next_hours = origin_hours + RETRY_OFFSETS_HOURS[next_index]
            heapq.heappush(heap, (next_hours, next(seq), {
                "transaction_id": txn["transaction_id"],
                "customer_id": cust.customer_id,
                "retry_index": next_index,
                "origin_hours": origin_hours,
            }))

    _inject_shock_decoys(rng, customers, ledger, bank_paths, n_buckets, bucket_minutes,
                          episodes, logged_rows, oracle_rows, risk_rows)
    _apply_benign_lookalikes(rng, risk_rows)

    customers_rows = [{
        "customer_id": c.customer_id,
        "bank": c.bank,
        "ltv_amount_paise": round(c.ltv_amount_paise),
        "warm_up_successful": c.warm_up_successful,
        "warm_up_failed": c.warm_up_failed,
        "typical_amount_paise": round(c.typical_amount_paise),
        "p90_amount_paise": round(c.p90_amount_paise),
    } for c in customers]

    achieved_risky = sum(r["is_truly_risky"] for r in oracle_rows)
    achieved_chargeback = sum(r["would_chargeback"] for r in risk_rows)

    return GeneratedData(
        logged_rows=logged_rows,
        oracle_rows=oracle_rows,
        risk_rows=risk_rows,
        customers_rows=customers_rows,
        achieved_risky_events=achieved_risky,
        achieved_would_chargeback=achieved_chargeback,
    )


def _inject_shock_decoys(rng, customers, ledger, bank_paths, n_buckets, bucket_minutes,
                          episodes, logged_rows, oracle_rows, risk_rows) -> None:
    """Two deliberate decoy clusters (BUILD_PLAN.md §7's D4 row), embedded in month 6
    so D11's offline shock-detector evaluation can assert neither one trips it:

      - a 12-event cluster, one bank, one error code, in a two-hour window — under
        any reasonable per-bank threshold, this must read as "busy", not "shocked".
      - a 35-event cluster sharing one error code but spread across four banks — a
        detector keyed by (bank, error_code) sees four unremarkable sub-clusters;
        only a detector that (wrongly) keys on error_code alone would trip on it.
        Proving key granularity is a real design choice, not an accident, is the
        point (BUILD_PLAN.md §6.10).
    """
    month6_start = 5 * DAYS_PER_MONTH * HOURS_PER_DAY

    def emit_decoy_event(tag: str, idx: int, bank: str, error_category: str, at_hours: float) -> None:
        cust = customers[rng.integers(0, N_CUSTOMERS)]
        amount_paise = max(100.0, rng.lognormal(mean=math.log(cust.typical_amount_paise), sigma=0.15))
        is_soft_decline = error_category == "soft_decline"
        is_insufficient_funds = error_category == "insufficient_funds"
        features = _feature_vector(cust, ledger, at_hours, amount_paise, 0, error_category,
                                    is_soft_decline, is_insufficient_funds)
        action, propensity = logging_policy.draw_action(
            rng, int(amount_paise), features["prior_success_rate"], 0, is_soft_decline, is_insufficient_funds,
        )
        bank_health = bank_health_at(bank_paths, n_buckets, bucket_minutes, bank, at_hours)
        amount_over_p90 = amount_paise > cust.p90_amount_paise
        noise = rng.normal(0, NOISE_SCALE * DECLINE_HARDNESS[error_category])

        p_true_by_action, y_true_by_action = {}, {}
        for a in ACTIONS:
            p = _true_probability(features, a, cust, bank_health, amount_over_p90, noise)
            p_true_by_action[a] = p
            y_true_by_action[a] = bool(rng.random() < p)
        recorded_outcome = y_true_by_action[action]

        is_truly_risky = episodes.is_truly_risky(cust.primary_card_id, at_hours)
        signals = risk_mod.emit_signals(rng, is_truly_risky)
        would_chargeback = risk_mod.chargeback_label(rng, is_truly_risky)

        event_id = f"evt_decoy_{tag}_{idx:03d}"
        logged_rows.append({
            "event_id": event_id, "customer_id": cust.customer_id,
            "transaction_id": f"pay_decoy_{tag}_{idx:03d}",
            "event_created_at_hours": at_hours, "amount_paise": round(amount_paise),
            "action": action, "propensity": propensity, "outcome": int(recorded_outcome),
            **features,
        })
        oracle_rows.append({
            "event_id": event_id, "is_truly_risky": int(is_truly_risky),
            **{f"p_true_{a}": p_true_by_action[a] for a in ACTIONS},
            **{f"y_true_{a}": int(y_true_by_action[a]) for a in ACTIONS},
        })
        risk_rows.append({
            "event_id": event_id, "amount_paise": round(amount_paise),
            "would_chargeback": int(would_chargeback), **{k: int(v) for k, v in signals.items()},
        })
        ledger.record_outcome(cust.customer_id, bank, at_hours, recorded_outcome)

    # Decoy A: 12 events, one bank, one error code, inside a 2-hour window.
    decoy_a_bank = BANKS[0]
    decoy_a_start = month6_start + 3 * HOURS_PER_DAY  # 3 days into month 6
    for i in range(12):
        at = decoy_a_start + rng.uniform(0, 2.0)
        emit_decoy_event("a", i, decoy_a_bank, "gateway_error", at)

    # Decoy B: 35 events, one error code, spread across four banks (~8-9 each).
    decoy_b_start = month6_start + 10 * HOURS_PER_DAY  # 10 days into month 6
    decoy_b_banks = BANKS[1:5]
    for i in range(35):
        bank = decoy_b_banks[i % len(decoy_b_banks)]
        at = decoy_b_start + rng.uniform(0, 2.0)
        emit_decoy_event("b", i, bank, "hard_decline", at)


def _apply_benign_lookalikes(rng: np.random.Generator, risk_rows: list[dict], n: int = 60) -> None:
    """After the fact, force exactly `n` benign (would_chargeback == 0) rows to emit
    every risk signal, so the gate's precision ceiling is real rather than assumed —
    see risk.force_benign_lookalike_signals."""
    benign_indices = [i for i, r in enumerate(risk_rows) if r["would_chargeback"] == 0]
    chosen = rng.choice(benign_indices, size=min(n, len(benign_indices)), replace=False)
    forced = risk_mod.force_benign_lookalike_signals()
    for i in chosen:
        risk_rows[i].update({k: int(v) for k, v in forced.items()})
