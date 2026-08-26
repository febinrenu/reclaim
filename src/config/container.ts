/**
 * The dependency-injection root. The ONE place adapters are chosen.
 *
 * Three properties matter here, and all are load-bearing:
 *
 *  1. This function never reads process.env. It takes an already-parsed Env. Only
 *     src/server/di.ts calls loadEnv(). That is what lets a test construct a fully
 *     wired container with pinned adapters and zero environment dependence, which
 *     in turn is why CI needs no secrets.
 *
 *  2. Every override is accepted. buildContainer(env, { sql: fakeSql }) replaces
 *     exactly one dependency and leaves the rest resolved normally.
 *
 *  3. It is async from D2 on, because opening the database is: PGlite's `create()`
 *     is asynchronous. Anything that awaits deps now awaits a container, not just a
 *     clock and a logger.
 *
 * ESLint boundary rule 4 forbids every other module from importing src/adapters, so
 * this file is structurally the only wiring point rather than merely the intended one.
 */
import type { Clock } from '@/domain/clock'
import type { Logger } from '@/ports/logger'
import type { Transactional } from '@/ports/sql'
import type { KvPort } from '@/ports/kv'
import type { PaymentsPort } from '@/ports/executor'
import type { LlmPort } from '@/ports/llm'
import type { LanguageService } from '@/language/language-service'
import type { Capabilities } from './capabilities'
import type { Env } from './env'

import { detectCapabilities, DEV_WEBHOOK_SECRET } from './capabilities'
import { systemClock } from '@/adapters/clock/system'
import { createJsonLogger } from '@/adapters/logger/json-logger'
import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createNodePgExecutor } from '@/adapters/db/node-pg'
import { createPostgresKv } from '@/adapters/kv/postgres'
import { createMemoryKv } from '@/adapters/kv/memory'
import { createUpstashKv } from '@/adapters/kv/upstash'
import { createPaymentsSimulator } from '@/adapters/payments/simulator'
import { createRazorpayPayments } from '@/adapters/payments/razorpay'
import { createGroqLlm } from '@/adapters/llm/groq'
import { createLanguageCachePort } from '@/repositories/language-cache.repo'
import { makeLanguageService, LIVE_POLICY } from '@/language/language-service'

export interface Deps {
  readonly env: Env
  readonly capabilities: Capabilities
  readonly clock: Clock
  readonly logger: Logger
  readonly sql: Transactional
  readonly kv: KvPort
  readonly payments: PaymentsPort
  /** Never contains the API key secret — a different value, see BUILD_PLAN.md §10.4. */
  readonly webhookSecret: string
  readonly llm: LlmPort | null
  readonly language: LanguageService
}

export type DepsOverrides = Partial<Deps>

async function createSql(env: Env, capabilities: Capabilities): Promise<Transactional> {
  const driver = capabilities.byPort('sql').adapter
  if (driver === 'node-pg') return createNodePgExecutor(env.DATABASE_URL!, env.DB_POOL_MAX)
  return createPgliteExecutor(env.PGLITE_DATA_DIR)
}

function createKv(env: Env, capabilities: Capabilities, sql: Transactional): KvPort {
  const driver = capabilities.byPort('kv').adapter
  if (driver === 'memory') return createMemoryKv()
  if (driver === 'upstash') return createUpstashKv(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!)
  return createPostgresKv(sql)
}

function createPayments(env: Env, capabilities: Capabilities, webhookSecret: string): PaymentsPort {
  const driver = capabilities.byPort('payments').adapter
  if (driver === 'razorpay') return createRazorpayPayments(env.RAZORPAY_KEY_ID!, env.RAZORPAY_KEY_SECRET!)
  return createPaymentsSimulator(webhookSecret)
}

function createLlm(env: Env, capabilities: Capabilities): LlmPort | null {
  const driver = capabilities.byPort('llm').adapter
  if (driver !== 'groq') return null
  return createGroqLlm({ apiKey: env.GROQ_API_KEY!, model: env.GROQ_MODEL })
}

export async function buildContainer(env: Env, overrides: DepsOverrides = {}): Promise<Deps> {
  const capabilities = overrides.capabilities ?? detectCapabilities(env)

  const logger =
    overrides.logger ??
    createJsonLogger({
      level: env.LOG_LEVEL,
      // A terminal wants readable lines. Anything else wants parseable JSON.
      pretty: env.NODE_ENV === 'development',
    })

  const clock = overrides.clock ?? systemClock
  const sql = overrides.sql ?? (await createSql(env, capabilities))
  const kv = overrides.kv ?? createKv(env, capabilities, sql)
  const webhookSecret = overrides.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET
  const payments = overrides.payments ?? createPayments(env, capabilities, webhookSecret)
  const llm = overrides.llm !== undefined ? overrides.llm : createLlm(env, capabilities)
  // LIVE_POLICY (call every time, no per-run ceiling) because this container is
  // a process-wide singleton (src/server/di.ts) backing continuous webhook
  // processing, not a single batch — BUILD_PLAN.md §5.8 point 1's 8%-sampled,
  // 24-call ceiling is a *per-batch-run* policy that only makes sense for a
  // language service built fresh for one batch. D9's batch runner constructs
  // its own `makeLanguageService` instance with `DEFAULT_BATCH_POLICY` for
  // exactly that reason — reusing this singleton's ceiling counter across the
  // server's entire lifetime would exhaust it after 24 nudges ever, not 24 per run.
  const language =
    overrides.language ??
    makeLanguageService({
      llm,
      cache: createLanguageCachePort(sql),
      kv,
      clock,
      policy: LIVE_POLICY,
    })

  return { env, capabilities, clock, logger, sql, kv, payments, webhookSecret, llm, language }
}
