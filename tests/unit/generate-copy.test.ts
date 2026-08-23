import { describe, it, expect } from 'vitest'
import { generateCopy } from '@/language/generate-copy'
import type { LlmPort } from '@/ports/llm'

function fakeLlm(respond: (system: string, user: string) => string | Promise<never>): LlmPort {
  return {
    name: 'groq',
    async complete(req) {
      const content = await respond(req.system, req.user)
      return { content, promptTokens: 100, completionTokens: 50 }
    },
  }
}

const REQ = {
  scenario: 'subscription',
  action: 'WHATSAPP_NUDGE',
  locale: 'en-IN' as const,
  tone: 'neutral' as const,
  facts: { amountBand: '1000_5000' },
}

describe('generateCopy', () => {
  it('returns the parsed value on a well-formed response', async () => {
    const llm = fakeLlm(() => '{"message":"Hi, {{amount}} didn\'t go through.","tone":"neutral","confidence":0.9}')
    const result = await generateCopy({ llm }, REQ, { timeoutMs: 1000 })
    expect(result).toEqual({
      ok: true,
      value: { message: "Hi, {{amount}} didn't go through.", tone: 'neutral', confidence: 0.9 },
      promptTokens: 100,
      completionTokens: 50,
    })
  })

  it('a malformed-JSON fixture falls back without crashing', async () => {
    const llm = fakeLlm(() => 'not json at all')
    const result = await generateCopy({ llm }, REQ, { timeoutMs: 1000 })
    expect(result).toEqual({ ok: false, reason: 'invalid_json' })
  })

  it('a fenced-JSON fixture parses successfully rather than falling back', async () => {
    const llm = fakeLlm(() => '```json\n{"message":"Hi there","tone":"empathetic","confidence":0.7}\n```')
    const result = await generateCopy({ llm }, REQ, { timeoutMs: 1000 })
    expect(result.ok).toBe(true)
  })

  it('falls back when the message contains a rupee figure that does not match the transaction', async () => {
    const llm = fakeLlm(() => '{"message":"Your payment of ₹1,500 failed.","tone":"neutral","confidence":0.9}')
    const result = await generateCopy({ llm }, REQ, { timeoutMs: 1000 })
    expect(result).toEqual({ ok: false, reason: 'amount_mismatch' })
  })

  it('falls back on a timeout (AbortError) without throwing', async () => {
    const llm: LlmPort = {
      name: 'groq',
      complete: () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        return Promise.reject(err)
      },
    }
    const result = await generateCopy({ llm }, REQ, { timeoutMs: 1000 })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('falls back on a network error without throwing', async () => {
    const llm: LlmPort = { name: 'groq', complete: () => Promise.reject(new Error('fetch failed')) }
    const result = await generateCopy({ llm }, REQ, { timeoutMs: 1000 })
    expect(result).toEqual({ ok: false, reason: 'network_error' })
  })

  it('never has a slot for a payments client in its deps type — a structural fact, checked here as a compile-time example', () => {
    // @ts-expect-error — PaymentsPort has no relationship to GenerateCopyDeps, so
    // this assignment must fail to typecheck. If it ever compiles, the firewall's
    // second type-level barrier has been weakened.
    const deps: Parameters<typeof generateCopy>[0] = { llm: fakeLlm(() => '{}'), payments: {} }
    void deps
  })
})
