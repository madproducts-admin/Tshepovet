-- =============================================================================
-- 0004 - The buyer portal API (docs/PLAN.md M3)
--
-- * Checks run from the portal are requested by a signed-in user, not an API key.
-- * Consent captured in the portal is a web checkbox shown against a web-channel notice.
-- * Sandbox top-ups credit the wallet at once and get a tax invoice number.
-- * Webhook signing secrets rotate with an overlap: the previous secret keeps signing for
--   24 hours, so a receiver can switch without dropping deliveries.
-- * The B-BBEE module keeps procurement spend per supplier; the supplier list keeps saved views.
-- * The API role may only change an organisation's profile and settings, never its status.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- Who asked for a check: an API key (/v1) or a portal user (/api), never both.
-- -----------------------------------------------------------------------------
ALTER TABLE verifications ADD COLUMN requested_by_user uuid REFERENCES tenant_users(id);
ALTER TABLE verifications ADD CONSTRAINT verifications_one_requester
  CHECK (requested_by_api_key IS NULL OR requested_by_user IS NULL);

-- -----------------------------------------------------------------------------
-- Privacy notices for consent captured in the portal (channel 'web').
-- -----------------------------------------------------------------------------
INSERT INTO privacy_notices (code, version, language, channel, body, body_sha256, effective_from)
SELECT code, 1, 'en', 'web', body, sha256(convert_to(body, 'UTF8')), '2026-11-01'
FROM (VALUES
  ('company_verification',
   'Your organisation (the responsible party) will use TshepoVet (its operator) to verify this supplier''s registration, directors, VAT status and, where the supplier gave you a SARS Tax Compliance PIN, its tax compliance status, in order to decide whether to contract with and pay the supplier. If you turn on monitoring, TshepoVet keeps re-checking these facts and the supplier''s document expiry dates while the supplier remains yours. Information is obtained from the CIPC register, SARS and licensed data bureaus in South Africa. Supplying the PIN is voluntary; without it tax compliance cannot be confirmed. Results are kept for the duration of the business relationship plus five years. The supplier may request access to or correction of its information, object to processing, or lodge a complaint with the Information Regulator (inforeg.org.za).'),
  ('driver_verification',
   'Your organisation will use TshepoVet to confirm that this driver''s licence and professional driving permit are valid for the vehicles they will operate. TshepoVet checks the national traffic register through a licensed data provider in South Africa. The check is required to drive on your contracts; the driver may refuse, in which case they cannot be assigned to them. Results are kept while the driver is assigned plus five years. The driver may request access or correction, object, and complain to the Information Regulator (inforeg.org.za).')
) AS n(code, body);

-- -----------------------------------------------------------------------------
-- Sandbox top-ups (credited at once, through the same ledger path as a real payment).
-- -----------------------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'wallet_topups'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%payment_provider%';
  EXECUTE format('ALTER TABLE wallet_topups DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE wallet_topups ADD CONSTRAINT wallet_topups_payment_provider_check
  CHECK (payment_provider IN ('payfast','ozow','peach','eft','card_on_file','manual','sandbox'));
ALTER TABLE wallet_topups ADD COLUMN requested_by uuid REFERENCES tenant_users(id);
CREATE INDEX idx_wallet_topups_tenant_time ON wallet_topups (tenant_id, created_at DESC);

-- Tax invoice numbers: one gap-free-enough series for the platform (TV-000001, ...).
CREATE SEQUENCE tax_invoice_seq;
GRANT USAGE ON SEQUENCE tax_invoice_seq TO tshepovet_app, tshepovet_worker;

-- -----------------------------------------------------------------------------
-- Webhook endpoints: a label, who made it, and the rotation overlap.
-- -----------------------------------------------------------------------------
ALTER TABLE webhook_endpoints
  ADD COLUMN description                 text CHECK (length(description) <= 200),
  ADD COLUMN created_by                  uuid REFERENCES tenant_users(id),
  ADD COLUMN previous_secret_enc         bytea,       -- AAD webhook_secret:<tenant>, like secret_enc
  ADD COLUMN previous_secret_expires_at  timestamptz,
  ADD COLUMN secret_rotated_at           timestamptz;
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, id DESC);

-- -----------------------------------------------------------------------------
-- B-BBEE module: measured procurement spend per supplier and period.
-- -----------------------------------------------------------------------------
CREATE TABLE bbbee_spend (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  tenant_vendor_id  uuid NOT NULL REFERENCES tenant_vendors(id),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),   -- VAT-exclusive spend
  description       text CHECK (length(description) <= 200),
  created_by        uuid REFERENCES tenant_users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_bbbee_spend_tenant_period ON bbbee_spend (tenant_id, period_start, period_end);
CREATE INDEX idx_bbbee_spend_vendor ON bbbee_spend (tenant_vendor_id);

-- -----------------------------------------------------------------------------
-- Saved views (a named set of list filters, private to the user who saved it).
-- -----------------------------------------------------------------------------
CREATE TABLE saved_views (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES tenant_users(id),
  scope       text NOT NULL CHECK (scope IN ('suppliers','checks')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  query       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, name)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bbbee_spend','saved_views'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I TO tshepovet_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO tshepovet_worker', t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- API keys: "last used", recorded by /v1 authentication in one round trip and at most once
-- a minute per key. Like authenticate_api_key(), it runs before the tenant is known.
-- -----------------------------------------------------------------------------
CREATE FUNCTION touch_api_key(p_key uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE api_keys SET last_used_at = now()
   WHERE id = p_key AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
$$;
REVOKE EXECUTE ON FUNCTION touch_api_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_api_key(uuid) TO tshepovet_app;

-- -----------------------------------------------------------------------------
-- An organisation's status (active / suspended / closed) is the platform's to change.
-- -----------------------------------------------------------------------------
REVOKE UPDATE ON tenants FROM tshepovet_app;
GRANT UPDATE (legal_name, cipc_enterprise_number, vat_number, information_officer_email, is_public_sector, settings)
  ON tenants TO tshepovet_app;

COMMIT;
