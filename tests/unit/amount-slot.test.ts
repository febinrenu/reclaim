import { describe, it, expect } from 'vitest'
import { hasStrayAmount, fillAmountSlot, fillLinkSlot, fillSlots, formatRupeesForCopy } from '@/language/amount-slot'

describe('hasStrayAmount', () => {
  it('is false for a message using only the placeholder', () => {
    expect(hasStrayAmount('Your payment of {{amount}} failed.')).toBe(false)
  })

  it('is false for a message with no amount reference at all', () => {
    expect(hasStrayAmount('We noticed a recent payment issue.')).toBe(false)
  })

  it('catches a rupee-symbol figure the model stated on its own (the real guardrail)', () => {
    expect(hasStrayAmount('Your payment of ₹1,500 failed.')).toBe(true)
  })

  it('catches "Rs" and "rupees" phrasing too', () => {
    expect(hasStrayAmount('Your payment of Rs. 500 failed.')).toBe(true)
    expect(hasStrayAmount('Your payment of 500 rupees failed.')).toBe(true)
  })

  it('does not false-positive on an unrelated number', () => {
    expect(hasStrayAmount('This is your 3rd reminder about the payment.')).toBe(false)
  })
})

describe('fillAmountSlot / fillLinkSlot / fillSlots', () => {
  it('replaces every occurrence of the amount placeholder with Indian-grouped rupees', () => {
    expect(fillAmountSlot('{{amount}} and again {{amount}}', 150_000_00)).toBe('₹1,50,000 and again ₹1,50,000')
  })

  it('fillSlots fills both amount and link when a link is provided', () => {
    const result = fillSlots('Pay {{amount}} here: {{link}}', { amountPaise: 1000_00, link: 'https://example.test' })
    expect(result).toBe('Pay ₹1,000 here: https://example.test')
  })

  it('fillSlots leaves the link placeholder untouched when no link is given', () => {
    const result = fillSlots('Pay {{amount}} here: {{link}}', { amountPaise: 1000_00 })
    expect(result).toContain('{{link}}')
  })

  it('fillLinkSlot replaces every occurrence', () => {
    expect(fillLinkSlot('{{link}} or {{link}}', 'https://x.test')).toBe('https://x.test or https://x.test')
  })
})

describe('formatRupeesForCopy', () => {
  it('uses Indian digit grouping', () => {
    expect(formatRupeesForCopy(150_000_00)).toBe('₹1,50,000')
    expect(formatRupeesForCopy(1_500_00)).toBe('₹1,500')
  })
})
