-- Closes a real, named gap in src/app/worker/live-features.ts: `bank_recent_fail_rate`
-- was hardcoded to a fixed prior because "the D2 schema has no `bank` column on
-- `transactions`, so there is nothing to compute a per-bank rolling rate from." A
-- real netbanking/UPI payment entity carries a `bank` field
-- (src/domain/webhooks/envelope.ts's `ExtractedFacts.bank`) — it was extracted and
-- then discarded. This closes it the same way 0007_card_id.sql closed the
-- equivalent gap for card-based risk signals.
--
-- Set once at first INSERT, never overwritten on a later UPSERT for the same
-- transaction — identical treatment to card_id and created_at, for the identical
-- reason: a payment's bank does not change across its own retry sequence.
alter table transactions add column bank text;
create index transactions_bank_idx on transactions (bank) where bank is not null;
