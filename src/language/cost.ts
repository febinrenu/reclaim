/**
 * `ComputeCost(a)` (SYSTEM_SPEC.md §4): the real dollar cost of a language-model
 * call, computed from actual tokens used, converted to INR at a *pinned* rate —
 * a live FX lookup would break reproducibility from a seed, exactly the same
 * reason every cost-table entry needs a dated provenance comment rather than a
 * live number (BUILD_PLAN.md §6.10).
 *
 * Pricing: BUILD_PLAN.md §2.1 C19, checked against console.groq.com/docs/models
 * — $0.075 per 1M input tokens, $0.30 per 1M output tokens for
 * `openai/gpt-oss-20b`, as of the date recorded there. Confirm again before the
 * cost table is finalised, per BUILD_PLAN.md §2.3.
 */
import { milliFromRupees, type MilliPaise } from '@/domain/money'

/** Pinned 2026-08-24, the day this module was written. A live rate would make
 * `ComputeCost` non-reproducible from a seed — see the module docstring. */
export const USD_TO_INR = 87.5

export const GROQ_PRICE_PER_1M_INPUT_USD = 0.075
export const GROQ_PRICE_PER_1M_OUTPUT_USD = 0.3

export function computeLlmCostMilli(promptTokens: number, completionTokens: number): MilliPaise {
  const inputCostUsd = (promptTokens / 1_000_000) * GROQ_PRICE_PER_1M_INPUT_USD
  const outputCostUsd = (completionTokens / 1_000_000) * GROQ_PRICE_PER_1M_OUTPUT_USD
  const totalCostRupees = (inputCostUsd + outputCostUsd) * USD_TO_INR
  return milliFromRupees(totalCostRupees)
}
