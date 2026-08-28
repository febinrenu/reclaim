-- Gives `ESCALATE_HUMAN` a recipient.
--
-- The gap this closes was real and structural, not a rough edge: `decide()` could
-- choose `ESCALATE_HUMAN`, the risk gate could *force* it, `recovery_audit` recorded
-- it — and then nothing happened. `src/ports/executor.ts` has no side effect for that
-- action, so a decision to involve a human produced no work item, no assignee, no
-- deadline, and no way to record what the human found. Track 03's bar asks for
-- "compliant escalation"; an escalation with no recipient is not one.
--
-- Design notes, each mirroring a decision made elsewhere in this schema rather than
-- inventing a new convention:
--
--   * `UNIQUE (event_id, attempt_generation)` is the same idempotency authority
--     `recovery_audit` uses (0003_audit.sql). The row is written inside T4's existing
--     transaction, so a crash-and-reclaim between T3 and T4 can never produce two work
--     items for one decision — the constraint makes that a schema fact rather than an
--     application-level check that could be wrong.
--
--   * `status` transitions are open -> claimed -> resolved, and every transition is a
--     conditional UPDATE that names the expected current status in its WHERE clause and
--     returns the row. Two operators pressing Claim at the same instant is therefore
--     settled by the database, not by a read-then-write in application code, for the
--     same reason `incrementRetryCount` became one atomic statement after the real race
--     documented in docs/INCIDENTS.md.
--
--   * `resolution` is deliberately a small closed vocabulary rather than free text. It
--     is the one column in this schema that carries a HUMAN-OBSERVED outcome, which
--     makes it the only label in the entire project that does not come from the
--     synthetic generator. `docs/EVALUATION.md` is explicit that every metric so far
--     rests on the DGP's own draws; these rows are the beginning of an answer to that,
--     so their shape needs to survive being aggregated later.
--
--   * `sla_due_at` is stored, not computed on read, so a queue's overdue set is a plain
--     indexed comparison and does not depend on the reader agreeing with the writer
--     about what the SLA was at the time the work item was created.

create table escalations (
  id                    uuid primary key,
  event_id              text not null,
  attempt_generation    int not null default 1,
  transaction_id        text references transactions(id),
  customer_id           text references customers(id),
  amount_paise          bigint not null,

  -- Why a human is involved. 'risk_gated' means the risk gate fired and made every
  -- non-escalation action structurally infeasible; 'stopping_rule' means retries were
  -- exhausted; 'economic' means escalation genuinely won on expected value. Distinct
  -- because they need different handling and different SLAs, and because collapsing
  -- them would throw away the most useful thing the queue knows about each item.
  reason                text not null,
  risk_score            numeric,
  rationale             text,

  status                text not null default 'open',   -- open | claimed | resolved
  assignee              text,
  claimed_at            timestamptz,
  sla_due_at            timestamptz not null,

  -- paid | promised_to_pay | disputed | uncontactable | written_off
  resolution            text,
  resolution_note       text,
  resolved_at           timestamptz,

  created_at            timestamptz not null default now(),

  constraint escalations_event_generation_uq unique (event_id, attempt_generation),
  constraint escalations_status_chk check (status in ('open', 'claimed', 'resolved')),
  constraint escalations_reason_chk check (reason in ('risk_gated', 'stopping_rule', 'economic')),
  constraint escalations_resolution_chk check (
    resolution is null
    or resolution in ('paid', 'promised_to_pay', 'disputed', 'uncontactable', 'written_off')
  ),
  -- A resolved row must say what the resolution was, and an unresolved row must not
  -- pretend to have one. Enforced here so the queue's own reporting cannot be skewed by
  -- a half-written row.
  constraint escalations_resolved_shape_chk check (
    (status = 'resolved' and resolution is not null and resolved_at is not null)
    or (status <> 'resolved' and resolution is null and resolved_at is null)
  )
);

-- The queue's own read pattern: oldest-deadline-first among unresolved work.
create index escalations_queue_idx on escalations (status, sla_due_at)
  where status in ('open', 'claimed');

-- For joining a customer's history back onto their escalations.
create index escalations_customer_idx on escalations (customer_id)
  where customer_id is not null;
