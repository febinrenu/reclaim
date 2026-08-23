/**
 * The cache key (BUILD_PLAN.md §5.8 point 2): a hash of scenario, action, locale,
 * tone, template version, and the *bucketed* facts from redact-facts.ts — never
 * the raw transaction. This is what collapses a few hundred events into a few
 * dozen distinct keys, and it is also exactly why a cached message must never
 * contain a customer-specific value (see amount-slot.ts): many different
 * transactions legitimately share one key.
 */
import { createHash } from 'node:crypto'
import type { Jsonish } from '@/domain/json'
import type { CopyRequest } from './types'

export const TEMPLATE_VERSION = 'v1'

export function cacheKeyFor(req: Pick<CopyRequest, 'scenario' | 'action' | 'locale' | 'tone' | 'facts'>): string {
  const canonical = JSON.stringify({
    scenario: req.scenario,
    action: req.action,
    locale: req.locale,
    tone: req.tone,
    templateVersion: TEMPLATE_VERSION,
    facts: sortKeysDeep(req.facts),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** JSON.stringify is sensitive to key insertion order; sorting first makes the
 * hash depend only on content, not on which order redactFacts happened to build
 * its object in. */
function sortKeysDeep(value: Jsonish): Jsonish {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const record = value as { readonly [key: string]: Jsonish }
  const sorted: Record<string, Jsonish> = {}
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeysDeep(record[key] as Jsonish)
  }
  return sorted
}
