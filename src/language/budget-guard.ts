/**
 * The rolling-window budget guard (BUILD_PLAN.md §5.8 point 3), set deliberately
 * below Groq's own free-tier limits (30 req/min, 8k tokens/min, 1,000 req/day,
 * 200k tokens/day), leaving headroom for retries and the live demo.
 *
 * Request counts use `KvPort.incrWithTtl`, which is atomic per BUILD_PLAN.md
 * §5.1 A1's own reasoning about that port. Token totals do not: there is no
 * atomic "increment by N" on this port (only by one), so token accounting is a
 * best-effort read-then-write. That is an acceptable trade for what this guard
 * is — a soft cost control, never the idempotency authority, exactly like every
 * other use of the KV port (src/ports/kv.ts). At the concurrency this project
 * ever calls it under (limiter.ts caps it at 2), the race window is small and
 * the consequence of losing it is a few tokens of slight over-budget, not a
 * correctness bug.
 */
import type { KvPort } from '@/ports/kv'

export interface BudgetLimits {
  readonly requestsPerMinute: number
  readonly tokensPerMinute: number
  readonly requestsPerDay: number
  readonly tokensPerDay: number
}

export const DEFAULT_BUDGET: BudgetLimits = {
  requestsPerMinute: 20,
  tokensPerMinute: 6_000,
  requestsPerDay: 600,
  tokensPerDay: 150_000,
}

export interface BudgetCheckResult {
  readonly allowed: boolean
  readonly reason: string | null
}

const KEY_REQ_MINUTE = 'lang_budget:req:minute'
const KEY_REQ_DAY = 'lang_budget:req:day'
const KEY_TOKENS_MINUTE = 'lang_budget:tokens:minute'
const KEY_TOKENS_DAY = 'lang_budget:tokens:day'

async function readTotal(kv: KvPort, key: string): Promise<number> {
  const raw = await kv.get(key)
  return raw === null ? 0 : Number(raw)
}

/** Call before attempting a call. Token totals are checked against what has
 * already been *recorded* (via recordTokens after a prior call) — this cannot
 * know a not-yet-made call's own token cost in advance. */
export async function checkBudget(kv: KvPort, limits: BudgetLimits = DEFAULT_BUDGET): Promise<BudgetCheckResult> {
  const minuteTokens = await readTotal(kv, KEY_TOKENS_MINUTE)
  if (minuteTokens >= limits.tokensPerMinute) {
    return { allowed: false, reason: 'tokens_per_minute_exceeded' }
  }
  const dayTokens = await readTotal(kv, KEY_TOKENS_DAY)
  if (dayTokens >= limits.tokensPerDay) {
    return { allowed: false, reason: 'tokens_per_day_exceeded' }
  }

  const minuteReq = await kv.incrWithTtl(KEY_REQ_MINUTE, 60)
  if (minuteReq > limits.requestsPerMinute) {
    return { allowed: false, reason: 'requests_per_minute_exceeded' }
  }
  const dayReq = await kv.incrWithTtl(KEY_REQ_DAY, 86_400)
  if (dayReq > limits.requestsPerDay) {
    return { allowed: false, reason: 'requests_per_day_exceeded' }
  }
  return { allowed: true, reason: null }
}

/** Call after a real Groq call completes, with its actual token usage. */
export async function recordTokens(kv: KvPort, tokens: number): Promise<void> {
  const minuteTotal = await readTotal(kv, KEY_TOKENS_MINUTE)
  await kv.set(KEY_TOKENS_MINUTE, String(minuteTotal + tokens), 60)
  const dayTotal = await readTotal(kv, KEY_TOKENS_DAY)
  await kv.set(KEY_TOKENS_DAY, String(dayTotal + tokens), 86_400)
}
