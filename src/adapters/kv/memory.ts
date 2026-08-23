/**
 * The in-memory KV adapter. Used when `KV_DRIVER=memory` is forced explicitly, and by
 * tests that want to pin a KV implementation without touching a database. Not a
 * distinct capability-detected default — the zero-credential default is the Postgres
 * table adapter (src/adapters/kv/postgres.ts), since it is durable and shared across
 * processes for free. See BUILD_PLAN.md §5.7.
 *
 * `Date.now()` is used directly here rather than an injected Clock: this file is an
 * adapter, not src/domain, and the purity rule that forbids the ambient clock applies
 * only there. See eslint.config.mjs boundary rule 1.
 */
import type { KvPort } from '@/ports/kv'

interface Entry {
  value: string
  expiresAtMs: number | null
}

export function createMemoryKv(): KvPort {
  const store = new Map<string, Entry>()

  function live(entry: Entry | undefined): entry is Entry {
    if (entry === undefined) return false
    return entry.expiresAtMs === null || entry.expiresAtMs > Date.now()
  }

  function expiryFor(ttlSec: number): number | null {
    return ttlSec > 0 ? Date.now() + ttlSec * 1000 : null
  }

  return {
    name: 'memory',
    describe: 'in process',

    async setIfAbsent(key, value, ttlSec) {
      if (live(store.get(key))) return false
      store.set(key, { value, expiresAtMs: expiryFor(ttlSec) })
      return true
    },

    async get(key) {
      const entry = store.get(key)
      return live(entry) ? entry.value : null
    },

    async set(key, value, ttlSec) {
      store.set(key, { value, expiresAtMs: expiryFor(ttlSec) })
    },

    async del(key) {
      store.delete(key)
    },

    async incrWithTtl(key, ttlSec) {
      const existing = store.get(key)
      if (!live(existing)) {
        store.set(key, { value: '1', expiresAtMs: expiryFor(ttlSec) })
        return 1
      }
      const next = Number(existing.value) + 1
      store.set(key, { value: String(next), expiresAtMs: existing.expiresAtMs })
      return next
    },

    async close() {
      store.clear()
    },
  }
}
