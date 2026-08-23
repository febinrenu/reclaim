/**
 * The language cache table (BUILD_PLAN.md §5.8 point 2). This repository is
 * never imported from `src/language/` directly — see that directory's
 * `CachePort` in types.ts for why — only from whatever wires a language service
 * together (D9's batch runner, the worker).
 */
import type { SqlExecutor } from '@/ports/sql'
import type { CacheEntry } from '@/language/types'

interface CacheDbRow {
  cache_key: string
  message: string
  tone: string
  confidence: string | number
  template_version: string
}

function toEntry(r: CacheDbRow): CacheEntry {
  return {
    message: r.message,
    tone: r.tone as CacheEntry['tone'],
    confidence: Number(r.confidence),
    templateVersion: r.template_version,
  }
}

export async function getCached(sql: SqlExecutor, cacheKey: string): Promise<CacheEntry | null> {
  const { rows } = await sql.query<CacheDbRow>('SELECT * FROM language_cache WHERE cache_key = $1', [cacheKey])
  return rows[0] === undefined ? null : toEntry(rows[0])
}

export async function setCached(sql: SqlExecutor, cacheKey: string, entry: CacheEntry): Promise<void> {
  await sql.query(
    `INSERT INTO language_cache (cache_key, message, tone, confidence, template_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cache_key) DO UPDATE
       SET message = EXCLUDED.message, tone = EXCLUDED.tone,
           confidence = EXCLUDED.confidence, template_version = EXCLUDED.template_version`,
    [cacheKey, entry.message, entry.tone, entry.confidence, entry.templateVersion],
  )
}

/** Adapts the repository above into `src/language/types.ts`'s narrow `CachePort`. */
export function createLanguageCachePort(sql: SqlExecutor): import('@/language/types').CachePort {
  return {
    get: (key) => getCached(sql, key),
    set: (key, entry) => setCached(sql, key, entry),
  }
}
