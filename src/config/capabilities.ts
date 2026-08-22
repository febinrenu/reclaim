/**
 * Adapter selection.
 *
 * Every probe is presence-only. Nothing here opens a socket, so boot cannot hang
 * or fail because a remote service is down. A credential either exists or it does
 * not, and either way the app starts.
 *
 * The `reason` on each row is written for a human reading the boot banner, and it
 * always says how to upgrade. That banner is what stops a reviewer from being
 * confused about which parts are simulated, so it is a product surface rather than
 * a debug aid. See BUILD_PLAN.md 5.1 commitment A5.
 */
import type { Env } from './env'

export type PortName = 'sql' | 'kv' | 'llm' | 'payments' | 'executor' | 'webhookSecret'

export interface Capability {
  readonly port: PortName
  readonly adapter: string
  /** True when backed by a real external service rather than a local stand-in. */
  readonly live: boolean
  /** Where the data actually goes. Never contains a credential. */
  readonly target: string
  /** How to upgrade this port, or what makes it live already. */
  readonly reason: string
}

export interface Capabilities {
  readonly rows: readonly Capability[]
  /** True when every port is backed by a real service. */
  readonly allLive: boolean
  /** True when no external credential is configured at all. */
  readonly fullyLocal: boolean
  byPort(port: PortName): Capability
}

/** The webhook secret used when none is configured. Never valid for real traffic. */
export const DEV_WEBHOOK_SECRET = 'reclaim-dev-simulator-secret-not-for-production'

export function detectCapabilities(env: Env): Capabilities {
  const rows: Capability[] = []

  // ── Database ──────────────────────────────────────────────────────────────
  const wantsPg = env.DB_DRIVER === 'postgres' || (env.DB_DRIVER === undefined && env.DATABASE_URL !== undefined)
  if (wantsPg && env.DATABASE_URL === undefined) {
    throw new Error('DB_DRIVER=postgres requires DATABASE_URL to be set.')
  }
  rows.push(
    wantsPg
      ? {
          port: 'sql',
          adapter: 'node-pg',
          live: true,
          target: redactPgUrl(env.DATABASE_URL!),
          reason: 'DATABASE_URL is set',
        }
      : {
          port: 'sql',
          adapter: 'pglite',
          live: false,
          target: env.PGLITE_DATA_DIR,
          reason: 'embedded Postgres, no Docker needed. Set DATABASE_URL for Postgres or Supabase',
        },
  )

  // ── Lock and counter store ────────────────────────────────────────────────
  const hasUpstash =
    env.UPSTASH_REDIS_REST_URL !== undefined && env.UPSTASH_REDIS_REST_TOKEN !== undefined
  const kvDriver = env.KV_DRIVER ?? (hasUpstash ? 'upstash' : 'postgres')
  if (kvDriver === 'upstash' && !hasUpstash) {
    throw new Error('KV_DRIVER=upstash requires both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.')
  }
  rows.push({
    port: 'kv',
    adapter: kvDriver,
    live: kvDriver === 'upstash',
    target:
      kvDriver === 'upstash'
        ? hostOf(env.UPSTASH_REDIS_REST_URL!)
        : kvDriver === 'postgres'
          ? 'kv table'
          : 'in process',
    reason:
      kvDriver === 'upstash'
        ? 'Upstash credentials present'
        : 'never the idempotency authority, so a local store is fully correct here',
  })

  // ── Language ──────────────────────────────────────────────────────────────
  const llmDriver = env.LLM_DRIVER ?? (env.GROQ_API_KEY !== undefined ? 'groq' : 'template')
  if (llmDriver === 'groq' && env.GROQ_API_KEY === undefined) {
    throw new Error('LLM_DRIVER=groq requires GROQ_API_KEY.')
  }
  rows.push({
    port: 'llm',
    adapter: llmDriver,
    live: llmDriver === 'groq',
    target: llmDriver === 'groq' ? env.GROQ_MODEL : 'deterministic templates',
    reason:
      llmDriver === 'groq'
        ? 'GROQ_API_KEY is set. Budget guard sits below the free-tier limits'
        : 'hand written variants including Hinglish. Set GROQ_API_KEY for Groq',
  })

  // ── Payments ──────────────────────────────────────────────────────────────
  const hasRzp = env.RAZORPAY_KEY_ID !== undefined && env.RAZORPAY_KEY_SECRET !== undefined
  const payDriver = env.PAYMENTS_DRIVER ?? (hasRzp ? 'razorpay' : 'simulator')
  if (payDriver === 'razorpay' && !hasRzp) {
    throw new Error('PAYMENTS_DRIVER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.')
  }
  rows.push({
    port: 'payments',
    adapter: payDriver,
    live: payDriver === 'razorpay',
    target: payDriver === 'razorpay' ? 'Razorpay test mode' : 'self signed webhooks',
    reason:
      payDriver === 'razorpay'
        ? 'test-mode keys present'
        : 'signs its own events through the identical HMAC path',
  })

  // ── Webhook secret ────────────────────────────────────────────────────────
  const hasSecret = env.RAZORPAY_WEBHOOK_SECRET !== undefined
  rows.push({
    port: 'webhookSecret',
    adapter: hasSecret ? 'configured' : 'development default',
    live: hasSecret,
    target: hasSecret ? 'from environment' : 'built in',
    reason: hasSecret
      ? 'RAZORPAY_WEBHOOK_SECRET is set'
      : 'a shared development value. This is NOT the API key secret; they are different values',
  })

  // ── Executor ──────────────────────────────────────────────────────────────
  // Live execution needs real credentials AND an explicit choice. Defaulting to
  // dry_run means an accidental batch can never spend a real Payment Link, of
  // which test mode allows only 30 per business.
  const canGoLive = payDriver === 'razorpay' && env.EXECUTOR_MODE !== 'dry_run'
  rows.push({
    port: 'executor',
    adapter: canGoLive ? 'live capable' : 'dry_run',
    live: canGoLive,
    target: canGoLive ? `live budget ${env.EXECUTOR_LIVE_BUDGET}` : 'records intent only',
    reason: canGoLive
      ? 'batch replays still force dry_run regardless of this setting'
      : 'records exactly what would have been sent, and touches no network',
  })

  const allLive = rows.every((r) => r.live)
  const fullyLocal = rows.every((r) => !r.live)

  return {
    rows,
    allLive,
    fullyLocal,
    byPort(port) {
      const row = rows.find((r) => r.port === port)
      if (row === undefined) throw new Error(`no capability recorded for port ${port}`)
      return row
    },
  }
}

/** Strip credentials from a Postgres URL so it is safe to print and to log. */
function redactPgUrl(url: string): string {
  try {
    const u = new URL(url)
    const db = u.pathname.replace(/^\//, '') || 'postgres'
    return `${u.hostname}:${u.port || '5432'}/${db}`
  } catch {
    return 'postgres (unparseable url)'
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'upstash'
  }
}
