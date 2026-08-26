/**
 * The durable queue repository (BUILD_PLAN.md §5.7): always Postgres, whichever driver
 * backs it. `claimNext` is the single atomic statement from §5.6's T2 CLAIM — a normal
 * pending job and an expired-lease reclaim are the same `WHERE` clause, so no separate
 * sweeper process is ever needed.
 *
 * The worker loop, `drainOnce`, and the crash-injection hook that exercises the
 * reclaim path are D6 scope (BUILD_PLAN.md §7). This file provides the primitives
 * that loop will call, not the loop itself.
 */
import type { SqlExecutor } from '@/ports/sql'
import { jobId, type JobId } from '@/domain/ids'
import type { Jsonish } from '@/domain/json'
import { requireRow } from './util'

export type JobStatus = 'pending' | 'claimed' | 'done' | 'failed'

export interface JobRow {
  readonly id: JobId
  readonly kind: string
  readonly dedupeKey: string | null
  readonly payload: Jsonish
  readonly status: JobStatus
  readonly attempts: number
  readonly availableAt: Date
  readonly lockedBy: string | null
  readonly leaseExpiresAt: Date | null
  readonly lastError: string | null
  readonly result: Jsonish | null
}

interface JobDbRow {
  id: string
  kind: string
  dedupe_key: string | null
  payload: Jsonish
  status: string
  attempts: number
  available_at: Date
  locked_by: string | null
  lease_expires_at: Date | null
  last_error: string | null
  result: Jsonish | null
}

function toRow(r: JobDbRow): JobRow {
  return {
    id: jobId(r.id),
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: r.payload,
    status: r.status as JobStatus,
    attempts: r.attempts,
    availableAt: r.available_at,
    lockedBy: r.locked_by,
    leaseExpiresAt: r.lease_expires_at,
    lastError: r.last_error,
    result: r.result,
  }
}

export interface EnqueueRequest {
  readonly kind: string
  readonly dedupeKey?: string | null
  readonly payload: Jsonish
  readonly availableAt?: Date
  /**
   * A delay relative to the DATABASE's own `now()`, in seconds — for scheduling a
   * job ahead without comparing two different clocks. `claimNext` below compares
   * `available_at` against its own `now()` call; `availableAt` (a `Date` bound from
   * the app's injected clock, per BUILD_PLAN.md's clock-injection rule) can disagree
   * with that under a fixed/manual test clock, which caused a real cascade — a
   * "scheduled ahead" follow-up job claimed immediately because the app clock and
   * the DB clock disagreed about what "ahead" meant. `availableInSec` sidesteps the
   * question entirely by never comparing clocks at all. Takes precedence over
   * `availableAt` when both are given.
   */
  readonly availableInSec?: number
}

/**
 * Takes `tx` explicitly (not just any `SqlExecutor`) because enqueue is meant to
 * commit inside the caller's own transaction — the transactional-outbox pattern that
 * makes T1's "durably enqueue" and "record the event" atomic. See src/ports/queue.ts.
 */
export async function enqueue(
  tx: SqlExecutor,
  req: EnqueueRequest,
): Promise<{ jobId: JobId; created: boolean }> {
  const id = crypto.randomUUID()
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO job_queue (id, kind, dedupe_key, payload, available_at)
     VALUES ($1, $2, $3, $4, COALESCE(now() + make_interval(secs => $6), $5, now()))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      req.kind,
      req.dedupeKey ?? null,
      JSON.stringify(req.payload),
      req.availableAt ?? null,
      req.availableInSec ?? null,
    ],
  )

  if (rows.length > 0) return { jobId: jobId(requireRow(rows, 'enqueue').id), created: true }

  // Lost the dedupe race (or a real duplicate): the existing job's id, not ours.
  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM job_queue WHERE dedupe_key = $1',
    [req.dedupeKey],
  )
  return { jobId: jobId(requireRow(existing.rows, 'enqueue (existing)').id), created: false }
}

export async function claimNext(
  tx: SqlExecutor,
  opts: { readonly workerId: string; readonly leaseSeconds: number },
): Promise<JobRow | null> {
  const { rows } = await tx.query<JobDbRow>(
    `UPDATE job_queue
     SET status = 'claimed',
         locked_by = $1,
         locked_at = now(),
         lease_expires_at = now() + make_interval(secs => $2),
         attempts = attempts + 1,
         updated_at = now()
     WHERE id = (
       SELECT id FROM job_queue
       WHERE available_at <= now()
         AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < now()))
       ORDER BY available_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [opts.workerId, opts.leaseSeconds],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

export async function complete(tx: SqlExecutor, id: JobId, result: Jsonish): Promise<void> {
  await tx.query(
    `UPDATE job_queue SET status = 'done', result = $2, updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(result)],
  )
}

export async function fail(
  tx: SqlExecutor,
  id: JobId,
  opts: { readonly error: string; readonly retryAt?: Date },
): Promise<void> {
  await tx.query(
    `UPDATE job_queue
     SET status = $3, last_error = $2, available_at = COALESCE($4, available_at), updated_at = now()
     WHERE id = $1`,
    [id, opts.error, opts.retryAt === undefined ? 'failed' : 'pending', opts.retryAt ?? null],
  )
}

export async function findJobById(sql: SqlExecutor, id: JobId): Promise<JobRow | null> {
  const { rows } = await sql.query<JobDbRow>('SELECT * FROM job_queue WHERE id = $1', [id])
  return rows[0] === undefined ? null : toRow(rows[0])
}

/** Pending or claimed-but-lease-expired — the same set `claimNext` would pick up
 * next, so a trigger can decide whether to immediately re-kick (BUILD_PLAN.md §5.7). */
export async function countPending(sql: SqlExecutor): Promise<number> {
  const { rows } = await sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM job_queue
     WHERE available_at <= now()
       AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < now()))`,
  )
  return Number(rows[0]?.count ?? 0)
}

/** D10's queue page: a snapshot of the most recent jobs, optionally scoped to
 * one status, newest first. Read-only — nothing here claims or mutates a job. */
export async function listRecent(
  sql: SqlExecutor,
  opts: { readonly limit: number; readonly status?: JobStatus },
): Promise<readonly JobRow[]> {
  const { rows } =
    opts.status === undefined
      ? await sql.query<JobDbRow>(
          `SELECT * FROM job_queue ORDER BY updated_at DESC LIMIT $1`,
          [opts.limit],
        )
      : await sql.query<JobDbRow>(
          `SELECT * FROM job_queue WHERE status = $2 ORDER BY updated_at DESC LIMIT $1`,
          [opts.limit, opts.status],
        )
  return rows.map(toRow)
}

/** Counts by status, for the queue page's summary tiles. */
export async function countByStatus(sql: SqlExecutor): Promise<Readonly<Record<JobStatus, number>>> {
  const { rows } = await sql.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM job_queue GROUP BY status`,
  )
  const base: Record<JobStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0 }
  for (const row of rows) {
    if (row.status in base) base[row.status as JobStatus] = Number(row.count)
  }
  return base
}
