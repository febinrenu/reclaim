/**
 * `makeLanguageService` (BUILD_PLAN.md §5.4 point 3): the orchestrator every
 * caller actually uses. Its deps are exactly `{ llm, cache, kv, clock, policy }`
 * — no `PaymentsPort` slot exists to smuggle one into, which is what makes "the
 * language layer cannot reach payments" a compile-time fact about this function
 * signature rather than a promise about how it happens to be called today.
 *
 * Order of operations per draft: cache first (free), then the policy gate
 * (sampling + the per-run ceiling), then the budget guard, then the actual call
 * through the limiter — each step is a cheaper, more-local check than the one
 * after it, so a request that will end up templated anyway is rejected as early
 * as possible.
 */
import { ZERO_MILLI, type MilliPaise } from '@/domain/money'
import type { Clock } from '@/domain/clock'
import type { Jsonish } from '@/domain/json'
import type { LlmPort } from '@/ports/llm'
import type { KvPort } from '@/ports/kv'
import { generateCopy } from './generate-copy'
import { cacheKeyFor, TEMPLATE_VERSION } from './cache-key'
import { checkBudget, recordTokens } from './budget-guard'
import { createLimiter } from './limiter'
import { shouldSample, createCallCeiling, type SamplingMode } from './sampling'
import { selectNudgeTemplate, selectRationaleTemplate, fillNamedSlots } from './template-engine'
import { computeLlmCostMilli } from './cost'
import type { CachePort, CopyResult, FallbackReason, Locale, Tone } from './types'

export interface LanguageServicePolicy {
  readonly mode: SamplingMode
  readonly sampleRatePercent: number
  readonly maxCallsPerRun: number
  readonly timeoutMs: number
}

export const DEFAULT_BATCH_POLICY: LanguageServicePolicy = {
  mode: 'sampled',
  sampleRatePercent: 8,
  maxCallsPerRun: 24,
  timeoutMs: 6_000,
}

export const LIVE_POLICY: LanguageServicePolicy = {
  mode: 'always',
  sampleRatePercent: 100,
  maxCallsPerRun: Number.POSITIVE_INFINITY,
  timeoutMs: 6_000,
}

export interface LanguageServiceDeps {
  readonly llm: LlmPort | null
  readonly cache: CachePort
  readonly kv: KvPort
  readonly clock: Clock
  readonly policy: LanguageServicePolicy
}

export interface DraftNudgeInput {
  readonly transactionId: string
  readonly scenario: string
  readonly action: 'WHATSAPP_NUDGE' | 'PAYMENT_LINK'
  readonly locale: Locale
  readonly tone: Tone
  readonly facts: Jsonish
}

export interface DraftRationaleInput {
  readonly transactionId: string
  readonly action: string
  readonly pRecoverPercent: number
  readonly forcedEscalation: boolean
  /** SYSTEM_SPEC.md §15: "route to RETRY_LATER and note the systemic (not
   * individual) cause in the rationale." Optional and defaulted false so every
   * existing call site (D7-era) keeps compiling unchanged. */
  readonly shockSuppressed?: boolean
}

export interface LanguageService {
  draftNudge(input: DraftNudgeInput): Promise<CopyResult>
  draftRationale(input: DraftRationaleInput): string
}

export function makeLanguageService(deps: LanguageServiceDeps): LanguageService {
  const ceiling = createCallCeiling(deps.policy.maxCallsPerRun)
  const limiter = createLimiter({ concurrency: 2, minSpacingMs: 350 })

  function templateFallback(input: DraftNudgeInput, reason: FallbackReason, startMs: number): CopyResult {
    const seedKey = `${input.transactionId}:${input.action}`
    const message = selectNudgeTemplate(input.action, input.locale, seedKey)
    return {
      message,
      tone: input.tone,
      confidence: 1,
      source: 'template',
      fallbackReason: reason,
      promptTokens: null,
      completionTokens: null,
      costMilli: ZERO_MILLI,
      latencyMs: deps.clock.nowMs() - startMs,
    }
  }

  async function draftNudge(input: DraftNudgeInput): Promise<CopyResult> {
    const startMs = deps.clock.nowMs()
    const cacheKey = cacheKeyFor(input)

    const cached = await deps.cache.get(cacheKey)
    if (cached !== null) {
      return {
        message: cached.message,
        tone: cached.tone,
        confidence: cached.confidence,
        source: 'cache',
        fallbackReason: null,
        promptTokens: null,
        completionTokens: null,
        costMilli: ZERO_MILLI,
        latencyMs: deps.clock.nowMs() - startMs,
      }
    }

    if (deps.llm === null) {
      return templateFallback(input, 'no_api_key', startMs)
    }
    if (!shouldSample(input.transactionId, deps.policy.mode, deps.policy.sampleRatePercent)) {
      return templateFallback(input, 'sampled_out', startMs)
    }
    if (!ceiling.tryReserve()) {
      return templateFallback(input, 'sampled_out', startMs)
    }

    const budget = await checkBudget(deps.kv)
    if (!budget.allowed) {
      return templateFallback(input, 'budget_exceeded', startMs)
    }

    const llm = deps.llm
    const result = await limiter.run(() =>
      generateCopy(
        { llm },
        { scenario: input.scenario, action: input.action, locale: input.locale, tone: input.tone, facts: input.facts },
        { timeoutMs: deps.policy.timeoutMs },
      ),
    )

    if (!result.ok) {
      return templateFallback(input, result.reason, startMs)
    }

    await recordTokens(deps.kv, result.promptTokens + result.completionTokens)
    await deps.cache.set(cacheKey, {
      message: result.value.message,
      tone: result.value.tone,
      confidence: result.value.confidence,
      templateVersion: TEMPLATE_VERSION,
    })

    const costMilli: MilliPaise = computeLlmCostMilli(result.promptTokens, result.completionTokens)
    return {
      message: result.value.message,
      tone: result.value.tone,
      confidence: result.value.confidence,
      source: 'llm',
      fallbackReason: null,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costMilli,
      latencyMs: deps.clock.nowMs() - startMs,
    }
  }

  /** Always templated — SYSTEM_SPEC.md §12's second language task, but not the
   * signature one this project spends its Groq budget on. Nothing stops a
   * later day from routing this through the same sampling gate above; keeping
   * it template-only for now means every recovery_audit row gets a rationale
   * with zero additional token cost. */
  function draftRationale(input: DraftRationaleInput): string {
    const seedKey = `${input.transactionId}:rationale`
    const template = selectRationaleTemplate(seedKey, {
      forcedEscalation: input.forcedEscalation,
      ...(input.shockSuppressed !== undefined ? { shockSuppressed: input.shockSuppressed } : {}),
    })
    return fillNamedSlots(template, {
      action: input.action,
      pRecoverPercent: input.pRecoverPercent.toFixed(0),
    })
  }

  return { draftNudge, draftRationale }
}
