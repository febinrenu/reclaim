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
  readonly cardId: string | null
  readonly bank: string | null
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
  card_id: string | null
  bank: string | null
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
    cardId: r.card_id,
    bank: r.bank,
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
  readonly cardId?: string | null
  readonly bank?: string | null
}

/**
 * Upsert rather than plain insert: the same transaction id recurs across its
 * lifecycle (failed, retried, recovered), and the webhook envelope is the source of
 * truth for its current status each time a new event about it arrives.
 *
 * `card_id` and `bank` are deliberately excluded from the `ON CONFLICT DO UPDATE`
 * clause, same treatment as `created_at`: each is the first-recorded fact about
 * this transaction's own identity, not something a later event should overwrite.
 */
export async function upsertTransaction(
  sql: SqlExecutor,
  input: InsertTransactionInput,
): Promise<TransactionRow> {
  const { rows } = await sql.query<TransactionDbRow>(
    `INSERT INTO transactions
       (id, customer_id, amount_paise, currency, scenario, status, error_code, error_description, event_created_at, card_id, bank)
     VALUES ($1, $2, $3, COALESCE($4, 'INR'), COALESCE($5, 'subscription'), $6, $7, $8, $9, $10, $11)
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
      input.cardId ?? null,
      input.bank ?? null,
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

/**
 * A real, found race, not a hypothetical: under concurrent processing of the
 * same transaction (multiple `after()` webhook kicks racing the embedded
 * poller — genuinely reproduced by posting several real events for one
 * transaction in quick succession), the "read retryCount, decide, later
 * increment" sequence spans the whole decision pipeline, not one atomic
 * statement — two concurrent calls can both read the same pre-increment value
 * and both proceed as if the stopping rule (SYSTEM_SPEC.md §14) had not fired
 * yet, pushing `retry_count` past `maxRetries`.
 *
 * `cap` is what closes it atomically, not a check-then-act in application
 * code: the `WHERE retry_count < $2` guard means the database itself refuses
 * the increment once the cap is reached, regardless of how many concurrent
 * callers race it or what stale value any of them read earlier. A caller that
 * loses this race gets back the real current value, read fresh, rather than a
 * guess — `docs/INCIDENTS.md` has the full account of how this was found.
 */
export async function incrementRetryCount(
  sql: SqlExecutor,
  id: TransactionId,
  cap: number,
): Promise<number> {
  const { rows } = await sql.query<{ retry_count: number }>(
    'UPDATE transactions SET retry_count = retry_count + 1 WHERE id = $1 AND retry_count < $2 RETURNING retry_count',
    [id, cap],
  )
  if (rows.length > 0) return requireRow(rows, 'incrementRetryCount').retry_count
  const current = await findTransactionById(sql, id)
  return current?.retryCount ?? cap
}

/** Which column a risk-identity key searches against — `src/app/worker/live-risk-signals.ts`
 * falls back to `customer_id` for a non-card payment method (netbanking/UPI),
 * and the two are genuinely different columns, so the caller must say which
 * one a given key actually is rather than the query guessing. */
export type RiskIdentityColumn = 'card_id' | 'customer_id'

// `column` is interpolated directly into the two queries below rather than
// parameterized — safe only because its type is the closed two-member union
// above, checked at compile time, never a raw string from a caller. Every
// actual value (`key`, the two ids, the two timestamps) stays a bound
// parameter.

/** D11's real risk signals (closes the process-event.ts TODO): count of *other*
 * failed transactions sharing this risk identity, strictly before `beforeMs` —
 * never including the row this decision is about, and never looking forward
 * (BUILD_PLAN.md §6.7's leakage discipline). */
export async function countRecentFailedByIdentity(
  sql: SqlExecutor,
  column: RiskIdentityColumn,
  key: string,
  excludeTransactionId: TransactionId,
  windowStartMs: number,
  beforeMs: number,
): Promise<number> {
  const { rows } = await sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM transactions
     WHERE ${column} = $1 AND id != $2 AND status = 'failed'
       AND created_at >= $3 AND created_at < $4`,
    [key, excludeTransactionId, new Date(windowStartMs), new Date(beforeMs)],
  )
  return Number(rows[0]?.count ?? 0)
}

/** The earliest recorded transaction for this risk identity, excluding the
 * current transaction itself and strictly before `beforeMs` — null means
 * there is no history at all before that instant (the caller treats that the
 * same as "first seen recently"). Excludes by id, not just by timestamp: the
 * current transaction's own row is typically already inserted by the time
 * this runs (`created_at = the database's own now()`, not necessarily
 * identical to `beforeMs`), so relying on the timestamp filter alone could
 * let a repeat identity's own just-inserted row masquerade as its own history. */
export async function earliestTransactionMsByIdentity(
  sql: SqlExecutor,
  column: RiskIdentityColumn,
  key: string,
  excludeTransactionId: TransactionId,
  beforeMs: number,
): Promise<number | null> {
  const { rows } = await sql.query<{ created_at: Date }>(
    `SELECT created_at FROM transactions WHERE ${column} = $1 AND id != $2 AND created_at < $3 ORDER BY created_at ASC LIMIT 1`,
    [key, excludeTransactionId, new Date(beforeMs)],
  )
  return rows[0] === undefined ? null : rows[0].created_at.getTime()
}

/** This customer's own amount history, strictly before `beforeMs` and
 * excluding the current transaction — the population `amountFarAboveHistory`
 * compares the current amount against. Returns `null` when there is no prior
 * history to compare against at all, rather than a spurious zero. */
export async function customerAmountStats(
  sql: SqlExecutor,
  customerIdVal: CustomerId,
  excludeTransactionId: TransactionId,
  beforeMs: number,
): Promise<{ readonly mean: number; readonly stddev: number; readonly n: number } | null> {
  const { rows } = await sql.query<{ mean: string | null; stddev: string | null; n: string }>(
    `SELECT avg(amount_paise)::text AS mean, stddev_pop(amount_paise)::text AS stddev, count(*)::text AS n
     FROM transactions WHERE customer_id = $1 AND id != $2 AND created_at < $3`,
    [customerIdVal, excludeTransactionId, new Date(beforeMs)],
  )
  const n = Number(rows[0]?.n ?? 0)
  if (n === 0 || rows[0]?.mean === null || rows[0]?.mean === undefined) return null
  // stddev_pop is null (not 0) over a single row — a lone data point has no
  // spread to measure, distinct from "measured spread of exactly zero."
  const stddev = rows[0].stddev === null ? 0 : Number(rows[0].stddev)
  return { mean: Number(rows[0].mean), stddev, n }
}

/**
 * The global amount distribution, across every customer — the fallback
 * population `amount_zscore` compares against when a customer has too little
 * of their own history (`live-features.ts`'s own threshold) to z-score
 * against themselves meaningfully. Real and live, not a fixed prior: computed
 * fresh from whatever transaction history actually exists at call time, the
 * same "no history yet" honesty every other live signal in this codebase
 * already holds to — an empty table returns `null`, never a fabricated 0/1.
 */
export async function globalAmountStats(
  sql: SqlExecutor,
  beforeMs: number,
): Promise<{ readonly mean: number; readonly stddev: number; readonly n: number } | null> {
  const { rows } = await sql.query<{ mean: string | null; stddev: string | null; n: string }>(
    `SELECT avg(amount_paise)::text AS mean, stddev_pop(amount_paise)::text AS stddev, count(*)::text AS n
     FROM transactions WHERE created_at < $1`,
    [new Date(beforeMs)],
  )
  const n = Number(rows[0]?.n ?? 0)
  if (n === 0 || rows[0]?.mean === null || rows[0]?.mean === undefined) return null
  const stddev = rows[0].stddev === null ? 0 : Number(rows[0].stddev)
  return { mean: Number(rows[0].mean), stddev, n }
}

/**
 * Closes a gap `live-features.ts` named directly: `bank_recent_fail_rate` was
 * hardcoded because the schema had no `bank` column to compute one from
 * (0008_bank_column.sql). A trailing 30-day window, matching the shock
 * detector's own preference for a real, bounded recency window over an
 * all-time average that a bank's improved (or degraded) service would take
 * forever to move. `null` on zero history for this bank, so the caller's own
 * documented "no history yet" prior is a deliberate choice, not indistinguishable
 * from "this bank has a real, measured 0% failure rate."
 */
export async function bankRecentFailRate(
  sql: SqlExecutor,
  bank: string,
  windowStartMs: number,
  beforeMs: number,
): Promise<{ readonly rate: number; readonly n: number } | null> {
  const { rows } = await sql.query<{ failed: string; total: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'failed')::text AS failed,
       count(*)::text AS total
     FROM transactions
     WHERE bank = $1 AND created_at >= $2 AND created_at < $3`,
    [bank, new Date(windowStartMs), new Date(beforeMs)],
  )
  const total = Number(rows[0]?.total ?? 0)
  if (total === 0) return null
  return { rate: Number(rows[0]?.failed ?? 0) / total, n: total }
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
