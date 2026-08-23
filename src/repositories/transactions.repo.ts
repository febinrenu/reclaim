import type { SqlExecutor } from '@/ports/sql'
import { transactionId, customerId, type TransactionId, type CustomerId } from '@/domain/ids'
import { paise, type Paise } from '@/domain/money'
import { requireRow } from './util'

export type TransactionStatus = 'failed' | 'recovered' | 'abandoned' | 'escalated'
export type Scenario = 'subscription' | 'b2b_receivable'

export interface TransactionRow {
  readonly id: TransactionId
  readonly customerId: CustomerId | null
  readonly amount: Paise
  readonly currency: string
  readonly scenario: Scenario
  readonly status: TransactionStatus
  readonly errorCode: string | null
  readonly errorDescription: string | null
  readonly eventCreatedAt: Date | null
  readonly retryCount: number
  readonly createdAt: Date
}

interface TransactionDbRow {
  id: string
  customer_id: string | null
  amount_paise: string | number
  currency: string
  scenario: string
  status: string
  error_code: string | null
  error_description: string | null
  event_created_at: Date | null
  retry_count: number
  created_at: Date
}

function toRow(r: TransactionDbRow): TransactionRow {
  return {
    id: transactionId(r.id),
    customerId: r.customer_id === null ? null : customerId(r.customer_id),
    amount: paise(Number(r.amount_paise)),
    currency: r.currency,
    scenario: r.scenario as Scenario,
    status: r.status as TransactionStatus,
    errorCode: r.error_code,
    errorDescription: r.error_description,
    eventCreatedAt: r.event_created_at,
    retryCount: r.retry_count,
    createdAt: r.created_at,
  }
}

export interface InsertTransactionInput {
  readonly id: TransactionId
  readonly customerId?: CustomerId | null
  readonly amount: Paise
  readonly currency?: string
  readonly scenario?: Scenario
  readonly status: TransactionStatus
  readonly errorCode?: string | null
  readonly errorDescription?: string | null
  readonly eventCreatedAt?: Date | null
}

/**
 * Upsert rather than plain insert: the same transaction id recurs across its
 * lifecycle (failed, retried, recovered), and the webhook envelope is the source of
 * truth for its current status each time a new event about it arrives.
 */
export async function upsertTransaction(
  sql: SqlExecutor,
  input: InsertTransactionInput,
): Promise<TransactionRow> {
  const { rows } = await sql.query<TransactionDbRow>(
    `INSERT INTO transactions
       (id, customer_id, amount_paise, currency, scenario, status, error_code, error_description, event_created_at)
     VALUES ($1, $2, $3, COALESCE($4, 'INR'), COALESCE($5, 'subscription'), $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           error_code = EXCLUDED.error_code,
           error_description = EXCLUDED.error_description,
           event_created_at = EXCLUDED.event_created_at
     RETURNING *`,
    [
      input.id,
      input.customerId ?? null,
      input.amount,
      input.currency ?? null,
      input.scenario ?? null,
      input.status,
      input.errorCode ?? null,
      input.errorDescription ?? null,
      input.eventCreatedAt ?? null,
    ],
  )
  return toRow(requireRow(rows, 'upsertTransaction'))
}

export async function findTransactionById(
  sql: SqlExecutor,
  id: TransactionId,
): Promise<TransactionRow | null> {
  const { rows } = await sql.query<TransactionDbRow>('SELECT * FROM transactions WHERE id = $1', [
    id,
  ])
  return rows[0] === undefined ? null : toRow(rows[0])
}

export async function updateTransactionStatus(
  sql: SqlExecutor,
  id: TransactionId,
  status: TransactionStatus,
): Promise<void> {
  await sql.query('UPDATE transactions SET status = $2 WHERE id = $1', [id, status])
}

export async function incrementRetryCount(sql: SqlExecutor, id: TransactionId): Promise<number> {
  const { rows } = await sql.query<{ retry_count: number }>(
    'UPDATE transactions SET retry_count = retry_count + 1 WHERE id = $1 RETURNING retry_count',
    [id],
  )
  return requireRow(rows, 'incrementRetryCount').retry_count
}

export async function listByStatus(
  sql: SqlExecutor,
  status: TransactionStatus,
  limit = 100,
): Promise<readonly TransactionRow[]> {
  const { rows } = await sql.query<TransactionDbRow>(
    'SELECT * FROM transactions WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
    [status, limit],
  )
  return rows.map(toRow)
}
