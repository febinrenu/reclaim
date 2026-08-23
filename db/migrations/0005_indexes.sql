-- Indexes split into their own migration, after every table exists, so each one is a
-- single clear statement rather than being buried inline in a create-table migration.

create index transactions_customer_id_idx on transactions (customer_id);
create index transactions_status_idx on transactions (status);
create index transactions_scenario_idx on transactions (scenario);

create index job_queue_claim_idx on job_queue (status, available_at);
create index job_queue_lease_idx on job_queue (lease_expires_at) where status = 'claimed';

create index action_attempts_transaction_id_idx on action_attempts (transaction_id);

create index recovery_audit_transaction_id_idx on recovery_audit (transaction_id);
create index recovery_audit_batch_id_idx on recovery_audit (batch_id);
create index recovery_audit_created_at_idx on recovery_audit (created_at);

create index webhook_events_received_at_idx on webhook_events (received_at);

create index kv_expires_at_idx on kv (expires_at) where expires_at is not null;
