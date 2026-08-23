"""
Trap 3 (BUILD_PLAN.md §6.2): risk labels come from a latent cause via card-fingerprint
episodes, never from the four rule signals themselves. Evaluating a rule against a
label derived from that same rule is the exact failure the spec's own reviewer
section predicts (precision and recall both 1.0) — this module is what keeps the
label and the rule genuinely independent, connected only through the noisy signal
table below.
"""
from dataclasses import dataclass

import numpy as np

# P(signal | risky), P(signal | benign) — BUILD_PLAN.md §6.2's table, verbatim.
SIGNAL_RATES = {
    "geo_mismatch": (0.55, 0.08),
    "card_velocity_high": (0.60, 0.04),
    "amount_far_above_history": (0.45, 0.05),
    "card_first_seen_recently": (0.70, 0.15),
}

# 30% of truly risky events emit no signal at all — the gate's recall ceiling of
# roughly 0.70 exists by construction, not by accident of the four rates above
# (which would, drawn independently, coincide on all-false for only ~3% of risky
# events — nowhere near the deliberate 30% target).
SILENT_RISKY_RATE = 0.30

CHARGEBACK_RATE_GIVEN_RISKY = 0.80
CHARGEBACK_RATE_GIVEN_BENIGN = 0.005


@dataclass(frozen=True)
class Episode:
    card_id: str
    start_hours: float
    end_hours: float


class RiskEpisodes:
    """A small number of compromised-card episodes over the whole observation
    window. A card is "truly risky" only for events on that card that fall inside
    one of its episode windows — everything else is benign, regardless of how the
    event happens to look."""

    def __init__(self, episodes: list[Episode]):
        self._by_card: dict[str, list[Episode]] = {}
        for ep in episodes:
            self._by_card.setdefault(ep.card_id, []).append(ep)

    def is_truly_risky(self, card_id: str, at_hours: float) -> bool:
        for ep in self._by_card.get(card_id, ()):
            if ep.start_hours <= at_hours <= ep.end_hours:
                return True
        return False

    def __len__(self) -> int:
        return sum(len(v) for v in self._by_card.values())


def make_episodes(rng: np.random.Generator, card_ids: list[str], observation_hours: float,
                   n_episodes: int = 22) -> RiskEpisodes:
    """Episode windows run 7-21 days, on a randomly chosen card, at a random point in
    the observation window. Sized empirically (see generate.py's reported prevalence)
    to land the overall would_chargeback rate near BUILD_PLAN.md §6.2's stated 2.5%,
    not derived from a closed-form target — the plan itself only asks that the number
    be stated, not that it be exact."""
    episodes = []
    chosen_cards = rng.choice(card_ids, size=min(n_episodes, len(card_ids)), replace=False)
    for card_id in chosen_cards:
        length_hours = rng.uniform(7 * 24, 21 * 24)
        start = rng.uniform(0, max(1.0, observation_hours - length_hours))
        episodes.append(Episode(card_id=str(card_id), start_hours=start, end_hours=start + length_hours))
    return RiskEpisodes(episodes)


def emit_signals(rng: np.random.Generator, is_truly_risky: bool) -> dict[str, bool]:
    if is_truly_risky and rng.random() < SILENT_RISKY_RATE:
        return {k: False for k in SIGNAL_RATES}

    result = {}
    for key, (p_risky, p_benign) in SIGNAL_RATES.items():
        p = p_risky if is_truly_risky else p_benign
        result[key] = bool(rng.random() < p)
    return result


def chargeback_label(rng: np.random.Generator, is_truly_risky: bool) -> bool:
    p = CHARGEBACK_RATE_GIVEN_RISKY if is_truly_risky else CHARGEBACK_RATE_GIVEN_BENIGN
    return bool(rng.random() < p)


def force_benign_lookalike_signals() -> dict[str, bool]:
    """The 60 benign look-alikes (BUILD_PLAN.md §6.2): legitimate customers who
    happen to emit every signal, putting a real ceiling on the gate's precision."""
    return {k: True for k in SIGNAL_RATES}
