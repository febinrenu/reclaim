/**
 * The migration runner.
 *
 * Deliberately not under src/adapters/: it selects no adapter and holds no concrete
 * driver, it operates entirely over the `Transactional` port. Boundary rule 4
 * (eslint.config.mjs) restricts *adapter* imports to src/config/container.ts alone;
 * this module is adapter-agnostic and callable from src/server/boot.ts and from tests.
 *
 * Idempotent by construction: every migration file is applied inside one transaction
 * together with its own row in `schema_migrations`, so "already applied" and "already
 * committed" can never disagree. Deleting `.data/` empties `schema_migrations` along
 * with everything else, so the very next boot reapplies every file from scratch — that
 * is what makes "delete .data/ and it rebuilds cleanly" true by construction rather
 * than by extra code.
 *
 * The advisory lock only runs for `node-pg`. PGlite is a single embedded connection
 * with no concurrent booter to race against, so a lock there would protect against
 * nothing; see BUILD_PLAN.md §5.1 A2 and the KV port's analogous reasoning in
 * src/ports/kv.ts about not building infrastructure a target does not need.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SqlExecutor, Transactional } from '@/ports/sql'

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations')

/** Arbitrary fixed key for `pg_advisory_xact_lock`. Only meaningful for node-pg. */
const ADVISORY_LOCK_KEY = 847_710_02

export interface MigrationResult {
  readonly applied: readonly string[]
  readonly alreadyCurrent: boolean
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): readonly string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

export async function runMigrations(
  sql: Transactional,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = listMigrationFiles(dir)

  return sql.transaction(async (tx) => {
    if (sql.driver === 'node-pg') {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY])
    }

    await ensureMigrationsTable(tx)

    const { rows } = await tx.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    )
    const already = new Set(rows.map((r) => r.filename))

    const applied: string[] = []
    for (const file of files) {
      if (already.has(file)) continue
      const text = readFileSync(join(dir, file), 'utf8')
      await tx.query(text)
      await tx.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
      applied.push(file)
    }

    return { applied, alreadyCurrent: applied.length === 0 }
  })
}

async function ensureMigrationsTable(tx: SqlExecutor): Promise<void> {
  await tx.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
}
