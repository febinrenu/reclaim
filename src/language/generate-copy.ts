/**
 * `generateCopy` — the one function in this codebase that is allowed to reach
 * the language model, and structurally cannot reach a payments client
 * (BUILD_PLAN.md §5.4). Five independent barriers enforce that; the two here are:
 *
 *   1. `DataOnly<CopyRequest>` — even if `CopyRequest` were later widened to
 *      carry an `unknown` field, `DataOnly` maps any function-, Promise-, or
 *      class-instance-valued member to `never`, making the argument
 *      unconstructible for a caller holding a live client.
 *   3. The deps type below (`GenerateCopyDeps`) has exactly one field, `llm`.
 *      There is no slot to smuggle a `PaymentsPort` into, and adding one is a
 *      compile error at every call site.
 *
 * (Barriers 3 and 4 are ESLint boundary rule 2 and `tests/unit/firewall.test.ts`;
 * barrier 5 is ordering — decide() has already returned before this is ever
 * called, and `CopyResult` has no action field. See src/domain/decide.ts.)
 */
import type { DataOnly } from '@/domain/json'
import type { LlmPort } from '@/ports/llm'
import { MODEL_JSON_SCHEMA, parseModelOutput, type ParsedModelOutput } from './schema'
import { hasStrayAmount } from './amount-slot'
import type { CopyRequest, FallbackReason } from './types'

export interface GenerateCopyDeps {
  readonly llm: LlmPort
}

export interface GenerateCopyOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export type GenerateCopyResult =
  | { readonly ok: true; readonly value: ParsedModelOutput; readonly promptTokens: number; readonly completionTokens: number }
  | { readonly ok: false; readonly reason: Exclude<FallbackReason, null | 'sampled_out' | 'no_api_key' | 'budget_exceeded' | 'rate_limited'> }

function buildSystemPrompt(action: string, tone: string): string {
  return (
    `You draft a short, natural recovery message for a payment-failure scenario. ` +
    `The action being taken is ${action}, and the tone should be ${tone}. ` +
    `You are given only bucketed, non-identifying facts — never a customer's name, phone ` +
    `number, or exact amount. Wherever the exact amount would belong in the message, write ` +
    `the literal placeholder text "{{amount}}" — never invent or guess a rupee figure. ` +
    `If a payment link belongs in the message, write the literal placeholder "{{link}}". ` +
    `Return only the JSON object described by the schema — no markdown, no commentary.`
  )
}

export async function generateCopy(
  deps: GenerateCopyDeps,
  req: DataOnly<CopyRequest>,
  opts: GenerateCopyOptions,
): Promise<GenerateCopyResult> {
  const system = buildSystemPrompt(req.action, req.tone)
  const user = JSON.stringify(req.facts)

  let content: string
  let promptTokens: number
  let completionTokens: number
  try {
    const result = await deps.llm.complete({
      system,
      user,
      jsonSchema: MODEL_JSON_SCHEMA,
      timeoutMs: opts.timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    content = result.content
    promptTokens = result.promptTokens
    completionTokens = result.completionTokens
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError'
    return { ok: false, reason: isAbort ? 'timeout' : 'network_error' }
  }

  const parsed = parseModelOutput(content)
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid_json' }
  }
  if (hasStrayAmount(parsed.value.message)) {
    return { ok: false, reason: 'amount_mismatch' }
  }

  return { ok: true, value: parsed.value, promptTokens, completionTokens }
}
