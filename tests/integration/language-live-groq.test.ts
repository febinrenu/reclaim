/**
 * A real, live call to Groq — not a fixture. Skipped entirely unless
 * `GROQ_API_KEY` is present, exactly like the node-pg block in
 * repositories.test.ts skips without `DATABASE_URL`. Kept to exactly one network
 * call: this project's own budget guard (src/language/budget-guard.ts) sits well
 * under Groq's free tier, and there is no reason for a test suite to spend more
 * of it than proves the adapter genuinely works end to end.
 *
 * `.env` is not auto-loaded into `process.env` by Vitest (unlike Next.js, which
 * loads it for the app itself) — read and applied by hand here so this test can
 * see the same key a real `npm run dev` session would.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

function loadDotEnvIntoProcessEnv(): void {
  const path = resolve(__dirname, '..', '..', '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnvIntoProcessEnv()

const apiKey = process.env.GROQ_API_KEY

describe.skipIf(apiKey === undefined)('the real Groq adapter, live', () => {
  it('drafts real, schema-valid copy end to end through the language service', async () => {
    const { createGroqLlm } = await import('@/adapters/llm/groq')
    const { makeLanguageService, LIVE_POLICY } = await import('@/language/language-service')
    const { createMemoryKv } = await import('@/adapters/kv/memory')
    const { fixedClock } = await import('@/domain/clock')
    const { redactFacts } = await import('@/language/redact-facts')

    const llm = createGroqLlm({ apiKey: apiKey!, model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b' })
    const cacheStore = new Map<string, { message: string; tone: 'neutral' | 'empathetic' | 'urgent'; confidence: number; templateVersion: string }>()
    const service = makeLanguageService({
      llm,
      cache: {
        get: async (key) => cacheStore.get(key) ?? null,
        set: async (key, entry) => {
          cacheStore.set(key, entry)
        },
      },
      kv: createMemoryKv(),
      clock: fixedClock(Date.now()),
      policy: LIVE_POLICY,
    })

    const result = await service.draftNudge({
      transactionId: `pay_live_smoke_${Date.now()}`,
      scenario: 'subscription',
      action: 'WHATSAPP_NUDGE',
      locale: 'en-IN',
      tone: 'empathetic',
      facts: redactFacts({
        amountPaise: 150_000,
        daysOverdue: 2,
        errorCode: 'BAD_REQUEST_ERROR',
        retryCount: 0,
        isRecurring: true,
      }),
    })

    expect(result.source).toBe('llm')
    expect(result.fallbackReason).toBeNull()
    expect(result.message.length).toBeGreaterThan(0)
    // draftNudge returns the raw draft, placeholder and all — process-event.ts's
    // fillSlots() is what substitutes the real amount for a specific customer.
    // What matters here is that the model followed the instruction: no stray
    // real rupee figure it invented on its own (the amount_mismatch guardrail
    // already would have caught one and this result would have been a template
    // fallback instead of `source: 'llm'`, but assert the underlying fact directly).
    const { hasStrayAmount } = await import('@/language/amount-slot')
    expect(hasStrayAmount(result.message)).toBe(false)
    expect(result.promptTokens).toBeGreaterThan(0)
    expect(result.completionTokens).toBeGreaterThan(0)
    expect(result.costMilli).toBeGreaterThan(0)
    expect(result.latencyMs).toBeLessThan(6000)
  }, 15_000)
})

if (apiKey === undefined) {
  console.log('  live Groq test: skipped (GROQ_API_KEY not set)')
}
