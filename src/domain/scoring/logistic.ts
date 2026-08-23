/**
 * The two primitives every scorer in this codebase is built from. `sigmoid` is the
 * inference-time nonlinearity; `logit` is its inverse, used wherever a probability
 * needs to move in log-odds space (BUILD_PLAN.md §6.1's correction 1, for instance,
 * reasons about uplift as a probability difference computed after two `sigmoid`
 * calls, not before).
 *
 * The shipped recovery scorer's actual model — feature order, coefficients, Platt
 * calibration — lives in `recovery-model.ts`, ported from
 * `scripts/data/train_scorer.py`'s output. This file has no notion of a "model":
 * every clamp here exists purely because of property P11 (BUILD_PLAN.md §6.9), which
 * the scorer must return a value in the open unit interval for every finite input
 * and throw rather than silently propagate a NaN into money arithmetic downstream.
 */

/**
 * z is clamped before exponentiating, so sigmoid never rounds to exact 0 or 1 in
 * float64. This has to be tighter than it first looks: at z = 40, `exp(-40)` is
 * roughly 4e-18, and `1 + 4e-18` is already below float64's ~2.22e-16 precision
 * floor, so it rounds to exactly `1`, and `1/1 = 1` — silently violating the open
 * interval this clamp exists to guarantee. 30 keeps `exp(-30) ≈ 9.4e-14` safely
 * above that floor, so `1 + exp(-30)` is a genuinely distinct float64 value and the
 * result survives as strictly less than 1 (property P11).
 */
const Z_CLAMP = 30

export function sigmoid(z: number): number {
  if (Number.isNaN(z)) {
    throw new RangeError('sigmoid: input is NaN')
  }
  const clamped = z > Z_CLAMP ? Z_CLAMP : z < -Z_CLAMP ? -Z_CLAMP : z
  return 1 / (1 + Math.exp(-clamped))
}

/** Inverse of sigmoid. `p` must lie in the open interval (0, 1) — exactly what
 * `sigmoid` always produces, which is what makes composing the two safe. */
export function logit(p: number): number {
  if (Number.isNaN(p) || p <= 0 || p >= 1) {
    throw new RangeError(`logit: input must lie in the open interval (0, 1), received ${p}`)
  }
  return Math.log(p / (1 - p))
}
