/**
 * The Groq adapter (BUILD_PLAN.md §5.8 point 5): plain `fetch` against the
 * OpenAI-compatible endpoint, no SDK. Strict `json_schema` structured output,
 * which is mutually exclusive with streaming and tools — neither is used here.
 *
 * `reasoning_effort: 'low'` is not in BUILD_PLAN.md, and is added because of what
 * a real call against this account showed: `openai/gpt-oss-20b` is a reasoning
 * model, and its default reasoning effort spent 259 hidden "reasoning" tokens
 * (themselves billed as completion tokens) to draft a two-sentence WhatsApp
 * message — 567 total tokens and 357ms. `reasoning_effort: 'low'` cut that to 27
 * reasoning tokens, 293 total, 124ms, with no visible quality loss on the same
 * prompt. Against BUILD_PLAN.md §5.8's token budget (200k/day free tier, a 150k/day
 * guard set under it), that difference is the gap between a batch comfortably
 * fitting the daily budget and one that does not.
 */
import type { LlmPort, LlmCompleteRequest, LlmCompleteResult } from '@/ports/llm'

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const MAX_RETRIES = 3

export interface GroqAdapterOptions {
  readonly apiKey: string
  readonly model: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitteredBackoffMs(attempt: number): number {
  const base = 250 * 2 ** attempt
  return base + Math.floor(Math.random() * 150)
}

export function createGroqLlm(opts: GroqAdapterOptions): LlmPort {
  return {
    name: 'groq',

    async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
      let lastError: unknown = null

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), req.timeoutMs)
        if (req.signal !== undefined) {
          req.signal.addEventListener('abort', () => controller.abort())
        }

        try {
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify({
              model: opts.model,
              reasoning_effort: 'low',
              messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'copy_result', strict: true, schema: req.jsonSchema },
              },
            }),
            signal: controller.signal,
          })
          clearTimeout(timeout)

          if (res.status === 429 || res.status >= 500) {
            const retryAfterHeader = res.headers.get('retry-after')
            const retryAfterMs = retryAfterHeader !== null ? Number(retryAfterHeader) * 1000 : null
            lastError = new Error(`groq: ${res.status} ${res.statusText}`)
            if (attempt < MAX_RETRIES) {
              await sleep(retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : jitteredBackoffMs(attempt))
              continue
            }
            throw lastError
          }

          if (!res.ok) {
            throw new Error(`groq: ${res.status} ${res.statusText}`)
          }

          const body = (await res.json()) as {
            choices?: readonly { message?: { content?: string } }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const content = body.choices?.[0]?.message?.content
          if (content === undefined) {
            throw new Error('groq: response had no message content')
          }
          return {
            content,
            promptTokens: body.usage?.prompt_tokens ?? 0,
            completionTokens: body.usage?.completion_tokens ?? 0,
          }
        } catch (err) {
          clearTimeout(timeout)
          lastError = err
          if (controller.signal.aborted && req.signal?.aborted !== true) {
            // Our own timeout fired, not the caller's cancellation — worth one
            // more attempt within the retry budget, not an infinite loop.
            if (attempt < MAX_RETRIES) {
              await sleep(jitteredBackoffMs(attempt))
              continue
            }
          }
          if (attempt >= MAX_RETRIES) throw lastError
        }
      }

      throw lastError ?? new Error('groq: exhausted retries')
    },
  }
}
