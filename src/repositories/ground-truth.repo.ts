/**
 * The oracle counterfactual repository. `payload` holds whatever shape the D4
 * generator writes (per-action true outcomes and probabilities) — deliberately
 * untyped here, since that shape belongs to the generator, not to the data layer.
 *
 * This file must never be imported from src/app/worker/** — that is Track B leaking
 * into the serving path, exactly the leakage BUILD_PLAN.md §5.2's fourth gate exists
 * to catch. See eslint boundary rules and (from D4) eval/test_oracle_firewall.py.
 */
import type { SqlExecutor } from '@/ports/sql'
import { transactionId, type TransactionId } from '@/domain/ids'
import type { Jsonish } from '@/domain/json'
import { requireRow } from './util'

export interface GroundTruthRow {
  readonly transactionId: TransactionId
  readonly payload: Jsonish
  readonly createdAt: Date
}

interface GroundTruthDbRow {
  transaction_id: string
  payload: Jsonish
  created_at: Date
}

function toRow(r: GroundTruthDbRow): GroundTruthRow {
  return { transactionId: transactionId(r.transaction_id), payload: r.payload, createdAt: r.created_at }
}

export async function saveGroundTruth(
  sql: SqlExecutor,
  input: { readonly transactionId: TransactionId; readonly payload: Jsonish },
): Promise<GroundTruthRow> {
  const { rows } = await sql.query<GroundTruthDbRow>(
    `INSERT INTO ground_truth (transaction_id, payload)
     VALUES ($1, $2)
     ON CONFLICT (transaction_id) DO UPDATE SET payload = EXCLUDED.payload
     RETURNING *`,
    [input.transactionId, JSON.stringify(input.payload)],
  )
  return toRow(requireRow(rows, 'saveGroundTruth'))
}

export async function findGroundTruth(
  sql: SqlExecutor,
  id: TransactionId,
): Promise<GroundTruthRow | null> {
  const { rows } = await sql.query<GroundTruthDbRow>(
    'SELECT * FROM ground_truth WHERE transaction_id = $1',
    [id],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}
