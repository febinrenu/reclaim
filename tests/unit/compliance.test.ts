import { describe, it, expect } from 'vitest'
import {
  isQuietHoursIst,
  exceedsContactCap,
  capabilityRespectingCompliance,
} from '@/domain/compliance'

describe('isQuietHoursIst', () => {
  it('is true at 05:30 IST (epoch)', () => {
    expect(isQuietHoursIst(0)).toBe(true)
  })

  it('is false at midday IST', () => {
    // 06:30 UTC == 12:00 IST
    expect(isQuietHoursIst(6.5 * 60 * 60 * 1000)).toBe(false)
  })

  it('is true exactly at the 21:00 IST boundary and false exactly at 09:00', () => {
    // 15:30 UTC == 21:00 IST
    expect(isQuietHoursIst(15.5 * 60 * 60 * 1000)).toBe(true)
    // 03:30 UTC == 09:00 IST
    expect(isQuietHoursIst(3.5 * 60 * 60 * 1000)).toBe(false)
  })

  it('is true just before 09:00 IST and just after 21:00 IST', () => {
    expect(isQuietHoursIst(3.5 * 60 * 60 * 1000 - 1)).toBe(true)
    expect(isQuietHoursIst(15.5 * 60 * 60 * 1000 + 1)).toBe(true)
  })
})

describe('exceedsContactCap', () => {
  it('is false strictly below the cap, true at and above it', () => {
    expect(exceedsContactCap(2, 3)).toBe(false)
    expect(exceedsContactCap(3, 3)).toBe(true)
    expect(exceedsContactCap(4, 3)).toBe(true)
  })
})

describe('capabilityRespectingCompliance', () => {
  const actions = ['RETRY_NOW', 'WHATSAPP_NUDGE', 'PAYMENT_LINK', 'ESCALATE_HUMAN'] as const
  const requiresContact = (a: (typeof actions)[number]) => a === 'WHATSAPP_NUDGE' || a === 'PAYMENT_LINK'

  it('every action is capable when contact is not blocked', () => {
    const cap = capabilityRespectingCompliance(actions, requiresContact, false)
    for (const a of actions) expect(cap[a]).toBe(true)
  })

  it('only contact-requiring actions lose capability when contact is blocked', () => {
    const cap = capabilityRespectingCompliance(actions, requiresContact, true)
    expect(cap.RETRY_NOW).toBe(true)
    expect(cap.ESCALATE_HUMAN).toBe(true)
    expect(cap.WHATSAPP_NUDGE).toBe(false)
    expect(cap.PAYMENT_LINK).toBe(false)
  })
})
