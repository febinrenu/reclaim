-- The audit trail and the evaluation receipts.
--
-- recovery_audit is the one table a stranger should be able to read raw and understand
-- the whole system from (SYSTEM_SPEC.md §8). Two corrections from BUILD_PLAN.md land
-- here:
--
--   * `decision_input` is the `DecisionInput` persisted verbatim (§5.1 A3) — never the
--     source rows, which mutate. This is what lets the policy simulator replay a stored
--     batch under a different policy with zero I/O.
--   * `UNIQUE (event_id, attempt_generation)` makes the spec's second invariant
--     ("never two audit rows for one event-generation") a schema fact rather than an
--     assertion that could be wrong. See the crash matrix in BUILD_PLAN.md §5.6.
--
-- `ev_milli` / `uplift_milli` are separate columns (not just members of the jsonb
-- breakdown) because BUILD_PLAN.md §6.1 correction 1 makes `EV(DO_NOTHING)` a real,
-- reportable, non-zero number, and both need to be queryable and aggregatable without
-- unpacking jsonb on every row.

create table recovery_audit (
  id                      uuid primary key,
  event_id                text not null,
  attempt_generation      int not null default 1,
  transaction_id          text references transactions(id),
  batch_id                uuid,
  decision_input          jsonb not null,
  p_recover               numeric,
  risk_score              numeric,
  ev_breakdown            jsonb,
  chosen_action           text not null,
  rationale               text,
  ev_milli                bigint,
  uplift_milli            bigint,
  llm_source              text,             -- 'llm' | 'cache' | 'template'
  llm_prompt_tokens       int,
  llm_completion_tokens   int,
  llm_cost_milli          bigint,
  decision_latency_ms     int,
  execution_mode          text not null default 'dry_run',
  outcome                 text,             -- 'success' | 'failed' | 'pending' | 'skipped' | 'unknown'
  reconciliation_required boolean not null default false,
  created_at              timestamptz not null default now(),

  constraint recovery_audit_event_generation_uq unique (event_id, attempt_generation)
);

-- Held-out evaluation results, written once per model version, not per transaction.
-- This table existing at all is the receipt that evaluation happened rather than being
-- eyeballed. See BUILD_PLAN.md §6.
create table model_evaluations (
  id                        uuid primary key,
  model_name                text not null,
  eval_set_size             int,
  brier_score               numeric,
  -- Named "_score" rather than the bare SQL terms: `precision` is a non-reserved
  -- keyword in Postgres (used in `numeric(precision, scale)`) and best avoided as a
  -- bare column name rather than relied on to parse correctly in every clause.
  precision_score           numeric,
  recall_score              numeric,
  false_positive_cost_milli bigint,
  notes                     text,
  created_at                timestamptz not null default now()
);
