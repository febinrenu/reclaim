/**
 * A real gap a strict outside review named directly: `/api/batches` and
 * `/api/simulate` are unauthenticated, public, and each POST kicks off real
 * work (a full batch through the decision pipeline, real Groq calls once a
 * batch's language spend isn't cache-hit, real database writes) with nothing
 * stopping repeated abuse. Reuses the same `KvPort.incrWithTtl` the shock
 * detector already relies on (`src/app/worker/shock-detector.ts`) for the
 * identical reason: a single atomic increment-with-TTL, never INCR-then-EXPIRE
 * as two calls, so a crash between them can't leave a key permanently
 * un-expired (src/ports/kv.ts).
 *
 * Per-IP, not global: a demo instance shared by many reviewers at once must
 * not have one person's testing lock everyone else out. `x-forwarded-for` is
 * the standard header a tunnel or reverse proxy sets for the real client IP;
 * falls back to a shared bucket only when genuinely absent (direct localhost
 * access, most commonly), which is strictly more permissive, not less safe.
 */
import type { KvPort } from '@/ports/kv'

export interface RateLimitResult {
  readonly allowed: boolean
  readonly remaining: number
  readonly retryAfterSeconds: number
}

export async function checkRateLimit(
  kv: KvPort,
  keyPrefix: string,
  clientKey: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const count = await kv.incrWithTtl(`ratelimit:${keyPrefix}:${clientKey}`, windowSeconds)
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: windowSeconds,
  }
}

/** `x-forwarded-for` may carry a comma-separated chain (client, proxy1, proxy2,
 * ...) — the first entry is the original client. Falls back to a fixed bucket
 * key when the header is absent, which only ever makes the limit more shared
 * (more permissive to any one caller), never less safe. */
export function clientKeyFrom(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  return first !== undefined && first.length > 0 ? first : 'unknown'
}
