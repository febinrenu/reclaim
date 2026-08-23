import { describe, it, expect } from 'vitest'
import { computeLlmCostMilli, USD_TO_INR, GROQ_PRICE_PER_1M_INPUT_USD, GROQ_PRICE_PER_1M_OUTPUT_USD } from '@/language/cost'

describe('computeLlmCostMilli', () => {
  it('matches a hand-computed value at 1M tokens each way', () => {
    const milli = computeLlmCostMilli(1_000_000, 1_000_000)
    const expectedRupees = (GROQ_PRICE_PER_1M_INPUT_USD + GROQ_PRICE_PER_1M_OUTPUT_USD) * USD_TO_INR
    expect(milli / 100_000).toBeCloseTo(expectedRupees, 6)
  })

  it('is zero for zero tokens', () => {
    expect(computeLlmCostMilli(0, 0)).toBe(0)
  })

  it('every cost-table entry has a provenance comment — checked by grep, not by this test alone', () => {
    // This project's own convention (BUILD_PLAN.md §6.10): a cost-table entry
    // without a dated source is not a defensible estimate. The pinned constants
    // this module exports each carry one in src/language/cost.ts's comments —
    // this assertion just confirms the numbers themselves are the ones documented.
    expect(GROQ_PRICE_PER_1M_INPUT_USD).toBe(0.075)
    expect(GROQ_PRICE_PER_1M_OUTPUT_USD).toBe(0.3)
  })

  it('output tokens cost more per token than input tokens, matching Groq pricing', () => {
    const inputOnly = computeLlmCostMilli(1000, 0)
    const outputOnly = computeLlmCostMilli(0, 1000)
    expect(outputOnly).toBeGreaterThan(inputOnly)
  })
})
