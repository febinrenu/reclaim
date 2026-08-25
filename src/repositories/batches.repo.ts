/**
 * Batch runs, for the streamed batch execution and the policy simulator
 * (BUILD_PLAN.md §1.4 additions 1 and 2). A simulator run records `baselineBatchId`
 * and its own `policy` snapshot so a later diff never depends on code that may have
 * changed since either run happened.
 */
import type { SqlExecutor } from '@/ports/sql'
import type { Jsonish } from '@/domain/json'
import { requireRow } from './util'

export type BatchKind = 'live' | 'simulation'
export type BatchStatus = 'running' | 'done' | 'failed'

export interface BatchRow {
  readonly id: string
  readonly scenario: string
  readonly kind: BatchKind
  readonly status: BatchStatus
  readonly total: number
  readonly claimed: number
  readonly done: number
  readonly failed: number
  readonly policy: Jsonish | null
  readonly baselineBatchId: string | null
  readonly startedAt: Date
  readonly finishedAt: Date | null
}

interface BatchDbRow {
  id: string
  scenario: string
  kind: string
  status: string
  total: number
  claimed: number
  done: number
  failed: number
  policy: Jsonish | null
  baseline_batch_id: string | null
  started_at: Date
  finished_at: Date | null
}

function toRow(r: BatchDbRow): BatchRow {
  return {
    id: r.id,
    scenario: r.scenario,
    kind: r.kind as BatchKind,
    status: r.status as BatchStatus,
    total: r.total,
    claimed: r.claimed,
    done: r.done,
    failed: r.failed,
    policy: r.policy,
    baselineBatchId: r.baseline_batch_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

export interface StartBatchInput {
  readonly scenario: string
  readonly kind?: BatchKind
  readonly total: number
  readonly policy?: Jsonish | null
  readonly baselineBatchId?: string | null
}

export async function startBatch(sql: SqlExecutor, input: StartBatchInput): Promise<BatchRow> {
  const id = crypto.randomUUID()
  const { rows } = await sql.query<BatchDbRow>(
    `INSERT INTO batches (id, scenario, kind, total, policy, baseline_batch_id)
     VALUES ($1, $2, COALESCE($3, 'live'), $4, $5, $6)
     RETURNING *`,
    [
      id,
      input.scenario,
      input.kind ?? null,
      input.total,
      input.policy === undefined || input.policy === null ? null : JSON.stringify(input.policy),
      input.baselineBatchId ?? null,
    ],
  )
  return toRow(requireRow(rows, 'startBatch'))
}

export async function bumpBatchCounters(
  sql: SqlExecutor,
  id: string,
  delta: { readonly claimed?: number; readonly done?: number; readonly failed?: number },
): Promise<void> {
  await sql.query(
    `UPDATE batches
     SET claimed = claimed + $2, done = done + $3, failed = failed + $4
     WHERE id = $1`,
    [id, delta.claimed ?? 0, delta.done ?? 0, delta.failed ?? 0],
  )
}

export async function finishBatch(
  sql: SqlExecutor,
  id: string,
  status: Exclude<BatchStatus, 'running'>,
): Promise<void> {
  await sql.query(`UPDATE batches SET status = $2, finished_at = now() WHERE id = $1`, [id, status])
}

export async function findBatchById(sql: SqlExecutor, id: string): Promise<BatchRow | null> {
  const { rows } = await sql.query<BatchDbRow>('SELECT * FROM batches WHERE id = $1', [id])
  return rows[0] === undefined ? null : toRow(rows[0])
}

/** D12's simulator page: a dropdown of recent, completed *live* batches to
 * pick a baseline from — never a `simulation`-kind batch, since simulating a
 * simulation would replay decisions that were never actually acted on. */
export async function listRecentLive(sql: SqlExecutor, limit = 20): Promise<readonly BatchRow[]> {
  const { rows } = await sql.query<BatchDbRow>(
    `SELECT * FROM batches WHERE kind = 'live' AND status = 'done' ORDER BY started_at DESC LIMIT $1`,
    [limit],
  )
  return rows.map(toRow)
}
