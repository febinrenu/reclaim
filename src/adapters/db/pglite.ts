/**
 * The embedded database adapter. Real Postgres compiled to WebAssembly, running
 * in-process with no Docker — see BUILD_PLAN.md §4 and §5.1 commitment A2.
 *
 * Two PGlite API shapes matter here, mirrored deliberately against `node-pg`'s own
 * duality so the port stays a single thin wrapper rather than growing a dialect
 * branch per driver:
 *
 *   - `db.query(sql, params)` runs exactly one parameterised statement.
 *   - `db.exec(sql)` runs one or more statements with no parameters (the simple
 *     query protocol shape), which is what a multi-statement migration file needs.
 *
 * `query()` below picks between them based on whether params were passed, which is
 * exactly the same rule `src/adapters/db/node-pg.ts` follows for the real driver.
 */
import { mkdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import type { IsolationLevel, SqlExecutor, Transactional } from '@/ports/sql'

interface RawResult<R> {
  readonly rows: R[]
  readonly affectedRows?: number
}

export async function createPgliteExecutor(dataDir: string): Promise<Transactional> {
  // PGlite creates its own leaf directory but not missing parents, so deleting the
  // whole `.data/` tree (the documented way to force a clean rebuild — see
  // BUILD_PLAN.md §7, D2's exit test) failed with ENOENT on the very first boot after.
  // Found by running that exit test for real rather than assuming it would pass.
  mkdirSync(dataDir, { recursive: true })
  const db = await PGlite.create(dataDir)

  async function run<R extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }> {
    if (params !== undefined && params.length > 0) {
      const res = (await db.query(sql, params as unknown[])) as RawResult<R>
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length }
    }
    const results = (await db.exec(sql)) as unknown as RawResult<R>[]
    const last = results[results.length - 1]
    return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 }
  }

  function isolationClause(level: IsolationLevel | undefined): string {
    return level === undefined ? '' : ` ISOLATION LEVEL ${level.toUpperCase()}`
  }

  let closed = false

  return {
    driver: 'pglite',
    describe: `pglite:${dataDir}`,

    query: run,

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>, opts?: { isolation?: IsolationLevel }) {
      // PGlite is a single embedded connection, so there is no client to check out:
      // BEGIN/COMMIT/ROLLBACK run against the same instance `run` already closes over,
      // which is exactly what makes reusing `run` as the transaction's executor safe.
      await run(`BEGIN${isolationClause(opts?.isolation)}`)
      try {
        const result = await fn({ query: run })
        await run('COMMIT')
        return result
      } catch (err) {
        await run('ROLLBACK')
        throw err
      }
    },

    async close() {
      if (closed) return
      closed = true
      await db.close()
    },
  }
}
