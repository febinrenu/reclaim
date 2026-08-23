-- Customers, transactions, and the oracle ground-truth table.
--
-- Two corrections from SYSTEM_SPEC.md §8, both load-bearing (see BUILD_PLAN.md §5.1 A4
-- and the D1/D2 handoff):
--
--   1. Money is `_paise` integer columns, never `numeric`. A float round-trip through a
--      JS client can put 12.399999999999998 on screen, which the money module exists to
--      prevent everywhere else; the schema has to hold up its end of that.
--
--   2. `transactions` carries no `event_id` column and no uniqueness on one. One
--      transaction receives many webhook events over its life (failed, then retried,
--      then recovered), so a unique event_id on this table makes the second event
--      unrepresentable. Event identity lives entirely in `webhook_events` (0002).
--
-- IDs are `text` rather than `uuid` for `customers` and `transactions` because both are
-- externally supplied identifiers (a Razorpay customer/payment id, or an invoice id in
-- the receivables scenario) — never generated here.

create table customers (
  id                    text primary key,
  name                  text,
  phone                 text,
  email                 text,
  ltv_amount_paise      bigint not null default 0,
  successful_payments   int not null default 0,
  failed_payments       int not null default 0,
  risk_score            numeric not null default 0,
  created_at            timestamptz not null default now()
);

create table transactions (
  id                    text primary key,
  customer_id           text references customers(id),
  amount_paise          bigint not null,
  currency              text not null default 'INR',
  scenario              text not null default 'subscription',
  status                text not null,
  error_code            text,
  error_description     text,
  event_created_at      timestamptz,
  retry_count           int not null default 0,
  created_at            timestamptz not null default now()
);

-- Oracle counterfactuals (BUILD_PLAN.md §6.3, Track B). Written by the data generator,
-- never read by the training or serving path — see eval/test_oracle_firewall.py (D4) and
-- the leakage test that forbids `ground-truth.repo.ts` from being imported by
-- `src/app/worker/**`. `payload` is deliberately jsonb rather than typed columns because
-- its shape belongs to the generator (D4) and must not force a migration to change.
create table ground_truth (
  transaction_id        text primary key references transactions(id),
  payload               jsonb not null,
  created_at            timestamptz not null default now()
);
