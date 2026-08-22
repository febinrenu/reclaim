import { describe, it, expect } from 'vitest'
import {
  paise, milliPaise, fromRupees, milliFromRupees, toMilli, toPaise,
  addMilli, subMilli, addPaise, scaleMilli, expectedValueOf,
  formatMilli, formatPaise, MILLI_PER_RUPEE,
} from '@/domain/money'

describe('money: construction refuses anything fractional', () => {
  it('accepts safe integers', () => {
    expect(paise(0)).toBe(0)
    expect(paise(-500)).toBe(-500)
    expect(milliPaise(1)).toBe(1)
  })

  it('throws on a fractional value rather than silently truncating', () => {
    // Silent truncation is the failure mode that puts 12.399999999999998 on screen.
    expect(() => paise(1.5)).toThrow(/safe integer/)
    expect(() => milliPaise(0.1)).toThrow(/safe integer/)
  })

  it('throws on NaN and Infinity', () => {
    expect(() => paise(Number.NaN)).toThrow(/finite/)
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(/finite/)
    expect(() => milliPaise(Number.NEGATIVE_INFINITY)).toThrow(/finite/)
  })

  it('throws above the safe integer range', () => {
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })
})

describe('money: rupee conversion rounds explicitly', () => {
  it('converts whole rupees exactly', () => {
    expect(fromRupees(1)).toBe(100)
    expect(fromRupees(842150)).toBe(84215000)
  })

  it('lands the cost table on exact paise', () => {
    // The spec prices a nudge at 0.35 rupees. That must be exactly 35 paise, and
    // exactly 35000 millipaise, every single time.
    expect(fromRupees(0.35)).toBe(35)
    expect(milliFromRupees(0.35)).toBe(35_000)
    expect(milliFromRupees(40)).toBe(4_000_000)
  })

  it('rounds half away from zero, symmetrically across the sign', () => {
    // Math.round alone sends -0.5 to -0, which is a genuine trap for a value that
    // can legitimately be negative, as every cost term here can.
    expect(fromRupees(0.005)).toBe(1)
    expect(fromRupees(-0.005)).toBe(-1)
    expect(fromRupees(0.015)).toBe(2)
    expect(fromRupees(-0.015)).toBe(-2)
  })

  it('represents a sub-paisa language-model cost without flooring it to zero', () => {
    // The whole reason MilliPaise exists: one model call costs about 0.02 paise.
    // In Paise that rounds to nothing and the compute term vanishes from the EV.
    const oneCall = milliFromRupees(0.0002)
    expect(oneCall).toBe(20)
    expect(toPaise(oneCall)).toBe(0)
    expect(oneCall).toBeGreaterThan(0)
  })
})

describe('money: arithmetic stays exact', () => {
  it('widens and narrows without loss on whole paise', () => {
    const p = paise(12345)
    expect(toPaise(toMilli(p))).toBe(12345)
  })

  it('sums 10000 amounts with zero drift', () => {
    // The float version of this test fails. That is the entire point of the module.
    let acc = milliPaise(0)
    for (let i = 1; i <= 10_000; i++) acc = addMilli(acc, milliFromRupees(0.35))
    expect(acc).toBe(10_000 * 35_000)
    expect(acc / MILLI_PER_RUPEE).toBe(3500)
  })

  it('is order independent, which the policy simulator depends on', () => {
    // Float addition is not associative, so a reordered aggregate would produce a
    // phantom delta between a baseline run and a variant run.
    const xs = [1, 7, 13, 999, 100003, 5].map((n) => milliPaise(n))
    const forward = addMilli(...xs)
    const reversed = addMilli(...[...xs].reverse())
    expect(forward).toBe(reversed)
  })

  it('subtracts into negative territory, which a cost term must be able to do', () => {
    expect(subMilli(milliPaise(100), milliPaise(350))).toBe(-250)
  })

  it('adds paise', () => {
    expect(addPaise(paise(100), paise(250), paise(-50))).toBe(300)
  })
})

describe('money: scaling rounds once, at the term boundary', () => {
  it('scales by a probability', () => {
    expect(scaleMilli(milliPaise(1000), 0.5)).toBe(500)
    expect(scaleMilli(milliPaise(1001), 0.5)).toBe(501)
  })

  it('always returns an integer', () => {
    for (const f of [0.333333, 0.7, 0.0001, 0.999999]) {
      const out = scaleMilli(milliPaise(123_457), f)
      expect(Number.isInteger(out)).toBe(true)
    }
  })

  it('rejects a non-finite factor', () => {
    expect(() => scaleMilli(milliPaise(100), Number.NaN)).toThrow(/finite/)
  })
})

describe('money: the expected-gain term', () => {
  it('multiplies an amount by a probability', () => {
    // 2000 rupees at 71 percent, in millipaise.
    expect(expectedValueOf(fromRupees(2000), 0.71)).toBe(142_000_000)
  })

  it('is zero at probability zero and the full amount at one', () => {
    const amt = fromRupees(1234.56)
    expect(expectedValueOf(amt, 0)).toBe(0)
    expect(expectedValueOf(amt, 1)).toBe(toMilli(amt))
  })

  it('refuses a probability outside the unit interval', () => {
    // A probability above one would manufacture money out of a scoring bug.
    expect(() => expectedValueOf(fromRupees(100), 1.4)).toThrow(/\[0, 1\]/)
    expect(() => expectedValueOf(fromRupees(100), -0.1)).toThrow(/\[0, 1\]/)
    expect(() => expectedValueOf(fromRupees(100), Number.NaN)).toThrow(/\[0, 1\]/)
  })
})

describe('money: display uses Indian digit grouping', () => {
  it('groups in lakhs rather than thousands', () => {
    // 8,42,150 not 842,150. Getting this wrong is an instant tell to anyone who
    // actually reads rupee figures.
    expect(formatMilli(milliFromRupees(842150))).toBe('8,42,150.00')
    expect(formatPaise(fromRupees(842150))).toBe('8,42,150.00')
  })

  it('keeps two decimal places', () => {
    expect(formatMilli(milliFromRupees(1))).toBe('1.00')
    expect(formatMilli(milliFromRupees(0.35))).toBe('0.35')
  })
})
