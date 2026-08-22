import { describe, it, expect } from 'vitest'
import { mulberry32, hashSeed, stableBucket } from '@/domain/rng'
import { fixedClock, manualClock } from '@/domain/clock'

describe('seeded rng: determinism is the whole point', () => {
  it('produces an identical stream for an identical seed', () => {
    // This is what lets a reviewer regenerate our exact demo numbers.
    const a = mulberry32(20260905)
    const b = mulberry32(20260905)
    const seqA = Array.from({ length: 200 }, () => a.next())
    const seqB = Array.from({ length: 200 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('produces a different stream for a different seed', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect(a.next()).not.toBe(b.next())
  })

  it('stays within the unit interval over a long run', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 20_000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is roughly uniform, so simulated outcomes are not skewed', () => {
    const r = mulberry32(99)
    const buckets = new Array<number>(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i++) buckets[Math.floor(r.next() * 10)]!++
    // Each decile should hold about a tenth. Generous tolerance: this checks for a
    // broken generator, not for cryptographic quality.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 * 0.9)
      expect(count).toBeLessThan(n / 10 * 1.1)
    }
  })

  it('rejects a non-finite seed', () => {
    expect(() => mulberry32(Number.NaN)).toThrow(/finite/)
  })
})

describe('seeded rng: helpers', () => {
  it('int stays inside the half open range', () => {
    const r = mulberry32(3)
    for (let i = 0; i < 5_000; i++) {
      const v = r.int(5, 9)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThan(9)
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('int rejects an empty or non integer range', () => {
    const r = mulberry32(3)
    expect(() => r.int(5, 5)).toThrow(/empty range/)
    expect(() => r.int(9, 5)).toThrow(/empty range/)
    expect(() => r.int(0.5, 5)).toThrow(/integers/)
  })

  it('bool respects its probability', () => {
    const r = mulberry32(11)
    let hits = 0
    for (let i = 0; i < 50_000; i++) if (r.bool(0.2)) hits++
    expect(hits / 50_000).toBeCloseTo(0.2, 2)
  })

  it('bool rejects a probability outside the unit interval', () => {
    const r = mulberry32(11)
    expect(() => r.bool(1.2)).toThrow(/\[0, 1\]/)
  })

  it('pick throws on an empty array rather than returning undefined', () => {
    // Returning undefined here would surface much later as a null template variant.
    const r = mulberry32(2)
    expect(() => r.pick([])).toThrow(/empty array/)
    expect(r.pick(['only'])).toBe('only')
  })
})

describe('stable hashing: the basis of deterministic sampling', () => {
  it('is stable for the same input', () => {
    expect(hashSeed('pay_QK2f1a')).toBe(hashSeed('pay_QK2f1a'))
  })

  it('separates similar inputs', () => {
    expect(hashSeed('pay_QK2f1a')).not.toBe(hashSeed('pay_QK2f1b'))
  })

  it('returns an unsigned 32 bit integer', () => {
    for (const s of ['', 'a', 'pay_QK2f1a', 'x'.repeat(500)]) {
      const h = hashSeed(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('buckets into [0, 100) so a sampling rate is a stable decision', () => {
    // The language layer samples 8 percent of a batch. Deterministic bucketing is
    // what makes the same 24 rows get model-written copy on every rerun, which is
    // what makes a recorded demo reproducible.
    const ids = Array.from({ length: 2000 }, (_, i) => `pay_${i}`)
    const buckets = ids.map(stableBucket)
    for (const b of buckets) {
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(100)
    }
    const sampled = buckets.filter((b) => b < 8).length
    // Roughly 8 percent of 2000, allowing for hash lumpiness.
    expect(sampled).toBeGreaterThan(100)
    expect(sampled).toBeLessThan(220)
  })

  it('gives the same sampling verdict on a repeat run', () => {
    const first = Array.from({ length: 300 }, (_, i) => stableBucket(`pay_${i}`) < 8)
    const second = Array.from({ length: 300 }, (_, i) => stableBucket(`pay_${i}`) < 8)
    expect(first).toEqual(second)
  })
})

describe('clock injection', () => {
  it('fixedClock pins one instant', () => {
    const c = fixedClock(1_756_000_000_000)
    expect(c.nowMs()).toBe(1_756_000_000_000)
    expect(c.nowMs()).toBe(1_756_000_000_000)
  })

  it('fixedClock rejects a non finite instant', () => {
    expect(() => fixedClock(Number.NaN)).toThrow(/finite/)
  })

  it('manualClock advances only forward', () => {
    // The retry rungs are at +2h and +24h. A clock that can move backwards would
    // make those rules untestable in the one direction that matters.
    const c = manualClock(1000)
    expect(c.nowMs()).toBe(1000)
    c.advance(2 * 60 * 60 * 1000)
    expect(c.nowMs()).toBe(1000 + 7_200_000)
    expect(() => c.advance(-1)).toThrow(/backwards/)
  })
})
