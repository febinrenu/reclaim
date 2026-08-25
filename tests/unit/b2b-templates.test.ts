import { describe, it, expect } from 'vitest'
import { SEND_REMINDER_EN, OFFER_PAYMENT_PLAN_EN } from '@/language/templates/reminder-en'
import { fillNamedSlots } from '@/language/template-engine'

describe('B2B reminder/payment-plan template banks', () => {
  it('each bank has eight variants, matching nudge-en.ts\'s own shape', () => {
    expect(SEND_REMINDER_EN).toHaveLength(8)
    expect(OFFER_PAYMENT_PLAN_EN).toHaveLength(8)
  })

  it('every variant carries an {{amount}} slot and fills correctly through the shared engine', () => {
    for (const variant of [...SEND_REMINDER_EN, ...OFFER_PAYMENT_PLAN_EN]) {
      expect(variant).toContain('{{amount}}')
      const filled = fillNamedSlots(variant, { amount: '₹5,000.00' })
      expect(filled).not.toContain('{{amount}}')
      expect(filled).toContain('₹5,000.00')
    }
  })

  it('every variant is distinct within its own bank', () => {
    expect(new Set(SEND_REMINDER_EN).size).toBe(SEND_REMINDER_EN.length)
    expect(new Set(OFFER_PAYMENT_PLAN_EN).size).toBe(OFFER_PAYMENT_PLAN_EN.length)
  })
})
