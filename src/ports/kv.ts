/**
 * The key-value port, for locks, rolling counters, and rate limiting.
 *
 * A deliberate note on what this is NOT: it is never the idempotency authority.
 *
 * The spec used a Redis SETNX as the authority for exactly-once ingestion. That is
 * a correctness defect rather than a preference. A lock held in one datastore cannot
 * be atomic with a write to another. If the process dies after acquiring the lock
 * and before the write lands, the event is locked out for the full TTL and silently
 * dropped forever, with no record it ever arrived. A poison lock.
 *
 * So the authority is a UNIQUE constraint in the same transaction as the write, and
 * this port is an optimisation: `setIfAbsent` returning false lets us skip a
 * transaction, but returning true guarantees nothing. A wiped, missing, or stale KV
 * is therefore harmless, which is also what makes the zero-credential default viable.
 *
 * See BUILD_PLAN.md 5.1 commitment A1 and 5.7.
 */
export interface KvPort {
  readonly name: 'postgres' | 'memory' | 'upstash'
  /** Human-readable target, for the boot banner. Never contains credentials. */
  readonly describe: string

  /** Atomic set-if-absent. True when this caller won the key. */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>

  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec: number): Promise<void>
  del(key: string): Promise<void>

  /**
   * Increment, setting the TTL atomically on creation.
   *
   * The signature exists in this shape because the spec's version did INCR then
   * EXPIRE as two calls, so a crash between them left a key with no expiry, which
   * meant one bank stayed suppressed forever. The TTL must not be a separate step.
   */
  incrWithTtl(key: string, ttlSec: number): Promise<number>

  close(): Promise<void>
}
