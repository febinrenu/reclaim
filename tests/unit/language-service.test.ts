import { describe, it, expect } from 'vitest'
import { makeLanguageService, LIVE_POLICY, DEFAULT_BATCH_POLICY } from '@/language/language-service'
import { createMemoryKv } from '@/adapters/kv/memory'
import { fixedClock } from '@/domain/clock'
import type { LlmPort } from '@/ports/llm'
import type { CachePort, CacheEntry } from '@/language/types'

function fakeLlm(message = '{"message":"Hi {{amount}}","tone":"neutral","confidence":0.9}'): LlmPort {
  return {
    name: 'groq',
    async complete() {
      return { content: message, promptTokens: 100, completionTokens: 50 }
    },
  }
}

function memoryCache(): CachePort {
  const store = new Map<string, CacheEntry>()
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async set(key, entry) {
      store.set(key, entry)
    },
  }
}

const NUDGE_INPUT = {
  transactionId: 'pay_test',
  scenario: 'subscription',
  action: 'WHATSAPP_NUDGE' as const,
  locale: 'en-IN' as const,
  tone: 'neutral' as const,
  facts: { amountBand: '1000_5000' },
}

describe('makeLanguageService.draftNudge', () => {
  it('falls back to template with reason no_api_key when llm is null', async () => {
    const service = makeLanguageService({
      llm: null,
      cache: memoryCache(),
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: LIVE_POLICY,
    })
    const result = await service.draftNudge(NUDGE_INPUT)
    expect(result.source).toBe('template')
    expect(result.fallbackReason).toBe('no_api_key')
    expect(result.costMilli).toBe(0)
  })

  it('calls the llm and caches the result when sampled in', async () => {
    let calls = 0
    const llm: LlmPort = {
      name: 'groq',
      async complete() {
        calls++
        return { content: '{"message":"Hi {{amount}}","tone":"neutral","confidence":0.9}', promptTokens: 10, completionTokens: 10 }
      },
    }
    const service = makeLanguageService({
      llm,
      cache: memoryCache(),
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: LIVE_POLICY,
    })
    const result = await service.draftNudge(NUDGE_INPUT)
    expect(result.source).toBe('llm')
    expect(calls).toBe(1)
    expect(result.costMilli).toBeGreaterThan(0)
  })

  it('a second identical request hits the cache rather than calling the llm again', async () => {
    let calls = 0
    const llm: LlmPort = {
      name: 'groq',
      async complete() {
        calls++
        return { content: '{"message":"Hi {{amount}}","tone":"neutral","confidence":0.9}', promptTokens: 10, completionTokens: 10 }
      },
    }
    const service = makeLanguageService({
      llm,
      cache: memoryCache(),
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: LIVE_POLICY,
    })
    await service.draftNudge(NUDGE_INPUT)
    const second = await service.draftNudge(NUDGE_INPUT)
    expect(calls).toBe(1)
    expect(second.source).toBe('cache')
  })

  it('respects the per-run call ceiling, falling back to template once exhausted', async () => {
    const service = makeLanguageService({
      llm: fakeLlm(),
      cache: memoryCache(), // note: distinct transactionId per call, so no cache hits mask the ceiling
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: { ...DEFAULT_BATCH_POLICY, mode: 'always', maxCallsPerRun: 2 },
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => service.draftNudge({ ...NUDGE_INPUT, transactionId: `pay_${i}` })),
    )
    const llmSourced = results.filter((r) => r.source === 'llm')
    const fallback = results.filter((r) => r.fallbackReason === 'sampled_out')
    expect(llmSourced).toHaveLength(2)
    expect(fallback).toHaveLength(3)
  })

  it('falls back to template, not an unhandled rejection, when the llm throws', async () => {
    const llm: LlmPort = { name: 'groq', complete: () => Promise.reject(new Error('network down')) }
    const service = makeLanguageService({
      llm,
      cache: memoryCache(),
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: LIVE_POLICY,
    })
    const result = await service.draftNudge(NUDGE_INPUT)
    expect(result.source).toBe('template')
    expect(result.fallbackReason).toBe('network_error')
  })
})

describe('makeLanguageService.draftRationale', () => {
  it('is synchronous, template-only, and deterministic', () => {
    const service = makeLanguageService({
      llm: null,
      cache: memoryCache(),
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: LIVE_POLICY,
    })
    const input = { transactionId: 'pay_1', action: 'RETRY_NOW', pRecoverPercent: 42, forcedEscalation: false }
    expect(service.draftRationale(input)).toBe(service.draftRationale(input))
    expect(service.draftRationale(input)).toContain('RETRY_NOW')
  })

  it('uses the forced-escalation bank when forced, mentioning ESCALATE_HUMAN\'s reason rather than a probability', () => {
    const service = makeLanguageService({
      llm: null,
      cache: memoryCache(),
      kv: createMemoryKv(),
      clock: fixedClock(0),
      policy: LIVE_POLICY,
    })
    const rationale = service.draftRationale({
      transactionId: 'pay_1',
      action: 'ESCALATE_HUMAN',
      pRecoverPercent: 0,
      forcedEscalation: true,
    })
    expect(rationale.toLowerCase()).toMatch(/risk|retry limit/)
  })
})
