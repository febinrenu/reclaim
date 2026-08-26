/**
 * The real-Postgres adapter: Docker Postgres locally, Supabase in production, over
 * `pg` directly rather than `@supabase/supabase-js` — see BUILD_PLAN.md §5.1
 * commitment A2. Supabase collapses to a connection string, so this one adapter
 * serves both targets.
 *
 * A transaction checks out a single dedicated client from the pool for its entire
 * duration and runs every statement — including `BEGIN`/`COMMIT`/`ROLLBACK` — on
 * that client. This is not a style choice: a session-scoped construct like
 * `pg_advisory_xact_lock` (src/db/migrate.ts) or a multi-statement `BEGIN ... COMMIT`
 * only makes sense when every statement in it lands on the same backend connection.
 * Routing transaction statements through the pool, which may hand different callers
 * different physical connections, would silently break both.
 */
import { Pool, type PoolClient } from 'pg'
import type { IsolationLevel, SqlExecutor, Transactional } from '@/ports/sql'

export function createNodePgExecutor(databaseUrl: string, poolMax = 20): Transactional {
  const pool = new Pool({ connectionString: databaseUrl, max: poolMax })

  async function run<R extends object>(
    client: Pool | PoolClient,
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }> {
    const res = await client.query<R>(sql, params === undefined ? undefined : (params as unknown[]))
    return { rows: res.rows, rowCount: res.rowCount ?? 0 }
  }

  function isolationClause(level: IsolationLevel | undefined): string {
    return level === undefined ? '' : ` ISOLATION LEVEL ${level.toUpperCase()}`
  }

  let closed = false

  return {
    driver: 'node-pg',
    describe: `node-pg:${redact(databaseUrl)}`,

    query: (sql, params) => run(pool, sql, params),

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>, opts?: { isolation?: IsolationLevel }) {
      const client = await pool.connect()
      try {
        await client.query(`BEGIN${isolationClause(opts?.isolation)}`)
        try {
          const result = await fn({ query: (sql, params) => run(client, sql, params) })
          await client.query('COMMIT')
          return result
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
      } finally {
        client.release()
      }
    },

    async close() {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}

/** Strip credentials before this ever reaches a log line or the boot banner. */
function redact(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl)
    const db = u.pathname.replace(/^\//, '') || 'postgres'
    return `${u.hostname}:${u.port || '5432'}/${db}`
  } catch {
    return 'postgres (unparseable url)'
  }
}
