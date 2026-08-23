/**
 * The standalone worker (BUILD_PLAN.md §5.7 trigger 2): `npm run worker`. Used for
 * the multi-worker concurrency demo and the crash story — `RECLAIM_CRASH_AFTER`
 * plus `taskkill /F /PID` plus a restart is only a reproducible beat if the worker
 * is a separate process a demo can actually kill.
 *
 * Builds its own container rather than importing anything from src/server/di.ts:
 * this script is not a Next.js server, so there is no instrumentation.ts hook to
 * piggyback on, and it must not share the embedded worker's globalThis-cached
 * singleton (a real second process needs a real second container).
 */
import { loadEnv } from '../src/config/env'
import { buildContainer } from '../src/config/container'
import { runMigrations } from '../src/db/migrate'
import { drainOnce } from '../src/app/worker/drain'

const POLL_MS = 250

async function main(): Promise<void> {
  const env = loadEnv()
  const deps = await buildContainer(env)
  await runMigrations(deps.sql)

  deps.logger.info(
    { event: 'worker_started', driver: deps.sql.driver, pid: process.pid },
    `standalone worker started (pid ${process.pid})`,
  )

  let running = true
  process.on('SIGINT', () => {
    running = false
  })
  process.on('SIGTERM', () => {
    running = false
  })

  while (running) {
    const result = await drainOnce(deps, { maxJobs: 25, budgetMs: 2000, workerId: `standalone-${process.pid}` })
    if (result.claimed > 0) {
      deps.logger.info({ event: 'drain_tick', ...result }, 'drained')
    }
    if (result.remaining === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  await deps.sql.close()
  await deps.kv.close()
}

main().catch((err: unknown) => {
  process.stderr.write(`worker crashed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
