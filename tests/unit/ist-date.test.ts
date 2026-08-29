import { describe, it, expect } from 'vitest'
import { istHourOfDay, istCalendarDate } from '@/domain/ist-date'

describe('istHourOfDay', () => {
  it('epoch (1970-01-01T00:00:00Z) is 05:30 IST — hour 5', () => {
    expect(istHourOfDay(0)).toBe(5)
  })

  it('wraps forward across the IST day boundary', () => {
    // 1970-01-01T18:30:00Z == 1970-01-02T00:00:00 IST
    expect(istHourOfDay(18.5 * 60 * 60 * 1000)).toBe(0)
  })

  it('handles a negative nowMs (before the epoch) without going negative', () => {
    // One second before epoch is 1969-12-31T23:59:59Z == 05:29:59 IST
    expect(istHourOfDay(-1000)).toBe(5)
  })
})

describe('istCalendarDate', () => {
  it('epoch (00:00 UTC == 05:30 IST) is still the same calendar day', () => {
    expect(istCalendarDate(0)).toBe('1970-01-01')
  })

  it('rolls over at IST midnight, not UTC midnight', () => {
    const beforeIstMidnight = 18 * 60 * 60 * 1000 - 1000 // 17:59:59 UTC
    const atIstMidnight = 18.5 * 60 * 60 * 1000 // 18:30:00 UTC == 00:00:00 IST next day
    expect(istCalendarDate(beforeIstMidnight)).toBe('1970-01-01')
    expect(istCalendarDate(atIstMidnight)).toBe('1970-01-02')
  })

  it('matches a known real date, including a leap-year February', () => {
    // 2026-08-29T10:00:00Z == 2026-08-29T15:30:00 IST — same calendar day.
    expect(istCalendarDate(Date.parse('2026-08-29T10:00:00Z'))).toBe('2026-08-29')
    // 2024-02-29T20:00:00Z == 2024-03-01T01:30:00 IST — crosses into March on a leap day.
    expect(istCalendarDate(Date.parse('2024-02-29T20:00:00Z'))).toBe('2024-03-01')
  })
})
