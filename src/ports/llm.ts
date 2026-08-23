/**
 * The swappable half of the language layer — the network-touching client
 * container.ts selects between (BUILD_PLAN.md §4: template locally, Groq once
 * `GROQ_API_KEY` is set). Deliberately thin: everything that matters for the
 * firewall (BUILD_PLAN.md §5.4) — the `Jsonish`/`DataOnly<T>` type barrier, the
 * narrow deps with no `PaymentsPort` slot — lives in `src/language/`, which this
 * port has no knowledge of. This file could be swapped for a different provider
 * entirely without touching anything the firewall protects.
 */
export interface LlmCompleteRequest {
  readonly system: string
  readonly user: string
  readonly jsonSchema: Readonly<Record<string, unknown>>
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface LlmCompleteResult {
  readonly content: string
  readonly promptTokens: number
  readonly completionTokens: number
}

export interface LlmPort {
  readonly name: 'groq'
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>
}
