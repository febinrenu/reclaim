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
import type { Capabilities } from './capabilities'
import type { Env } from './env'

import { detectCapabilities } from './capabilities'
import { systemClock } from '@/adapters/clock/system'
import { createJsonLogger } from '@/adapters/logger/json-logger'
import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createNodePgExecutor } from '@/adapters/db/node-pg'
import { createPostgresKv } from '@/adapters/kv/postgres'
import { createMemoryKv } from '@/adapters/kv/memory'
import { createUpstashKv } from '@/adapters/kv/upstash'

export interface Deps {
  readonly env: Env
  readonly capabilities: Capabilities
  readonly clock: Clock
  readonly logger: Logger
  readonly sql: Transactional
  readonly kv: KvPort
}

export type DepsOverrides = Partial<Deps>

async function createSql(env: Env, capabilities: Capabilities): Promise<Transactional> {
  const driver = capabilities.byPort('sql').adapter
  if (driver === 'node-pg') return createNodePgExecutor(env.DATABASE_URL!)
  return createPgliteExecutor(env.PGLITE_DATA_DIR)
}

function createKv(env: Env, capabilities: Capabilities, sql: Transactional): KvPort {
  const driver = capabilities.byPort('kv').adapter
  if (driver === 'memory') return createMemoryKv()
  if (driver === 'upstash') return createUpstashKv(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!)
  return createPostgresKv(sql)
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

  return { env, capabilities, clock, logger, sql, kv }
}
