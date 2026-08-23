-- Batch runs, for the streamed batch execution and the policy simulator
-- (BUILD_PLAN.md §1.4 additions 1 and 2).
--
-- `policy` records the cost table / threshold variant a run was executed under, in
-- full, so a simulator run and a baseline run can each point back at exactly what
-- economics produced their numbers without depending on code that may have changed
-- since.

create table batches (
  id            uuid primary key,
  scenario      text not null,
  kind          text not null default 'live',   -- 'live' | 'simulation'
  status        text not null default 'running', -- running | done | failed
  total         int not null default 0,
  claimed       int not null default 0,
  done          int not null default 0,
  failed        int not null default 0,
  policy        jsonb,
  baseline_batch_id uuid references batches(id),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
