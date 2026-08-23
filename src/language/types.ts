/**
 * The language layer's own vocabulary. This directory is the firewalled side of
 * BUILD_PLAN.md §5.4: ESLint boundary rule 2 forbids every import a payments
 * client, an executor, or a repository would require, and
 * `tests/unit/firewall.test.ts` walks the transitive import graph so the
 * guarantee survives a refactor that tries to lint-disable it.
 *
 * `CopyRequest.facts` is `Jsonish`, not `Record<string, unknown>` — a payments
 * client has method-valued properties, and no member of that union accepts a
 * callable. `generate-copy.ts`'s exported function additionally wraps the
 * parameter in `DataOnly<CopyRequest>`, which closes the loophole of a field
 * later being widened to `unknown`.
 */
import type { Jsonish } from '@/domain/json'
import type { MilliPaise } from '@/domain/money'

export type Locale = 'en-IN' | 'hi-IN-latn'
export type Tone = 'neutral' | 'empathetic' | 'urgent'
export type CopySource = 'llm' | 'cache' | 'template'
export type FallbackReason =
  | 'sampled_out'
  | 'no_api_key'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_json'
  | 'amount_mismatch'
  | 'network_error'
  | null

/** Already redacted (src/language/redact-facts.ts) before it ever reaches this
 * type — deliberately not the raw transaction/customer row. */
export interface CopyRequest {
  readonly scenario: string
  readonly action: string
  readonly locale: Locale
  readonly tone: Tone
  readonly facts: Jsonish
}

export interface CopyResult {
  readonly message: string
  readonly tone: Tone
  readonly confidence: number
  readonly source: CopySource
  readonly fallbackReason: FallbackReason
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly costMilli: MilliPaise | null
  readonly latencyMs: number
}

export interface CacheEntry {
  readonly message: string
  readonly tone: Tone
  readonly confidence: number
  readonly templateVersion: string
}

/**
 * A narrow interface, not `@/repositories/language-cache.repo.ts` directly —
 * that module imports `@/ports/sql`, and while nothing bans `@/ports/sql` from
 * this directory today, injecting a pre-bound cache object here (built outside
 * src/language/ by whatever already has a database connection) keeps this
 * directory's dependency list exactly as narrow as the firewall test expects,
 * rather than relying on nothing happening to import the repository yet.
 */
export interface CachePort {
  get(key: string): Promise<CacheEntry | null>
  set(key: string, entry: CacheEntry): Promise<void>
}
