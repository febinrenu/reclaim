/**
 * The Upstash Redis adapter, over Upstash's REST API (no TCP client needed, which
 * matters for serverless/edge runtimes and keeps this adapter dependency-free).
 * See src/ports/kv.ts for why this is never the idempotency authority — a wiped or
 * unreachable Upstash database must never be able to corrupt a decision, only skip
 * an optimisation.
 */
import type { KvPort } from '@/ports/kv'

type UpstashReply = { readonly result: unknown } | { readonly error: string }

export function createUpstashKv(restUrl: string, restToken: string): KvPort {
  const base = restUrl.replace(/\/+$/, '')

  async function call(command: readonly (string | number)[]): Promise<unknown> {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    })
    const body = (await res.json()) as UpstashReply
    if (!res.ok || 'error' in body) {
      const message = 'error' in body ? body.error : `HTTP ${res.status}`
      throw new Error(`Upstash command failed: ${message}`)
    }
    return body.result
  }

  return {
    name: 'upstash',
    describe: 'upstash',

    async setIfAbsent(key, value, ttlSec) {
      const result = await call(['SET', key, value, 'EX', ttlSec, 'NX'])
      return result === 'OK'
    },

    async get(key) {
      const result = await call(['GET', key])
      return typeof result === 'string' ? result : null
    },

    async set(key, value, ttlSec) {
      await call(['SET', key, value, 'EX', ttlSec])
    },

    async del(key) {
      await call(['DEL', key])
    },

    async incrWithTtl(key, ttlSec) {
      // Matches the Postgres adapter's contract: TTL is set only on creation, never
      // reset on every increment. A Lua script keeps INCR+conditional-EXPIRE atomic,
      // the REST equivalent of the single-statement guarantee src/ports/kv.ts
      // requires (no INCR-then-EXPIRE as two separate round trips).
      const script =
        "local v = redis.call('INCR', KEYS[1]) " +
        "if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end " +
        'return v'
      const result = await call(['EVAL', script, 1, key, ttlSec])
      return Number(result)
    },

    // The REST transport is stateless per request; there is no connection to close.
    async close() {},
  }
}
