/**
 * Process-wide singleton container.
 *
 * Cached on globalThis rather than in a module-level variable because Turbopack's
 * hot reload re-evaluates modules, and a module-level cache would therefore build a
 * second container on every edit. With an embedded database that means two processes
 * competing for one data directory, which fails in confusing ways.
 */
import { loadEnv } from '@/config/env'
import { buildContainer, type Deps } from '@/config/container'

const KEY = '__reclaim_deps__'

type GlobalWithDeps = typeof globalThis & { [KEY]?: Deps }

export function getDeps(): Deps {
  const g = globalThis as GlobalWithDeps
  const existing = g[KEY]
  if (existing !== undefined) return existing

  const deps = buildContainer(loadEnv())
  g[KEY] = deps
  return deps
}

/** Test and script escape hatch, so a fresh container can be forced. */
export function resetDeps(): void {
  delete (globalThis as GlobalWithDeps)[KEY]
}
