/**
 * The T3 INTENT row (BUILD_PLAN.md §5.6): committed *before* any side effect, keyed on
 * an idempotency key derived from (event, action, attempt generation). On reclaim
 * after a crash between T3 and T4, `findByIdempotencyKey` is what lets the worker tell
 * "we already intended this — do not blindly re-execute" from "this is fresh."
 */
import type { SqlExecutor } from '@/ports/sql'
import { transactionId, eventId, type TransactionId, type EventId } from '@/domain/ids'
import type { Jsonish } from '@/domain/json'
import { requireRow } from './util'

export type ExecutionMode = 'dry_run' | 'live'
export type AttemptStatus = 'pending' | 'settled' | 'failed'

export interface ActionAttemptRow {
  readonly id: string
  readonly transactionId: TransactionId | null
  readonly eventId: EventId | null
  readonly action: string
  readonly attemptGeneration: number
  readonly idempotencyKey: string
  readonly executionMode: ExecutionMode
  readonly status: AttemptStatus
  readonly requestBody: Jsonish | null
  readonly result: Jsonish | null
  readonly reconciliationRequired: boolean
}

interface ActionAttemptDbRow {
  id: string
  transaction_id: string | null
  event_id: string | null
  action: string
  attempt_generation: number
  idempotency_key: string
  execution_mode: string
  status: string
  request_body: Jsonish | null
  result: Jsonish | null
  reconciliation_required: boolean
}

function toRow(r: ActionAttemptDbRow): ActionAttemptRow {
  return {
    id: r.id,
    transactionId: r.transaction_id === null ? null : transactionId(r.transaction_id),
    eventId: r.event_id === null ? null : eventId(r.event_id),
    action: r.action,
    attemptGeneration: r.attempt_generation,
    idempotencyKey: r.idempotency_key,
    executionMode: r.execution_mode as ExecutionMode,
    status: r.status as AttemptStatus,
    requestBody: r.request_body,
    result: r.result,
    reconciliationRequired: r.reconciliation_required,
  }
}

export interface CreateIntentInput {
  readonly transactionId: TransactionId | null
  readonly eventId: EventId | null
  readonly action: string
  readonly attemptGeneration: number
  readonly idempotencyKey: string
  readonly executionMode: ExecutionMode
  readonly requestBody?: Jsonish | null
}

export async function createIntent(
  tx: SqlExecutor,
  input: CreateIntentInput,
): Promise<ActionAttemptRow> {
  const id = crypto.randomUUID()
  const { rows } = await tx.query<ActionAttemptDbRow>(
    `INSERT INTO action_attempts
       (id, transaction_id, event_id, action, attempt_generation, idempotency_key, execution_mode, request_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      input.transactionId,
      input.eventId,
      input.action,
      input.attemptGeneration,
      input.idempotencyKey,
      input.executionMode,
      input.requestBody === undefined || input.requestBody === null
        ? null
        : JSON.stringify(input.requestBody),
    ],
  )
  return toRow(requireRow(rows, 'createIntent'))
}

export async function findByIdempotencyKey(
  sql: SqlExecutor,
  key: string,
): Promise<ActionAttemptRow | null> {
  const { rows } = await sql.query<ActionAttemptDbRow>(
    'SELECT * FROM action_attempts WHERE idempotency_key = $1',
    [key],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

export async function settleIntent(
  tx: SqlExecutor,
  id: string,
  outcome: {
    readonly status: AttemptStatus
    readonly result: Jsonish | null
    readonly reconciliationRequired?: boolean
  },
): Promise<void> {
  await tx.query(
    `UPDATE action_attempts
     SET status = $2, result = $3, reconciliation_required = $4, settled_at = now()
     WHERE id = $1`,
    [
      id,
      outcome.status,
      outcome.result === null ? null : JSON.stringify(outcome.result),
      outcome.reconciliationRequired ?? false,
    ],
  )
}

/**
 * Closes a gap `live-features.ts` named directly: `contacts_last_7d` had a
 * `TODO(D7+)` for exactly this query. Counts contact-requiring attempts
 * (`WHATSAPP_NUDGE`/`PAYMENT_LINK` — the only two actions the language layer
 * ever drafts a customer-facing message for, per `process-event.ts`'s
 * `draftNudgeIfNeeded`) across every transaction belonging to this customer,
 * not just the current one — contact fatigue is a property of the person
 * being contacted, not of any single failing payment.
 */
/** `contactActions` is which of a scenario's own actions count as "a contact"
 * — subscription's WHATSAPP_NUDGE/PAYMENT_LINK, B2B's SEND_REMINDER/
 * OFFER_PAYMENT_PLAN — never hardcoded here, since fatigue is a scenario-
 * defined concept (`ScenarioDefinition.requiresContact`/`Policy.contactFatigueActions`
 * already carry it) and this table's `action` column holds either vocabulary. */
export async function contactsInWindow(
  sql: SqlExecutor,
  customerIdVal: string,
  windowStartMs: number,
  beforeMs: number,
  contactActions: readonly string[],
): Promise<number> {
  const { rows } = await sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM action_attempts aa
     JOIN transactions t ON t.id = aa.transaction_id
     WHERE t.customer_id = $1 AND aa.action = ANY($2)
       AND aa.created_at >= $3 AND aa.created_at < $4`,
    [customerIdVal, contactActions, new Date(windowStartMs), new Date(beforeMs)],
  )
  return Number(rows[0]?.count ?? 0)
}
