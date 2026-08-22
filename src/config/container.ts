/**
 * The dependency-injection root. The ONE place adapters are chosen.
 *
 * Two properties matter here, and both are load-bearing:
 *
 *  1. This function never reads process.env. It takes an already-parsed Env. Only
 *     src/server/di.ts calls loadEnv(). That is what lets a test construct a fully
 *     wired container with pinned adapters and zero environment dependence, which
 *     in turn is why CI needs no secrets.
 *
 *  2. Every override is accepted. buildContainer({ clock: fixedClock(...) }) replaces
 *     exactly one dependency and leaves the rest resolved normally.
 *
 * ESLint boundary rule 4 forbids every other module from importing src/adapters, so
 * this file is structurally the only wiring point rather than merely the intended one.
 */
import type { Clock } from '@/domain/clock'
import type { Logger } from '@/ports/logger'
import type { Capabilities } from './capabilities'
import type { Env } from './env'

import { detectCapabilities } from './capabilities'
import { systemClock } from '@/adapters/clock/system'
import { createJsonLogger } from '@/adapters/logger/json-logger'

export interface Deps {
  readonly env: Env
  readonly capabilities: Capabilities
  readonly clock: Clock
  readonly logger: Logger
}

export type DepsOverrides = Partial<Deps>

export function buildContainer(env: Env, overrides: DepsOverrides = {}): Deps {
  const capabilities = overrides.capabilities ?? detectCapabilities(env)

  const logger =
    overrides.logger ??
    createJsonLogger({
      level: env.LOG_LEVEL,
      // A terminal wants readable lines. Anything else wants parseable JSON.
      pretty: env.NODE_ENV === 'development',
    })

  return {
    env,
    capabilities,
    clock: overrides.clock ?? systemClock,
    logger,
  }
}
