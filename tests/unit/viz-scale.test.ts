import { describe, it, expect } from 'vitest'
import { linear, niceMax, ticks, clamp } from '~/_viz/scale'

describe('linear', () => {
  it('hits both range endpoints exactly at the domain endpoints', () => {
    const f = linear(0, 100, 10, 210)
    expect(f(0)).toBe(10)
    expect(f(100)).toBe(210)
    expect(f(50)).toBe(110)
  })

  it('never returns NaN on a degenerate domain', () => {
    const f = linear(5, 5, 0, 340)
    expect(f(5)).toBe(0)
    expect(f(999)).toBe(0)
    expect(Number.isFinite(f(0))).toBe(true)
  })

  it('handles a reversed range', () => {
    const f = linear(0, 10, 100, 0)
    expect(f(0)).toBe(100)
    expect(f(10)).toBe(0)
  })
})

describe('niceMax', () => {
  it('rounds up to a 1/2/5 x 10^k value at or above the input', () => {
    expect(niceMax(1)).toBe(1)
    expect(niceMax(1.5)).toBe(2)
    expect(niceMax(3)).toBe(5)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(42)).toBe(50)
    expect(niceMax(120)).toBe(200)
  })

  it('is always >= its input for positive values', () => {
    for (const v of [0.3, 1, 4, 9, 17, 250, 999, 100_000]) {
      expect(niceMax(v)).toBeGreaterThanOrEqual(v)
    }
  })

  it('is monotone: a larger input never produces a smaller nice max', () => {
    const inputs = [1, 3, 7, 12, 45, 88, 250, 999]
    let prev = 0
    for (const v of inputs) {
      const n = niceMax(v)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })

  it('never returns zero or a non-finite value, even for zero or negative input', () => {
    expect(niceMax(0)).toBeGreaterThan(0)
    expect(niceMax(-5)).toBeGreaterThan(0)
    expect(Number.isFinite(niceMax(0))).toBe(true)
  })
})

describe('ticks', () => {
  it('is ascending and starts at zero', () => {
    const t = ticks(100, 4)
    expect(t[0]).toBe(0)
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThan(t[i - 1] as number)
    }
  })

  it('spans exactly [0, max]', () => {
    const t = ticks(100, 5)
    expect(t[0]).toBe(0)
    expect(t[t.length - 1]).toBe(100)
  })

  it('de-duplicates and stays non-empty for a degenerate max', () => {
    expect(ticks(0, 4)).toEqual([0])
    expect(ticks(100, 0)).toEqual([0])
  })
})

describe('clamp', () => {
  it('clamps into the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
  })
})
