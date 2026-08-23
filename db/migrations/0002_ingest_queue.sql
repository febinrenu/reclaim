-- Ingestion, the queue, action attempts, and the Postgres-backed KV port.
--
-- webhook_events is the idempotency authority (BUILD_PLAN.md §5.1 A1): a UNIQUE
-- constraint in the same transaction as the write, not a lock in a second datastore.
-- `event_id primary key` plus `insert ... on conflict (event_id) do nothing` in T1 is
-- what makes double-delivery structurally impossible to double-process, independent of
-- whatever the KV port says.
--
-- job_queue is the durable queue (BUILD_PLAN.md §5.7): always Postgres, drained by
-- `FOR UPDATE SKIP LOCKED`, with a lease so a crashed worker's claim expires and is
-- picked up again rather than stuck forever.
--
-- action_attempts is the T3 INTENT row (BUILD_PLAN.md §5.6): committed *before* any
-- side effect, keyed on an idempotency key derived from (event, action, generation), so
-- a reclaim after a crash between T3 and T4 can tell "did we already try this" from
-- "this is fresh" without re-executing blindly.

create table webhook_events (
  event_id              text primary key,
  event_type            text not null,
  payload               jsonb not null,
  received_at           timestamptz not null default now()
);

create table job_queue (
  id                    uuid primary key,
  kind                  text not null,
  -- Enqueue-time dedupe, e.g. 'evt:<eventId>'. Nullable: not every job kind needs one.
  dedupe_key            text unique,
  payload               jsonb not null,
  status                text not null default 'pending',   -- pending | claimed | done | failed
  attempts              int not null default 0,
  available_at          timestamptz not null default now(),
  locked_by             text,
  locked_at             timestamptz,
  lease_expires_at      timestamptz,
  last_error            text,
  -- Set by queue.complete(tx, jobId, result). See src/ports/queue.ts (D6).
  result                jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table action_attempts (
  id                    uuid primary key,
  transaction_id        text references transactions(id),
  event_id              text references webhook_events(event_id),
  action                text not null,
  attempt_generation    int not null default 1,
  -- sha256(eventId|action|attemptGeneration). The reclaim path looks this up to decide
  -- "already intended" versus "safe to recompute". See BUILD_PLAN.md §5.6's crash matrix.
  idempotency_key       text not null unique,
  execution_mode        text not null,                     -- dry_run | live
  status                text not null default 'pending',    -- pending | settled | failed
  request_body          jsonb,
  result                jsonb,
  reconciliation_required boolean not null default false,
  created_at            timestamptz not null default now(),
  settled_at            timestamptz
);

-- The KV port's Postgres adapter (src/adapters/kv/postgres.ts). Never the idempotency
-- authority — see src/ports/kv.ts — but durable and shared across processes, which is
-- what makes it the zero-credential default rather than an in-memory fallback.
create table kv (
  key                   text primary key,
  value                 text not null,
  expires_at            timestamptz
);
