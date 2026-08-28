/**
 * The escalation work queue — the recipient `ESCALATE_HUMAN` never had.
 *
 * Every state transition here is ONE conditional UPDATE that names the status it expects
 * in its own WHERE clause and returns the row it changed. `null` back means "someone
 * else got there first", and the caller is told that rather than left to infer it. This
 * is the same shape `incrementRetryCount` was rewritten into after the real concurrency
 * race in docs/INCIDENTS.md: a read-then-write in application code cannot make this
 * guarantee no matter how the read is guarded, and two operators pressing Claim in the
 * same second is the ordinary case for a work queue, not an exotic one.
 *
 * `createEscalation` is written inside T4's existing transaction (see
 * src/app/worker/process-event.ts), so the work item and the audit row commit together
 * or not at all, and `UNIQUE (event_id, attempt_generation)` means a crash-and-reclaim
 * between T3 and T4 cannot produce two work items for one decision.
 */
import type { SqlExecutor } from '@/ports/sql'
import { transactionId, customerId, eventId, type TransactionId, type CustomerId, type EventId } from '@/domain/ids'
import type { EscalationReason, EscalationResolution } from '@/domain/escalation'
import { requireRow } from './util'

export type EscalationStatus = 'open' | 'claimed' | 'resolved'

export interface EscalationRow {
  readonly id: string
  readonly eventId: EventId
  readonly attemptGeneration: number
  readonly transactionId: TransactionId | null
  readonly customerId: CustomerId | null
  readonly amountPaise: number
  readonly reason: EscalationReason
  readonly riskScore: number | null
  readonly rationale: string | null
  readonly status: EscalationStatus
  readonly assignee: string | null
  readonly claimedAt: Date | null
  readonly slaDueAt: Date
  readonly resolution: EscalationResolution | null
  readonly resolutionNote: string | null
  readonly resolvedAt: Date | null
  readonly createdAt: Date
}

interface EscalationDbRow {
  id: string
  event_id: string
  attempt_generation: number
  transaction_id: string | null
  customer_id: string | null
  amount_paise: string | number
  reason: string
  risk_score: string | number | null
  rationale: string | null
  status: string
  assignee: string | null
  claimed_at: Date | null
  sla_due_at: Date
  resolution: string | null
  resolution_note: string | null
  resolved_at: Date | null
  created_at: Date
}

/** `bigint` and `numeric` come back as strings on node-pg and as numbers on PGlite. */
function num(v: string | number): number {
  return typeof v === 'number' ? v : Number(v)
}

function toRow(r: EscalationDbRow): EscalationRow {
  return {
    id: r.id,
    eventId: eventId(r.event_id),
    attemptGeneration: r.attempt_generation,
    transactionId: r.transaction_id === null ? null : transactionId(r.transaction_id),
    customerId: r.customer_id === null ? null : customerId(r.customer_id),
    amountPaise: num(r.amount_paise),
    reason: r.reason as EscalationReason,
    riskScore: r.risk_score === null ? null : num(r.risk_score),
    rationale: r.rationale,
    status: r.status as EscalationStatus,
    assignee: r.assignee,
    claimedAt: r.claimed_at,
    slaDueAt: r.sla_due_at,
    resolution: r.resolution === null ? null : (r.resolution as EscalationResolution),
    resolutionNote: r.resolution_note,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  }
}

const SELECT_COLUMNS = `id, event_id, attempt_generation, transaction_id, customer_id,
  amount_paise, reason, risk_score, rationale, status, assignee, claimed_at, sla_due_at,
  resolution, resolution_note, resolved_at, created_at`

export interface CreateEscalationInput {
  readonly eventId: EventId
  readonly attemptGeneration: number
  readonly transactionId: TransactionId | null
  readonly customerId: CustomerId | null
  readonly amountPaise: number
  readonly reason: EscalationReason
  readonly riskScore: number | null
  readonly rationale: string | null
  /** Computed by `slaDueAtMs` from the worker's injected clock, never from `now()` here. */
  readonly slaDueAtMs: number
}

/**
 * Idempotent on `(event_id, attempt_generation)`. `DO NOTHING` plus a follow-up SELECT
 * rather than `DO UPDATE`: re-processing one event must never move a deadline an
 * operator is already working against, or silently reopen a resolved case.
 */
export async function createEscalation(
  sql: SqlExecutor,
  input: CreateEscalationInput,
): Promise<EscalationRow> {
  const id = crypto.randomUUID()
  const { rows } = await sql.query<EscalationDbRow>(
    `INSERT INTO escalations
       (id, event_id, attempt_generation, transaction_id, customer_id, amount_paise,
        reason, risk_score, rationale, sla_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (event_id, attempt_generation) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      input.eventId,
      input.attemptGeneration,
      input.transactionId,
      input.customerId,
      input.amountPaise,
      input.reason,
      input.riskScore,
      input.rationale,
      new Date(input.slaDueAtMs).toISOString(),
    ],
  )
  const inserted = rows[0]
  if (inserted !== undefined) return toRow(inserted)

  // The conflict path: a work item already exists for this event-generation. Return it
  // unchanged, so the caller's behaviour is identical whether or not it won the race.
  const existing = await findByEvent(sql, input.eventId, input.attemptGeneration)
  if (existing === null) {
    throw new Error('createEscalation: ON CONFLICT fired but no existing row was found')
  }
  return existing
}

export async function findByEvent(
  sql: SqlExecutor,
  event: EventId,
  attemptGeneration: number,
): Promise<EscalationRow | null> {
  const { rows } = await sql.query<EscalationDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM escalations
      WHERE event_id = $1 AND attempt_generation = $2`,
    [event, attemptGeneration],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

export async function findById(sql: SqlExecutor, id: string): Promise<EscalationRow | null> {
  const { rows } = await sql.query<EscalationDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM escalations WHERE id = $1`,
    [id],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

/** Unresolved work, tightest deadline first — the queue's own read order. */
export async function listQueue(sql: SqlExecutor, limit = 100): Promise<readonly EscalationRow[]> {
  const { rows } = await sql.query<EscalationDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM escalations
      WHERE status IN ('open', 'claimed')
      ORDER BY sla_due_at ASC
      LIMIT $1`,
    [limit],
  )
  return rows.map(toRow)
}

export async function listResolved(sql: SqlExecutor, limit = 50): Promise<readonly EscalationRow[]> {
  const { rows } = await sql.query<EscalationDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM escalations
      WHERE status = 'resolved'
      ORDER BY resolved_at DESC
      LIMIT $1`,
    [limit],
  )
  return rows.map(toRow)
}

/**
 * `null` means the claim was lost — the row was already claimed or resolved, or does not
 * exist. The `status = 'open'` predicate is inside the UPDATE, so concurrent claims are
 * resolved by the database: exactly one caller gets a row back.
 */
export async function claimEscalation(
  sql: SqlExecutor,
  id: string,
  assignee: string,
  nowMs: number,
): Promise<EscalationRow | null> {
  const { rows } = await sql.query<EscalationDbRow>(
    `UPDATE escalations
        SET status = 'claimed', assignee = $2, claimed_at = $3
      WHERE id = $1 AND status = 'open'
      RETURNING ${SELECT_COLUMNS}`,
    [id, assignee, new Date(nowMs).toISOString()],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

/** Hands a claimed item back to the queue, preserving nothing but the row's identity. */
export async function releaseEscalation(
  sql: SqlExecutor,
  id: string,
): Promise<EscalationRow | null> {
  const { rows } = await sql.query<EscalationDbRow>(
    `UPDATE escalations
        SET status = 'open', assignee = NULL, claimed_at = NULL
      WHERE id = $1 AND status = 'claimed'
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

/**
 * `null` means the resolve was rejected: the item was not in `claimed`. Deliberately
 * strict — resolving straight from `open` would let an outcome be recorded with nobody
 * accountable for having looked at it, which is the whole point of the queue.
 */
export async function resolveEscalation(
  sql: SqlExecutor,
  id: string,
  resolution: EscalationResolution,
  note: string | null,
  nowMs: number,
): Promise<EscalationRow | null> {
  const { rows } = await sql.query<EscalationDbRow>(
    `UPDATE escalations
        SET status = 'resolved', resolution = $2, resolution_note = $3, resolved_at = $4
      WHERE id = $1 AND status = 'claimed'
      RETURNING ${SELECT_COLUMNS}`,
    [id, resolution, note, new Date(nowMs).toISOString()],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

export interface QueueStats {
  readonly open: number
  readonly claimed: number
  readonly resolved: number
  readonly overdue: number
  /** Resolution counts, human-observed — the only labels here not from the generator. */
  readonly byResolution: ReadonlyMap<EscalationResolution, number>
}

export async function queueStats(sql: SqlExecutor, nowMs: number): Promise<QueueStats> {
  const nowIso = new Date(nowMs).toISOString()
  const { rows } = await sql.query<{ status: string; resolution: string | null; overdue: boolean; n: string | number }>(
    `SELECT status,
            resolution,
            (status <> 'resolved' AND sla_due_at < $1) AS overdue,
            count(*) AS n
       FROM escalations
      GROUP BY status, resolution, overdue`,
    [nowIso],
  )

  let open = 0
  let claimed = 0
  let resolved = 0
  let overdue = 0
  const byResolution = new Map<EscalationResolution, number>()

  for (const r of rows) {
    const n = num(r.n)
    if (r.status === 'open') open += n
    if (r.status === 'claimed') claimed += n
    if (r.status === 'resolved') resolved += n
    if (r.overdue) overdue += n
    if (r.status === 'resolved' && r.resolution !== null) {
      const key = r.resolution as EscalationResolution
      byResolution.set(key, (byResolution.get(key) ?? 0) + n)
    }
  }

  return { open, claimed, resolved, overdue, byResolution }
}

/** Test-only helper, mirroring the shape other repos expose for the same purpose. */
export async function countEscalations(sql: SqlExecutor): Promise<number> {
  const { rows } = await sql.query<{ n: string | number }>('SELECT count(*) AS n FROM escalations')
  return num(requireRow(rows, 'countEscalations').n)
}
