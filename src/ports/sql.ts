/**
 * The database port.
 *
 * Deliberately a thin SQL executor rather than a query builder or an ORM surface.
 * The reason is BUILD_PLAN.md commitment A2: PGlite is real Postgres compiled to
 * WebAssembly, so the same SQL text runs against the embedded local database, a
 * Docker Postgres, and Supabase. One repository layer, three targets, no dialect
 * translation and no second code path to keep in sync.
 *
 * Repositories accept `SqlExecutor`, never `Transactional`. That is what lets the
 * same repository call work standalone or inside a transaction, which in turn is
 * what makes the five-write settle step atomic.
 */
export interface SqlExecutor {
  query<R extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'

export interface Transactional extends SqlExecutor {
  transaction<T>(
    fn: (tx: SqlExecutor) => Promise<T>,
    opts?: { isolation?: IsolationLevel },
  ): Promise<T>

  readonly driver: 'pglite' | 'node-pg'
  /** Human-readable target, for the boot banner. Never contains credentials. */
  readonly describe: string
  close(): Promise<void>
}
