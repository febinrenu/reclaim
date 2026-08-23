import { describe, it, expect } from 'vitest'
import { amountBand, overdueBand, errorClass, redactFacts } from '@/language/redact-facts'

describe('amountBand', () => {
  it('buckets into six bands at the documented boundaries', () => {
    expect(amountBand(100_00)).toBe('under_200')
    expect(amountBand(199_99)).toBe('under_200')
    expect(amountBand(200_00)).toBe('200_1000')
    expect(amountBand(999_99)).toBe('200_1000')
    expect(amountBand(1_000_00)).toBe('1000_5000')
    expect(amountBand(4_999_99)).toBe('1000_5000')
    expect(amountBand(5_000_00)).toBe('5000_20000')
    expect(amountBand(19_999_99)).toBe('5000_20000')
    expect(amountBand(20_000_00)).toBe('20000_100000')
    expect(amountBand(99_999_99)).toBe('20000_100000')
    expect(amountBand(100_000_00)).toBe('over_100000')
    expect(amountBand(10_000_000_00)).toBe('over_100000')
  })
})

describe('overdueBand', () => {
  it('buckets into four bands', () => {
    expect(overdueBand(0)).toBe('same_day')
    expect(overdueBand(3)).toBe('within_week')
    expect(overdueBand(7)).toBe('within_week')
    expect(overdueBand(8)).toBe('within_month')
    expect(overdueBand(30)).toBe('within_month')
    expect(overdueBand(31)).toBe('over_month')
  })
})

describe('errorClass', () => {
  it('passes through the three verifiable error_code values, lowercased', () => {
    expect(errorClass('BAD_REQUEST_ERROR')).toBe('bad_request_error')
    expect(errorClass('GATEWAY_ERROR')).toBe('gateway_error')
    expect(errorClass('SERVER_ERROR')).toBe('server_error')
  })

  it('has an explicit default branch rather than an exhaustive enum (BUILD_PLAN.md C10)', () => {
    expect(errorClass('SOMETHING_RAZORPAY_NEVER_DOCUMENTED')).toBe('other')
    expect(errorClass(null)).toBe('unknown')
  })
})

describe('redactFacts', () => {
  it('never leaks the exact amount, only the band', () => {
    const facts = redactFacts({
      amountPaise: 150_00,
      daysOverdue: 2,
      errorCode: 'BAD_REQUEST_ERROR',
      retryCount: 1,
      isRecurring: true,
    })
    expect(JSON.stringify(facts)).not.toContain('150')
    expect(facts).toMatchObject({ amountBand: 'under_200' })
  })

  it('caps retryCount at 3, matching the stopping-rule ceiling', () => {
    const facts = redactFacts({
      amountPaise: 1000_00,
      daysOverdue: 0,
      errorCode: null,
      retryCount: 99,
      isRecurring: false,
    })
    expect(facts).toMatchObject({ retryCount: 3 })
  })
})
