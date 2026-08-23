/**
 * Held-out evaluation receipts, written once per model version rather than per
 * transaction. This table existing at all is the proof that evaluation happened
 * instead of being eyeballed — see BUILD_PLAN.md §6.
 */
import type { SqlExecutor } from '@/ports/sql'
import { requireRow } from './util'

export interface ModelEvaluationRow {
  readonly id: string
  readonly modelName: string
  readonly evalSetSize: number | null
  readonly brierScore: number | null
  readonly precisionScore: number | null
  readonly recallScore: number | null
  readonly falsePositiveCostMilli: number | null
  readonly notes: string | null
  readonly createdAt: Date
}

interface ModelEvaluationDbRow {
  id: string
  model_name: string
  eval_set_size: number | null
  brier_score: string | number | null
  precision_score: string | number | null
  recall_score: string | number | null
  false_positive_cost_milli: string | number | null
  notes: string | null
  created_at: Date
}

function toRow(r: ModelEvaluationDbRow): ModelEvaluationRow {
  return {
    id: r.id,
    modelName: r.model_name,
    evalSetSize: r.eval_set_size,
    brierScore: r.brier_score === null ? null : Number(r.brier_score),
    precisionScore: r.precision_score === null ? null : Number(r.precision_score),
    recallScore: r.recall_score === null ? null : Number(r.recall_score),
    falsePositiveCostMilli:
      r.false_positive_cost_milli === null ? null : Number(r.false_positive_cost_milli),
    notes: r.notes,
    createdAt: r.created_at,
  }
}

export interface RecordEvaluationInput {
  readonly modelName: string
  readonly evalSetSize?: number | null
  readonly brierScore?: number | null
  readonly precisionScore?: number | null
  readonly recallScore?: number | null
  readonly falsePositiveCostMilli?: number | null
  readonly notes?: string | null
}

export async function recordEvaluation(
  sql: SqlExecutor,
  input: RecordEvaluationInput,
): Promise<ModelEvaluationRow> {
  const id = crypto.randomUUID()
  const { rows } = await sql.query<ModelEvaluationDbRow>(
    `INSERT INTO model_evaluations
       (id, model_name, eval_set_size, brier_score, precision_score, recall_score,
        false_positive_cost_milli, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      input.modelName,
      input.evalSetSize ?? null,
      input.brierScore ?? null,
      input.precisionScore ?? null,
      input.recallScore ?? null,
      input.falsePositiveCostMilli ?? null,
      input.notes ?? null,
    ],
  )
  return toRow(requireRow(rows, 'recordEvaluation'))
}

export async function listByModel(
  sql: SqlExecutor,
  modelName: string,
): Promise<readonly ModelEvaluationRow[]> {
  const { rows } = await sql.query<ModelEvaluationDbRow>(
    'SELECT * FROM model_evaluations WHERE model_name = $1 ORDER BY created_at DESC',
    [modelName],
  )
  return rows.map(toRow)
}
