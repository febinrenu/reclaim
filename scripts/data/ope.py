"""
The off-policy estimators (BUILD_PLAN.md §6.4): direct method, self-normalised
importance sampling, and doubly-robust, all against a deterministic evaluation
policy pi (one-hot per row) and the known logging propensities pi0.

    w_i        = pi(a_i|s_i) / pi0(a_i|s_i)                 -- 0 or 1/pi0(a_i|s_i) here, since pi is one-hot
    V_DM(pi)   = mean_i q_hat(s_i, pi(s_i))                  -- pi one-hot collapses the inner sum
    V_SNIPS(pi)= sum_i w_i r_i / sum_i w_i
    V_DR(pi)   = mean_i [ q_hat(s_i, pi(s_i)) + w_i (r_i - q_hat(s_i, a_i)) ]
    ESS(pi)    = (sum_i w_i)^2 / sum_i w_i^2

Weight clipping at 30 (`WEIGHT_CLIP`) is documented as a provable no-op, not a
variance hack: `scripts/data/logging_policy.py`'s minimum propensity is exactly
0.20/6, so the maximum importance weight is exactly 30 by construction (see
docs/EVALUATION.md's D4 section, Trap 2). Confidence intervals are the 2.5th/97.5th
percentile of 2,000 row-resample bootstrap replicates, not a normal approximation,
because importance-weighted estimates are right-skewed (BUILD_PLAN.md §6.4).
"""
from __future__ import annotations

import numpy as np

WEIGHT_CLIP = 30.0
N_BOOTSTRAP = 2000
ESS_UNTRUSTWORTHY_BELOW = 200


def importance_weight(chosen: np.ndarray, logged_action: np.ndarray, propensity: np.ndarray) -> np.ndarray:
    matches = (chosen == logged_action).astype(float)
    w = matches / propensity
    return np.minimum(w, WEIGHT_CLIP)


def ess(w: np.ndarray) -> float:
    denom = float(np.sum(w * w))
    if denom == 0.0:
        return 0.0
    return float(np.sum(w) ** 2 / denom)


def dm(q_chosen: np.ndarray) -> float:
    return float(np.mean(q_chosen))


def snips(w: np.ndarray, r: np.ndarray) -> float:
    total_w = float(np.sum(w))
    if total_w == 0.0:
        return float("nan")
    return float(np.sum(w * r) / total_w)


def dr(q_chosen: np.ndarray, w: np.ndarray, r: np.ndarray, q_logged: np.ndarray) -> float:
    return float(np.mean(q_chosen + w * (r - q_logged)))


def bootstrap_ci(estimator, rng: np.random.Generator, n_resamples: int = N_BOOTSTRAP, **arrays) -> tuple[float, float]:
    """Percentile bootstrap over row resamples. `arrays` are same-length numpy
    arrays keyed by the estimator's own keyword arguments (e.g. `w=`, `r=`,
    `q_chosen=`, `q_logged=`)."""
    n = len(next(iter(arrays.values())))
    replicates = np.empty(n_resamples)
    for b in range(n_resamples):
        idx = rng.integers(0, n, size=n)
        resampled = {k: v[idx] for k, v in arrays.items()}
        replicates[b] = estimator(**resampled)
    lo, hi = np.percentile(replicates, [2.5, 97.5])
    return float(lo), float(hi)
