/**
 * The Postgres-backed KV adapter, the zero-credential default for the lock and
 * counter port (BUILD_PLAN.md §4). Backed by the `kv` table from
 * db/migrations/0002_ingest_queue.sql.
 *
 * Every method treats an expired row as absent without a separate sweep, which is
 * what lets a wiped or never-cleaned table stay correct indefinitely: nothing here
 * is ever the idempotency authority (src/ports/kv.ts), so leaving expired rows in
 * place until they are next touched costs nothing but a little disk.
 */
import type { SqlExecutor } from '@/ports/sql'
import type { KvPort } from '@/ports/kv'

export function createPostgresKv(sql: SqlExecutor): KvPort {
  return {
    name: 'postgres',
    describe: 'kv table',

    async setIfAbsent(key, value, ttlSec) {
      // ON CONFLICT ... WHERE only fires the update (and returns a row) when the
      // existing row is expired. If it is live and unexpired, the WHERE is false, the
      // insert-on-conflict is skipped for that row, and RETURNING yields nothing —
      // which is exactly "this caller did not win the key."
      const { rows } = await sql.query<{ won: boolean }>(
        `INSERT INTO kv (key, value, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
           WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= now()
         RETURNING true AS won`,
        [key, value, ttlSec],
      )
      return rows.length > 0
    },

    async get(key) {
      const { rows } = await sql.query<{ value: string }>(
        `SELECT value FROM kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [key],
      )
      return rows[0]?.value ?? null
    },

    async set(key, value, ttlSec) {
      await sql.query(
        `INSERT INTO kv (key, value, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, value, ttlSec],
      )
    },

    async del(key) {
      await sql.query('DELETE FROM kv WHERE key = $1', [key])
    },

    async incrWithTtl(key, ttlSec) {
      // The TTL is set only when the row is created — a fresh insert, or an existing
      // row found already expired (treated as fresh). A live, unexpired row keeps its
      // original expiry on every increment. See src/ports/kv.ts for why this must not
      // be INCR-then-EXPIRE as two separate calls.
      const { rows } = await sql.query<{ value: string }>(
        `INSERT INTO kv (key, value, expires_at)
         VALUES ($1, '1', now() + make_interval(secs => $2))
         ON CONFLICT (key) DO UPDATE
           SET value = CASE
                 WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN '1'
                 ELSE (kv.value::bigint + 1)::text
               END,
               expires_at = CASE
                 WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now()
                   THEN now() + make_interval(secs => $2)
                 ELSE kv.expires_at
               END
         RETURNING value`,
        [key, ttlSec],
      )
      return Number(rows[0]?.value ?? 0)
    },

    // The KV adapter shares the sql executor's lifecycle rather than owning its own
    // connection, so there is nothing for it to close.
    async close() {},
  }
}
