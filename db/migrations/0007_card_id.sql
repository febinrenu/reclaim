-- Closes the D11 TODO left in src/app/worker/process-event.ts ("real risk signals
-- need card-fingerprint tracking, not built for the live path yet"): a nullable
-- risk-identity column so the live worker can actually compute
-- cardVelocityHigh/cardFirstSeenRecently against real transaction history instead
-- of hardcoding both to false forever.
--
-- Set once, at first INSERT, never overwritten on a later UPSERT for the same
-- transaction — see src/repositories/transactions.repo.ts's upsertTransaction,
-- same treatment as created_at. A payment's card identity does not change across
-- its own retry sequence; it can differ between two DIFFERENT transaction ids for
-- the same customer (a replacement card), which is exactly what this column is
-- for tracking.
alter table transactions add column card_id text;
create index transactions_card_id_idx on transactions (card_id) where card_id is not null;
