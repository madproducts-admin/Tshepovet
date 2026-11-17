-- =============================================================================
-- 0007 - The staff console (docs/PLAN.md M8)
--
-- Staff work across tenants, so the API reads and changes platform records for them through
-- a separate connection (STAFF_DATABASE_URL, the BYPASSRLS jobs login), never through the
-- tenant-scoped API role. Every staff change is written to the affected tenant's audit chain
-- as a 'tshepovet_staff' action, which the tenant sees as "TshepoVet support".
--
-- The review queue needs to say why a document is waiting, and who decided it.
-- =============================================================================
BEGIN;

ALTER TABLE vendor_documents
  ADD COLUMN review_flags      text[] NOT NULL DEFAULT '{}',   -- post-validation flags (why it needs a person)
  ADD COLUMN reviewed_at       timestamptz,
  ADD COLUMN reviewed_by_staff uuid REFERENCES staff_users(id),
  ADD COLUMN review_note       text CHECK (length(review_note) <= 500);
CREATE INDEX idx_vendor_documents_review ON vendor_documents (created_at) WHERE review_status = 'needs_review';

COMMIT;
