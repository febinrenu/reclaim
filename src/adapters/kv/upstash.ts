/**
 * The Upstash Redis adapter. Not yet implemented.
 *
 * `KV_DRIVER=upstash` becomes reachable the moment both `UPSTASH_REDIS_REST_URL` and
 * `UPSTASH_REDIS_REST_TOKEN` are set (src/config/capabilities.ts), but no credentials
 * exist as of D2 — see BUILD_PLAN.md §10.3, scheduled for the credential runbook. This
 * throws rather than silently falling back to a different adapter, for the same reason
 * `detectCapabilities` throws on every other driver/credential mismatch: a KV port that
 * pretends to be Upstash while quietly running as something else is exactly the failure
 * mode docs/INCIDENTS.md describes — a guard, or here a selection, that fails open.
 */
import type { KvPort } from '@/ports/kv'

export function createUpstashKv(_restUrl: string, _restToken: string): KvPort {
  throw new Error(
    'KV_DRIVER=upstash is selected but src/adapters/kv/upstash.ts has no implementation yet. ' +
      'It lands with the credential runbook (BUILD_PLAN.md §10.3). Until then, unset ' +
      'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, or set KV_DRIVER=memory, to use ' +
      'the Postgres-backed default instead.',
  )
}
