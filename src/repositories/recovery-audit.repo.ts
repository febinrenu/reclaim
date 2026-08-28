/**
 * The audit trail (BUILD_PLAN.md §5.1 A3, §6.1). `decisionInput` is the `DecisionInput`
 * persisted verbatim — never derived from source rows, which mutate — so the policy
 * simulator can replay it under a different policy with zero I/O and the EV explorer
 * can read a breakdown that is already sitting in the row.
 *
 * `UNIQUE (event_id, attempt_generation)` on the table makes "never two audit rows for
 * one event-generation" a schema fact. `insertAuditRow` therefore does not need to
 * defend against that case in application code — a duplicate settle attempt raises a
 * constraint violation, which the caller (D6's worker) catches and treats as "already
 * done." See the crash matrix in BUILD_PLAN.md §5.6.
 */
import type { SqlExecutor } from '@/ports/sql'
import { auditId, transactionId, eventId, type AuditId, type TransactionId, type EventId } from '@/domain/ids'
import type { Jsonish } from '@/domain/json'
import { requireRow } from './util'

export type ExecutionMode = 'dry_run' | 'live'
export type Outcome = 'success' | 'failed' | 'pending' | 'skipped' | 'unknown'

export interface RecoveryAuditRow {
  readonly id: AuditId
  readonly eventId: EventId
  readonly attemptGeneration: number
  readonly transactionId: TransactionId | null
  readonly batchId: string | null
  readonly decisionInput: Jsonish
  readonly pRecover: number | null
  readonly riskScore: number | null
  readonly evBreakdown: Jsonish | null
  readonly chosenAction: string
  readonly rationale: string | null
  readonly evMilli: number | null
  readonly upliftMilli: number | null
  readonly llmSource: string | null
  readonly llmPromptTokens: number | null
  readonly llmCompletionTokens: number | null
  readonly llmCostMilli: number | null
  readonly decisionLatencyMs: number | null
  readonly executionMode: ExecutionMode
  readonly outcome: Outcome | null
  readonly reconciliationRequired: boolean
  readonly createdAt: Date
  /** Which scenario produced this decision — `subscription`, `b2b_receivable` or
   * `checkout_abandonment`. Populated by `listRecent` only; `null` on the by-id
   * reads, which do not join. */
  readonly scenario: string | null
}

interface RecoveryAuditDbRow {
  id: string
  event_id: string
  attempt_generation: number
  transaction_id: string | null
  batch_id: string | null
  decision_input: Jsonish
  p_recover: string | number | null
  risk_score: string | number | null
  ev_breakdown: Jsonish | null
  chosen_action: string
  rationale: string | null
  ev_milli: string | number | null
  uplift_milli: string | number | null
  llm_source: string | null
  llm_prompt_tokens: number | null
  llm_completion_tokens: number | null
  llm_cost_milli: string | number | null
  decision_latency_ms: number | null
  execution_mode: string
  outcome: string | null
  reconciliation_required: boolean
  created_at: Date
  /** Joined from `transactions`, and only by `listRecent` — the by-id reads do not
   * join, so this is absent rather than null there. Three scenarios write to one
   * audit ledger and were indistinguishable in it without this. */
  scenario?: string | null
}

function toRow(r: RecoveryAuditDbRow): RecoveryAuditRow {
  return {
    id: auditId(r.id),
    eventId: eventId(r.event_id),
    attemptGeneration: r.attempt_generation,
    transactionId: r.transaction_id === null ? null : transactionId(r.transaction_id),
    batchId: r.batch_id,
    decisionInput: r.decision_input,
    pRecover: r.p_recover === null ? null : Number(r.p_recover),
    riskScore: r.risk_score === null ? null : Number(r.risk_score),
    evBreakdown: r.ev_breakdown,
    chosenAction: r.chosen_action,
    rationale: r.rationale,
    evMilli: r.ev_milli === null ? null : Number(r.ev_milli),
    upliftMilli: r.uplift_milli === null ? null : Number(r.uplift_milli),
    llmSource: r.llm_source,
    llmPromptTokens: r.llm_prompt_tokens,
    llmCompletionTokens: r.llm_completion_tokens,
    llmCostMilli: r.llm_cost_milli === null ? null : Number(r.llm_cost_milli),
    decisionLatencyMs: r.decision_latency_ms,
    executionMode: r.execution_mode as ExecutionMode,
    outcome: r.outcome as Outcome | null,
    reconciliationRequired: r.reconciliation_required,
    createdAt: r.created_at,
    scenario: r.scenario ?? null,
  }
}

export interface InsertAuditRowInput {
  readonly eventId: EventId
  readonly attemptGeneration: number
  readonly transactionId: TransactionId | null
  readonly batchId?: string | null
  readonly decisionInput: Jsonish
  readonly pRecover?: number | null
  readonly riskScore?: number | null
  readonly evBreakdown?: Jsonish | null
  readonly chosenAction: string
  readonly rationale?: string | null
  readonly evMilli?: number | null
  readonly upliftMilli?: number | null
  readonly llmSource?: string | null
  readonly llmPromptTokens?: number | null
  readonly llmCompletionTokens?: number | null
  readonly llmCostMilli?: number | null
  readonly decisionLatencyMs?: number | null
  readonly executionMode: ExecutionMode
  readonly outcome?: Outcome | null
  /** True when this row's decision was computed from a `retryCount` a
   * concurrent settle has since raced past the stopping-rule cap — the
   * decision itself is stale (it may recommend a retry that will never
   * happen) even though the counter it read from stayed correct. See
   * `transactions.repo.ts`'s `incrementRetryCount` and `docs/INCIDENTS.md`. */
  readonly reconciliationRequired?: boolean
}

export async function insertAuditRow(
  tx: SqlExecutor,
  input: InsertAuditRowInput,
): Promise<RecoveryAuditRow> {
  const id = crypto.randomUUID()
  const { rows } = await tx.query<RecoveryAuditDbRow>(
    `INSERT INTO recovery_audit
       (id, event_id, attempt_generation, transaction_id, batch_id, decision_input, p_recover,
        risk_score, ev_breakdown, chosen_action, rationale, ev_milli, uplift_milli, llm_source,
        llm_prompt_tokens, llm_completion_tokens, llm_cost_milli, decision_latency_ms,
        execution_mode, outcome, reconciliation_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [
      id,
      input.eventId,
      input.attemptGeneration,
      input.transactionId,
      input.batchId ?? null,
      JSON.stringify(input.decisionInput),
      input.pRecover ?? null,
      input.riskScore ?? null,
      input.evBreakdown === undefined || input.evBreakdown === null
        ? null
        : JSON.stringify(input.evBreakdown),
      input.chosenAction,
      input.rationale ?? null,
      input.evMilli ?? null,
      input.upliftMilli ?? null,
      input.llmSource ?? null,
      input.llmPromptTokens ?? null,
      input.llmCompletionTokens ?? null,
      input.llmCostMilli ?? null,
      input.decisionLatencyMs ?? null,
      input.executionMode,
      input.outcome ?? null,
      input.reconciliationRequired ?? false,
    ],
  )
  return toRow(requireRow(rows, 'insertAuditRow'))
}

export async function findAuditByEvent(
  sql: SqlExecutor,
  eventIdVal: EventId,
  attemptGeneration: number,
): Promise<RecoveryAuditRow | null> {
  const { rows } = await sql.query<RecoveryAuditDbRow>(
    'SELECT * FROM recovery_audit WHERE event_id = $1 AND attempt_generation = $2',
    [eventIdVal, attemptGeneration],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}

export async function listByBatch(
  sql: SqlExecutor,
  batchId: string,
): Promise<readonly RecoveryAuditRow[]> {
  const { rows } = await sql.query<RecoveryAuditDbRow>(
    'SELECT * FROM recovery_audit WHERE batch_id = $1 ORDER BY created_at',
    [batchId],
  )
  return rows.map(toRow)
}

export async function findAuditById(sql: SqlExecutor, id: string): Promise<RecoveryAuditRow | null> {
  const { rows } = await sql.query<RecoveryAuditDbRow>('SELECT * FROM recovery_audit WHERE id = $1', [id])
  return rows[0] === undefined ? null : toRow(rows[0])
}

export interface ListAuditFilters {
  readonly limit: number
  readonly chosenAction?: string
  readonly executionMode?: ExecutionMode
  readonly batchId?: string
}

/** D10's audit table: most recent rows first, optionally filtered by chosen
 * action, execution mode, or batch — the three facets the table's own filter
 * controls expose. Built with plain interpolated `WHERE` clauses assembled from
 * a fixed allowlist of columns (never raw user text), since every filter value
 * here is either an enum this repo itself defines or a UUID validated upstream. */
export async function listRecent(
  sql: SqlExecutor,
  filters: ListAuditFilters,
): Promise<readonly RecoveryAuditRow[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filters.chosenAction !== undefined) {
    params.push(filters.chosenAction)
    conditions.push(`chosen_action = $${params.length}`)
  }
  if (filters.executionMode !== undefined) {
    params.push(filters.executionMode)
    conditions.push(`execution_mode = $${params.length}`)
  }
  if (filters.batchId !== undefined) {
    params.push(filters.batchId)
    conditions.push(`batch_id = $${params.length}`)
  }
  params.push(filters.limit)
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  // LEFT JOIN, not INNER: a batch-replay row can carry a transaction that was never
  // upserted, and dropping audit rows from the ledger to gain a label would be a bad
  // trade. `ra.*` keeps every existing column exactly as it was.
  //
  // The filter columns above (event_id, execution_mode, batch_id, chosen_action,
  // outcome) exist only on recovery_audit, so none of them is ambiguous under the join
  // and the WHERE clause needs no rewriting. `created_at` IS on both tables, which is
  // why the ORDER BY is qualified.
  const { rows } = await sql.query<RecoveryAuditDbRow>(
    `SELECT ra.*, t.scenario
       FROM recovery_audit ra
       LEFT JOIN transactions t ON t.id = ra.transaction_id
     ${where}
     ORDER BY ra.created_at DESC
     LIMIT $${params.length}`,
    params,
  )
  return rows.map(toRow)
}

/** The distinct chosen actions and execution modes actually present, for the
 * audit table's filter dropdowns — never a hardcoded action list, since a
 * second scenario (D12) will introduce its own action vocabulary. */
export async function listDistinctFacets(
  sql: SqlExecutor,
): Promise<{ readonly actions: readonly string[]; readonly executionModes: readonly string[] }> {
  const [actionsResult, modesResult] = await Promise.all([
    sql.query<{ chosen_action: string }>('SELECT DISTINCT chosen_action FROM recovery_audit ORDER BY chosen_action'),
    sql.query<{ execution_mode: string }>('SELECT DISTINCT execution_mode FROM recovery_audit ORDER BY execution_mode'),
  ])
  return {
    actions: actionsResult.rows.map((r) => r.chosen_action),
    executionModes: modesResult.rows.map((r) => r.execution_mode),
  }
}
