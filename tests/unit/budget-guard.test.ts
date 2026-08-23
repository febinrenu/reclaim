import { describe, it, expect } from 'vitest'
import { createMemoryKv } from '@/adapters/kv/memory'
import { checkBudget, recordTokens, type BudgetLimits } from '@/language/budget-guard'

const TINY_LIMITS: BudgetLimits = { requestsPerMinute: 2, tokensPerMinute: 100, requestsPerDay: 5, tokensPerDay: 1000 }

describe('checkBudget', () => {
  it('allows requests under every limit', async () => {
    const kv = createMemoryKv()
    expect((await checkBudget(kv, TINY_LIMITS)).allowed).toBe(true)
  })

  it('refuses once the per-minute request count is exceeded', async () => {
    const kv = createMemoryKv()
    await checkBudget(kv, TINY_LIMITS)
    await checkBudget(kv, TINY_LIMITS)
    const third = await checkBudget(kv, TINY_LIMITS)
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe('requests_per_minute_exceeded')
  })

  it('refuses once recorded token usage meets the per-minute token limit', async () => {
    const kv = createMemoryKv()
    await recordTokens(kv, 100) // exactly at the tiny limit
    const result = await checkBudget(kv, TINY_LIMITS)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('tokens_per_minute_exceeded')
  })

  const DAY_ONLY_LIMITS: BudgetLimits = { ...TINY_LIMITS, tokensPerMinute: 100_000, tokensPerDay: 1000 }

  it('refuses once recorded token usage meets the per-day token limit even if the minute window would allow it', async () => {
    const kv = createMemoryKv()
    await recordTokens(kv, 1000)
    const result = await checkBudget(kv, DAY_ONLY_LIMITS)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('tokens_per_day_exceeded')
  })

  it('token checks run before request-count increments, so a token-exhausted budget never spends a request slot', async () => {
    const kv = createMemoryKv()
    await recordTokens(kv, 1000)
    await checkBudget(kv, DAY_ONLY_LIMITS)
    await checkBudget(kv, DAY_ONLY_LIMITS)
    // Still refusing on tokens, not now also on requests-per-minute, which would
    // indicate the request counter was incremented on every failed attempt.
    const result = await checkBudget(kv, DAY_ONLY_LIMITS)
    expect(result.reason).toBe('tokens_per_day_exceeded')
  })
})
