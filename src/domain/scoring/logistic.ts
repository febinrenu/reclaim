/**
 * The recovery scorer's inference half (SYSTEM_SPEC.md §10). Training happens once,
 * offline, in Python (D5); this is the few lines that turn a committed coefficient
 * JSON into a probability, in-process, in well under a millisecond.
 *
 * `pBase` (state only) and `pRecover` (state plus the chosen action's effect) are
 * deliberately two different numbers — see src/domain/scenario/types.ts's
 * `EvBreakdown`. `applyActionLift` is the seam between them: it moves in logit space
 * so the result stays inside (0, 1) by construction, which is what "clamped" means
 * here — the sigmoid *is* the clamp, so there is no separate clamping step to get
 * wrong.
 *
 * Every clamp exists because of property P11: the scorer must return a value in the
 * open unit interval for every finite input, including large ones, and must throw
 * rather than silently propagate a NaN into money arithmetic downstream.
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

export interface LogisticModel<F extends string> {
  readonly intercept: number
  readonly coefficients: Readonly<Record<F, number>>
}

/**
 * `P(recover | s)` — state only, no action. Throws on a NaN feature rather than
 * letting it silently poison the linear combination (property P11).
 */
export function scoreLogistic<F extends string>(
  model: LogisticModel<F>,
  features: Readonly<Record<F, number>>,
): number {
  let z = model.intercept
  for (const key of Object.keys(model.coefficients) as F[]) {
    const value = features[key]
    if (value === undefined) {
      throw new RangeError(`scoreLogistic: missing feature "${key}"`)
    }
    if (Number.isNaN(value)) {
      throw new RangeError(`scoreLogistic: feature "${key}" is NaN`)
    }
    z += model.coefficients[key] * value
  }
  return sigmoid(z)
}

/**
 * Moves `pBase` by a per-action effect expressed in logit space (so, e.g., a nudge
 * that roughly doubles the odds of recovery is a fixed `liftLogit` regardless of
 * where `pBase` started), then re-clamps through sigmoid. `liftLogit = 0` is an
 * identity — this is what makes `DO_NOTHING`, the reference level, come out exactly
 * equal to the organic `pBase` rather than needing a special case.
 */
export function applyActionLift(pBase: number, liftLogit: number): number {
  if (Number.isNaN(liftLogit)) {
    throw new RangeError('applyActionLift: liftLogit is NaN')
  }
  return sigmoid(logit(pBase) + liftLogit)
}
