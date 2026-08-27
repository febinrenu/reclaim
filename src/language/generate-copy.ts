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

/** Real actions ever call this: subscription's PAYMENT_LINK always has one to
 * fill; WHATSAPP_NUDGE gets a dry-run fallback string
 * (`process-event.ts`/`process-invoice-event.ts`'s own `draftNudgeIfNeeded`
 * helpers). Every other action — including B2B's SEND_REMINDER/
 * OFFER_PAYMENT_PLAN, which have no link concept at all — must never see the
 * model invited to write `{{link}}` in the first place: `fillSlots`
 * (amount-slot.ts) only fills it when a caller actually supplies one, so an
 * unfilled placeholder would otherwise reach the customer verbatim, exactly
 * the live bug a real B2B request surfaced (docs/INCIDENTS.md). */
const LINK_CAPABLE_ACTIONS = new Set(['PAYMENT_LINK', 'WHATSAPP_NUDGE'])

/** `scenario` is a free-form string (`CopyRequest.scenario`), not narrowed to
 * subscription's own vocabulary — B2B's overdue-invoice framing needed a
 * genuinely different description, not "payment failure," once a real B2B
 * request went through the LLM path and produced a subscription-shaped
 * message ("your recent payment did not process") for an invoice that was
 * never a failed payment attempt at all. */
function buildSystemPrompt(scenario: string, action: string, tone: string): string {
  const context =
    scenario === 'b2b_receivable'
      ? 'an overdue B2B invoice that needs to be chased for payment'
      : 'a payment that failed and needs to be recovered'
  const linkClause = LINK_CAPABLE_ACTIONS.has(action)
    ? `If a payment link belongs in the message, write the literal placeholder "{{link}}". `
    : `Do not reference a payment link or write the placeholder "{{link}}" — none will be provided. `
  return (
    `You draft a short, natural recovery message for ${context}. ` +
    `The action being taken is ${action}, and the tone should be ${tone}. ` +
    `You are given only bucketed, non-identifying facts — never a customer's name, phone ` +
    `number, or exact amount. Wherever the exact amount would belong in the message, write ` +
    `the literal placeholder text "{{amount}}" — never invent or guess a rupee figure. ` +
    linkClause +
    `Return only the JSON object described by the schema — no markdown, no commentary.`
  )
}

export async function generateCopy(
  deps: GenerateCopyDeps,
  req: DataOnly<CopyRequest>,
  opts: GenerateCopyOptions,
): Promise<GenerateCopyResult> {
  const system = buildSystemPrompt(req.scenario, req.action, req.tone)
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
