/**
 * The type-level half of the language firewall.
 *
 * The spec requires that the language model can never reach a money-moving API,
 * and that this be enforced by a type signature rather than a comment asking
 * nicely. Four independent barriers enforce it. These are the first two.
 *
 *   1. Jsonish       - the only channel into a language call is plain JSON data.
 *                      A payments client has method-valued properties, and no member
 *                      of this union accepts a callable, so passing one does not
 *                      typecheck. Nor does burying it: { facts: { client } } fails on
 *                      the recursive index signature.
 *
 *   2. DataOnly<T>   - closes the loopholes Jsonish alone would leave open. If a
 *                      field is later widened to `unknown`, or someone adds a `meta`
 *                      escape hatch, DataOnly maps any function-, Promise-, or
 *                      class-instance-valued member to `never`, which makes the
 *                      argument unconstructible rather than merely discouraged.
 *
 *   3. ESLint boundary rule 2 in eslint.config.mjs.
 *   4. tests/unit/firewall.test.ts, which walks the transitive import graph so the
 *      guarantee survives a refactor that tries to lint-disable rule 3.
 *
 * And an ordering guarantee that is arguably stronger than all four: the pipeline
 * is decide-then-speak. decide() has already returned before any language call is
 * made, and the copy result type carries no action field. Even a fully adversarial
 * model response cannot change what gets executed. It can only change a string in
 * a rationale column.
 */

export type Jsonish =
  | string
  | number
  | boolean
  | null
  | readonly Jsonish[]
  | { readonly [key: string]: Jsonish }

/**
 * Recursively strips anything that could carry behaviour or identity.
 *
 * Functions and Promises become `never`. Class instances survive only as their
 * data-bearing shape, and any method on them becomes `never`, so an object with
 * methods cannot satisfy the constraint. Applied to a parameter type, the effect
 * is that a caller holding a live client has nothing they can legally pass.
 */
export type DataOnly<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends Promise<unknown>
    ? never
    : T extends readonly (infer U)[]
      ? readonly DataOnly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DataOnly<T[K]> }
        : T

/**
 * Runtime companion to the compile-time guarantee, for the boundary where data
 * arrives from outside the type system: a database jsonb column, a parsed request
 * body, a model response. Depth-limited, because a hostile or accidentally cyclic
 * structure must fail loudly rather than hang.
 */
export function assertPlain(value: unknown, path = '$', depth = 0): asserts value is Jsonish {
  if (depth > 32) {
    throw new TypeError(`assertPlain: structure deeper than 32 levels at ${path}, likely cyclic`)
  }

  if (value === null) return

  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') {
    if (t === 'number' && !Number.isFinite(value as number)) {
      throw new TypeError(`assertPlain: ${path} is ${String(value)}, which is not valid JSON`)
    }
    return
  }

  if (t === 'function') {
    throw new TypeError(
      `assertPlain: ${path} is a function. Only plain data may cross this boundary. ` +
        `See src/domain/json.ts.`,
    )
  }

  if (t !== 'object') {
    throw new TypeError(`assertPlain: ${path} has unsupported type ${t}`)
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlain(item, `${path}[${i}]`, depth + 1))
    return
  }

  // A class instance, a Map, a Date, or anything else with a non-Object prototype
  // is rejected. This is what stops a live client from being smuggled through a
  // field whose declared type was widened.
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== null && proto !== Object.prototype) {
    const name = (value as object).constructor?.name ?? 'unknown'
    throw new TypeError(
      `assertPlain: ${path} is a ${name} instance, not a plain object. ` +
        `Serialise it to plain data before it crosses this boundary.`,
    )
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertPlain(v, `${path}.${k}`, depth + 1)
  }
}

/** Non-throwing form, for places that want to branch rather than fail. */
export function isPlain(value: unknown): value is Jsonish {
  try {
    assertPlain(value)
    return true
  } catch {
    return false
  }
}
