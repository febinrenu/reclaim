/**
 * The strict JSON schema (SYSTEM_SPEC.md §12, BUILD_PLAN.md §5.8 point 5).
 * Groq's `json_schema` strict mode is a provider *promise*, not a proof — the
 * response is still zod-validated here regardless. `strips markdown fences
 * before parsing` (BUILD_PLAN.md §6.10) is the single most common real-world
 * failure mode the spec never mentions: a model wrapping its JSON in
 * ```json ... ``` even when told not to.
 */
import { z } from 'zod'
import type { Tone } from './types'

export const MODEL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    tone: { type: 'string', enum: ['neutral', 'empathetic', 'urgent'] },
    confidence: { type: 'number' },
  },
  required: ['message', 'tone', 'confidence'],
  additionalProperties: false,
} as const

const ModelOutputSchema = z
  .object({
    message: z.string().min(1).max(500),
    tone: z.enum(['neutral', 'empathetic', 'urgent']),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export interface ParsedModelOutput {
  readonly message: string
  readonly tone: Tone
  readonly confidence: number
}

const FENCE_PATTERN = /^```(?:json)?\s*([\s\S]*?)\s*```$/

/** Strips a markdown code fence if the whole response is wrapped in one —
 * BUILD_PLAN.md §6.10's most common real-world failure. Never strips a fence
 * that only appears *inside* otherwise-valid JSON, since that would be a
 * different, real error to reject rather than paper over. */
function stripFence(raw: string): string {
  const trimmed = raw.trim()
  const match = FENCE_PATTERN.exec(trimmed)
  return match?.[1] ?? trimmed
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedModelOutput }
  | { readonly ok: false; readonly reason: 'invalid_json' }

/** rejects a response containing an "action" key — defense in depth for "the
 * model never decides." `additionalProperties: false` plus `.strict()` already
 * reject it structurally; this is checked before that so the failure reason is
 * explicit rather than folded into a generic parse failure. */
export function parseModelOutput(raw: string): ParseResult {
  const unfenced = stripFence(raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }

  if (typeof parsed === 'object' && parsed !== null && 'action' in parsed) {
    return { ok: false, reason: 'invalid_json' }
  }

  const result = ModelOutputSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, reason: 'invalid_json' }
  }
  return { ok: true, value: result.data }
}
