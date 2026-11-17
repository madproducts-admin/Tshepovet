-- =============================================================================
-- 0006 - Background jobs (docs/PLAN.md M7)
--
-- * Verifications survive a restart. What is needed to run the checks again is kept with the
--   verification, encrypted, until it is final; whoever runs it (the API inside its sync
--   deadline, or a worker) holds a short claim. The watchdog resumes one whose claim lapsed.
-- * Commits wake the worker: an insert into the webhook or email outbox raises NOTIFY on
--   'tv_jobs' (delivered only when the transaction commits), so nothing polls for new rows.
-- * Monitoring is charged monthly per supplier and modules renew from the wallet; a failed
--   charge is remembered so it is retried and, after a grace week, ends the service.
-- * The sandbox WhatsApp Graph client records what the bot would have sent.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- Durable verifications
-- -----------------------------------------------------------------------------
ALTER TABLE verifications
  ADD COLUMN resume_enc    bytea,                       -- the input (with any PIN), encrypted; cleared when final
  ADD COLUMN claimed_until timestamptz,                 -- the API or a worker is running it until then
  ADD COLUMN run_attempts  integer NOT NULL DEFAULT 0;  -- runs started by workers
CREATE INDEX idx_verifications_processing ON verifications (requested_at) WHERE status = 'processing';

-- -----------------------------------------------------------------------------
-- Wake-ups on commit
-- -----------------------------------------------------------------------------
CREATE FUNCTION notify_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('tv_jobs', TG_ARGV[0]);
  RETURN NULL;
END $$;

CREATE TRIGGER trg_webhook_deliveries_new AFTER INSERT ON webhook_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION notify_jobs('webhooks');
-- A replay from the dashboard makes a delivery due now; the dispatcher's own retries are in
-- the future and wake it by timer instead.
CREATE TRIGGER trg_webhook_deliveries_due AFTER UPDATE ON webhook_deliveries
  FOR EACH ROW WHEN (NEW.status IN ('pending', 'failed') AND NEW.next_attempt_at <= now()
                     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.next_attempt_at IS DISTINCT FROM NEW.next_attempt_at))
  EXECUTE FUNCTION notify_jobs('webhooks');
CREATE TRIGGER trg_email_outbox_new AFTER INSERT ON email_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION notify_jobs('email');

-- -----------------------------------------------------------------------------
-- Monitoring charges and module renewals
-- -----------------------------------------------------------------------------
INSERT INTO ledger_accounts (tenant_id, code, kind)
SELECT NULL, 'revenue_monitoring', 'revenue'
 WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE tenant_id IS NULL AND code = 'revenue_monitoring');

-- Re-checks run by monitoring are covered by its monthly fee.
INSERT INTO price_book (sku, description, billing_type, unit_price_cents, effective_from) VALUES
  ('MONITORING_RECHECK', 'Company re-check run by monitoring (covered by the monthly fee)', 'usage', 0, '2026-01-01');

ALTER TABLE monitoring_enrolments ADD COLUMN unpaid_since date;   -- the month's charge failed (no funds)
ALTER TABLE subscriptions ADD COLUMN past_due_since date;         -- the renewal failed (no funds)

-- -----------------------------------------------------------------------------
-- The sandbox WhatsApp Graph client's record (the staff simulator shows it, M8)
-- -----------------------------------------------------------------------------
CREATE TABLE wa_sandbox_messages (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  msisdn_bidx  bytea NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('out', 'in')),
  kind         text NOT NULL CHECK (kind IN ('text', 'buttons', 'list', 'template', 'media')),
  body         jsonb NOT NULL,   -- what was sent: text, button titles; never an identifier
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wa_sandbox_messages ON wa_sandbox_messages (msisdn_bidx, id);
REVOKE ALL ON wa_sandbox_messages FROM tshepovet_app;
GRANT SELECT, INSERT, DELETE ON wa_sandbox_messages TO tshepovet_worker;

COMMIT;
