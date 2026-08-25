"""
`q_hat(model, features, action)` — the exact same scorer `src/domain/scoring/recovery-model.ts`
runs in production, evaluated here in Python from the committed `recovery_model.json`
(BUILD_PLAN.md §6.4: "`q̂` comes from the scorer fit on train only, evaluated on demo").
Reuses `model_spec.build_row` rather than re-deriving the feature/interaction layout,
so this can never silently drift from what `train_scorer.py` itself fit against.
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
