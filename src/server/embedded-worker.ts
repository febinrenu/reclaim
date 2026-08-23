/**
 * The embedded worker (BUILD_PLAN.md §5.7 trigger 1): started from boot.ts,
 * polling at 250ms with adaptive backoff. This is what makes `npm run dev` the
 * only command a stranger needs — no separate worker process to remember to run.
 *
 * Cached on globalThis for the same reason src/server/di.ts caches the container
 * there: Turbopack's hot reload re-evaluates modules, and a module-level guard
 * would start a second poller on every edit.
 */
import type { Deps } from '@/config/container'
import { drainOnce } from '@/app/worker/drain'

const KEY = '__reclaim_embedded_worker_started__'
type GlobalWithFlag = typeof globalThis & { [KEY]?: boolean }

const POLL_MS_ACTIVE = 250
const POLL_MS_IDLE_MAX = 5000
const BACKOFF_FACTOR = 1.5

export function startEmbeddedWorker(deps: Deps): void {
  const g = globalThis as GlobalWithFlag
  if (g[KEY] === true) return
  g[KEY] = true

  let delayMs = POLL_MS_ACTIVE

  async function tick(): Promise<void> {
    try {
      const result = await drainOnce(deps, { maxJobs: 25, budgetMs: 2000, workerId: 'embedded' })
      delayMs = result.done + result.failed + result.remaining > 0
        ? POLL_MS_ACTIVE
        : Math.min(POLL_MS_IDLE_MAX, delayMs * BACKOFF_FACTOR)
    } catch (err) {
      deps.logger.error(
        { event: 'embedded_worker_tick_failed', error: err instanceof Error ? err.message : String(err) },
        'embedded worker tick failed',
      )
      delayMs = POLL_MS_IDLE_MAX
    }
    setTimeout(() => void tick(), delayMs)
  }

  void tick()
}
