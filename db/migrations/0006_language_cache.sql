-- The language cache (BUILD_PLAN.md §5.8 point 2): keyed on a hash of scenario,
-- action, locale, tone, template version, and bucketed facts, so a batch of a few
-- hundred events collapses to roughly a few dozen distinct keys. A table rather
-- than the KV port deliberately: it must survive restarts and be shared across
-- worker processes, and it is never the idempotency authority (nothing here is —
-- see src/ports/kv.ts), so a cold or wiped cache is only ever a cost concern, not
-- a correctness one.

create table language_cache (
  cache_key         text primary key,
  message           text not null,
  tone              text not null,
  confidence        numeric not null,
  template_version  text not null,
  created_at        timestamptz not null default now()
);

create index language_cache_created_at_idx on language_cache (created_at);
