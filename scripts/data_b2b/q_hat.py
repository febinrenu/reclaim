"""
`q_hat(model, features, action)` for the B2B receivables scorer — an exact
structural port of `scripts/data/q_hat.py`, differing only in which
`model_spec.build_row` it delegates to (this scenario's own action/feature
layout, not subscription's). Kept as a separate file rather than a shared one
for the same reason `scripts/data_b2b/common.py`'s own docstring gives for not
modifying `scripts/data/`: this second scenario's own commit stays scoped to
its own directory.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from .model_spec import build_row


def load_model(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def p_recover(model: dict, features: dict, action: str) -> float:
    row = build_row(features, action)
    coefficients = model["coefficients"]
    z = model["intercept"] + sum(c * x for c, x in zip(coefficients, row))
    return _sigmoid(model["plattA"] * z + model["plattB"])
