/**
 * A seeded pseudo-random generator, because Math.random would break three things
 * the project depends on:
 *
 *   - synthetic data a reviewer can regenerate byte-for-byte from a seed
 *   - baseline-versus-variant policy comparison under common random numbers, so a
 *     measured difference is a policy effect rather than sampling noise
 *   - template copy variety that is varied across rows but identical across reruns,
 *     so a recorded demo shows the same text on every take
 *
 * mulberry32: small, fast, and good enough for simulation. Not for cryptography,
 * and nothing here needs it to be.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number
  /** True with the given probability. */
  bool(probability: number): boolean
  /** Uniformly chosen element. Throws on an empty array, rather than returning undefined. */
  pick<T>(xs: readonly T[]): T
}

export function mulberry32(seed: number): Rng {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`seed must be finite, received ${seed}`)
  }
  let a = seed >>> 0

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int(minInclusive: number, maxExclusive: number): number {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
        throw new RangeError('int bounds must be integers')
      }
      if (maxExclusive <= minInclusive) {
        throw new RangeError(`empty range [${minInclusive}, ${maxExclusive})`)
      }
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive))
    },
    bool(probability: number): boolean {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new RangeError(`probability must lie in [0, 1], received ${probability}`)
      }
      return next() < probability
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new RangeError('cannot pick from an empty array')
      const item = xs[Math.floor(next() * xs.length)]
      if (item === undefined) throw new Error('unreachable: index derived from length')
      return item
    },
  }
}

/**
 * A stable 32-bit hash of a string, for deriving a per-row seed from an id.
 * This is how template variety and language-model sampling stay deterministic:
 * the same transaction always draws the same variant and always falls on the
 * same side of the sampling threshold.
 */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** Deterministic percentile bucket in [0, 100), for stable sampling decisions. */
export function stableBucket(key: string): number {
  return hashSeed(key) % 100
}
