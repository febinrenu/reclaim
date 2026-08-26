/**
 * Repositories take `SqlExecutor`, never `Transactional` — see src/ports/sql.ts. That
 * is what lets the same call work standalone or nested inside a caller's transaction,
 * which in turn is what makes the worker's five-write settle step (BUILD_PLAN.md §5.6
 * T4) atomic: the repository code has no idea, and does not need to, whether it is
 * inside a transaction.
 */
import type { SqlExecutor } from '@/ports/sql'
import { customerId, type CustomerId } from '@/domain/ids'
import { paise, type Paise } from '@/domain/money'
import { requireRow } from './util'

export interface CustomerRow {
  readonly id: CustomerId
  readonly name: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly ltvAmount: Paise
  readonly successfulPayments: number
  readonly failedPayments: number
  readonly riskScore: number
  readonly createdAt: Date
}

interface CustomerDbRow {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  ltv_amount_paise: string | number
  successful_payments: number
  failed_payments: number
  risk_score: string | number
  created_at: Date
}

function toRow(r: CustomerDbRow): CustomerRow {
  return {
    id: customerId(r.id),
    name: r.name,
    phone: r.phone,
    email: r.email,
    ltvAmount: paise(Number(r.ltv_amount_paise)),
    successfulPayments: r.successful_payments,
    failedPayments: r.failed_payments,
    riskScore: Number(r.risk_score),
    createdAt: r.created_at,
  }
}

export interface UpsertCustomerInput {
  readonly id: CustomerId
  readonly name?: string | null
  readonly phone?: string | null
  readonly email?: string | null
}

export async function upsertCustomer(
  sql: SqlExecutor,
  input: UpsertCustomerInput,
): Promise<CustomerRow> {
  const { rows } = await sql.query<CustomerDbRow>(
    `INSERT INTO customers (id, name, phone, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, customers.name),
           phone = COALESCE(EXCLUDED.phone, customers.phone),
           email = COALESCE(EXCLUDED.email, customers.email)
     RETURNING *`,
    [input.id, input.name ?? null, input.phone ?? null, input.email ?? null],
  )
  return toRow(requireRow(rows, 'upsertCustomer'))
}

export async function findCustomerById(
  sql: SqlExecutor,
  id: CustomerId,
): Promise<CustomerRow | null> {
  const { rows } = await sql.query<CustomerDbRow>('SELECT * FROM customers WHERE id = $1', [id])
  return rows[0] === undefined ? null : toRow(rows[0])
}

/**
 * Applied when a transaction settles, to keep the two counters and the LTV estimate
 * current without a separate reconciliation pass. `deltaLtvPaise` may be negative for
 * a write-off in the receivables scenario.
 */
export async function recordCustomerOutcome(
  sql: SqlExecutor,
  id: CustomerId,
  outcome: { readonly recovered: boolean; readonly deltaLtvPaise: number },
): Promise<void> {
  await sql.query(
    `UPDATE customers
     SET successful_payments = successful_payments + CASE WHEN $2 THEN 1 ELSE 0 END,
         failed_payments = failed_payments + CASE WHEN $2 THEN 0 ELSE 1 END,
         ltv_amount_paise = ltv_amount_paise + $3
     WHERE id = $1`,
    [id, outcome.recovered, outcome.deltaLtvPaise],
  )
}

/**
 * The population `ltv_zscore` compares a customer against — closes a gap
 * `live-features.ts` named directly ("z-scoring needs a population of
 * customers to be relative to. A single live customer read in isolation has
 * no such population yet."). Real and live: computed fresh from whatever
 * customer population actually exists at call time, `null` on an empty table
 * rather than a fabricated 0/1 — the same "no history yet" honesty every
 * other live signal in this codebase already holds to.
 */
export async function ltvPopulationStats(
  sql: SqlExecutor,
): Promise<{ readonly mean: number; readonly stddev: number; readonly n: number } | null> {
  const { rows } = await sql.query<{ mean: string | null; stddev: string | null; n: string }>(
    `SELECT avg(ltv_amount_paise)::text AS mean, stddev_pop(ltv_amount_paise)::text AS stddev, count(*)::text AS n
     FROM customers`,
  )
  const n = Number(rows[0]?.n ?? 0)
  if (n === 0 || rows[0]?.mean === null || rows[0]?.mean === undefined) return null
  const stddev = rows[0].stddev === null ? 0 : Number(rows[0].stddev)
  return { mean: Number(rows[0].mean), stddev, n }
}
