import { describe, it, expect } from 'vitest'
import { parseEvBreakdown, parseAmountPaise } from '../../app/audit/view-model'

const VALID_ENTRY = {
  action: 'RETRY_NOW',
  allowed: true,
  disallowedReason: null,
  pBase: 0.1,
  pRecover: 0.15,
  expectedGain: 1000,
  interventionCost: 0,
  computeCost: 0,
  riskPenalty: 0,
  contactFatigueCost: 0,
  ev: 1000,
}

describe('parseEvBreakdown', () => {
  it('parses a well-formed breakdown array', () => {
    const result = parseEvBreakdown([VALID_ENTRY])
    expect(result).not.toBeNull()
    expect(result?.[0]?.action).toBe('RETRY_NOW')
  })

  it('returns null for malformed data rather than throwing', () => {
    expect(parseEvBreakdown('not an array')).toBeNull()
    expect(parseEvBreakdown([{ action: 'X' }])).toBeNull()
    expect(parseEvBreakdown(null)).toBeNull()
  })

  it('accepts every documented disallowed reason', () => {
    const reasons = [
      'stopping_rule',
      'shock_suppressed',
      'no_contact',
      'opted_out',
      'capability_missing',
      'escalation_budget_exhausted',
    ]
    for (const reason of reasons) {
      const result = parseEvBreakdown([{ ...VALID_ENTRY, allowed: false, disallowedReason: reason }])
      expect(result).not.toBeNull()
    }
  })

  it('rejects an unknown disallowed reason', () => {
    const result = parseEvBreakdown([{ ...VALID_ENTRY, allowed: false, disallowedReason: 'made_up_reason' }])
    expect(result).toBeNull()
  })
})

describe('parseAmountPaise', () => {
  it('extracts amount from a decision-input-shaped object', () => {
    expect(parseAmountPaise({ amount: 15000 })).toBe(15000)
  })

  it('returns null for missing or malformed input', () => {
    expect(parseAmountPaise(null)).toBeNull()
    expect(parseAmountPaise({})).toBeNull()
    expect(parseAmountPaise({ amount: 'not a number' })).toBeNull()
    expect(parseAmountPaise('not an object')).toBeNull()
  })
})
