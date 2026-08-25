/**
 * BUILD_PLAN.md §6.10's critical test, against real PGlite: "sets a TTL even
 * when the counter was created by a prior process" — checked here against the
 * actual Postgres-backed KV adapter, not just the in-memory one
 * (tests/unit/shock-detector.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createPostgresKv } from '@/adapters/kv/postgres'
import { runMigrations } from '@/db/migrate'
import { SHOCK_THRESHOLD } from '@/app/worker/shock-detector'
import type { Transactional } from '@/ports/sql'

describe('the TTL-crash bug, fixed architecturally (real Postgres half)', () => {
  let dir: string
  let sql: Transactional

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-shock-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('incrWithTtl always carries an expiry, never a NULL that would suppress a bank forever', async () => {
    const kv = createPostgresKv(sql)

    // "A prior process" crashing right after INCR, before EXPIRE, is exactly
    // what the spec's two-call version could not survive. incrWithTtl is one
    // INSERT ... ON CONFLICT DO UPDATE statement (src/adapters/kv/postgres.ts)
    // — atomic by construction, so there is no partial state to crash inside.
    for (let i = 0; i < SHOCK_THRESHOLD + 1; i++) {
      await kv.incrWithTtl('failrate:HDFC:GATEWAY_ERROR', 300)
    }
    const value = await kv.get('failrate:HDFC:GATEWAY_ERROR')
    expect(Number(value)).toBe(SHOCK_THRESHOLD + 1)

    // The row genuinely carries an expiry — not a NULL that would suppress
    // this bank forever. Read the raw row rather than trusting get()'s own
    // expiry-aware filtering, which is the thing under test here.
    const { rows } = await sql.query<{ expires_at: Date | null }>(
      `SELECT expires_at FROM kv WHERE key = $1`,
      ['failrate:HDFC:GATEWAY_ERROR'],
    )
    expect(rows[0]?.expires_at).not.toBeNull()
  })
})
