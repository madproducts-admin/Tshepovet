-- =============================================================================
-- TshepoVet - core schema (PostgreSQL 16+)
--
-- Design principles
--   * Multi-tenant: every buyer-owned row carries tenant_id and is protected by
--     Row-Level Security (RLS). The API connects as role `tshepovet_app`
--     (no BYPASSRLS) and sets `app.tenant_id` per transaction (SET LOCAL).
--   * Vendor Passports are GLOBAL: one row per legal entity, shared across buyers
--     only through `tenant_vendors` (buyer relationship) or `vendor_passport_shares`
--     (the vendor's own instruction to share). Tenants never see vendors they
--     have no relationship with.
--   * PII minimisation: identifiers (SA ID, tax refs, bank accounts, MSISDNs,
--     TCS PINs) are stored ONLY as application-side envelope-encrypted bytea
--     (`*_enc`) plus a keyed HMAC "blind index" (`*_bidx`) for equality lookups.
--     The database never sees plaintext.
--   * Money is integer ZAR cents, VAT-exclusive, in a double-entry ledger.
--   * Every row with personal information has a `purge_after` driven by
--     `ref_retention_policies` (POPIA s14).
--   * The audit log is append-only and hash-chained per tenant.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy name matching (ghost-supplier radar)
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints on monitoring periods

-- -----------------------------------------------------------------------------
-- Roles. NOLOGIN group roles; real login roles are granted membership.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tshepovet_app') THEN
    CREATE ROLE tshepovet_app NOLOGIN;            -- API: RLS enforced
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tshepovet_worker') THEN
    CREATE ROLE tshepovet_worker NOLOGIN BYPASSRLS; -- system jobs: purge, dispatch, monitoring
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Time-ordered UUIDv7 (better B-tree locality than v4 for high-insert tables).
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
           set_bit(set_bit(
             overlay(uuid_send(gen_random_uuid())
                     PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                     FROM 1 FOR 6),
           52, 1), 53, 1),
         'hex')::uuid;
$$;

-- Tenant context set by the API with: SET LOCAL app.tenant_id = '<uuid>'
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =============================================================================
-- 1. REFERENCE DATA (seeded in 0002; owned by the compliance team, not code)
-- =============================================================================

-- CIPC enterprise-number suffix -> entity type (YYYY/NNNNNN/TT).
CREATE TABLE ref_cipc_entity_types (
  code            char(2) PRIMARY KEY,
  name            text NOT NULL,
  abbreviation    text,
  has_directors   boolean NOT NULL DEFAULT true,   -- CCs have members, co-ops have board members
  notes           text
);

-- B-BBEE size thresholds per Codes of Good Practice / sector code. Kept as data
-- because sector codes differ (e.g. Construction BEPs, Tourism, ICT) and the dtic
-- revises thresholds by gazette. `verified=false` rows must not be used for
-- automatic EME/QSE classification.
CREATE TABLE ref_bbbee_thresholds (
  id                       serial PRIMARY KEY,
  sector_code              text NOT NULL,            -- 'generic', 'construction_contractor', 'construction_bep', 'tourism', 'ict', ...
  eme_max_turnover_cents   bigint NOT NULL,
  qse_max_turnover_cents   bigint NOT NULL,
  effective_from           date NOT NULL,
  effective_to             date,
  gazette_reference        text NOT NULL,
  verified                 boolean NOT NULL DEFAULT false,
  CHECK (qse_max_turnover_cents > eme_max_turnover_cents),
  UNIQUE (sector_code, effective_from)
);

CREATE TABLE ref_bbbee_recognition_levels (
  level                        smallint PRIMARY KEY CHECK (level BETWEEN 0 AND 8), -- 0 = non-compliant
  procurement_recognition_pct  numeric(5,2) NOT NULL
);

-- Document types and their expiry behaviour.
CREATE TABLE ref_document_types (
  code                     text PRIMARY KEY,
  name                     text NOT NULL,
  default_validity_months  integer,                 -- NULL = expiry must be read from the document
  reminder_offsets_days    integer[] NOT NULL DEFAULT '{30,14,7,0}',
  lock_grace_days          integer NOT NULL DEFAULT 0,  -- days after expiry before the ERP payment lock fires
  contains_special_pi      boolean NOT NULL DEFAULT false, -- POPIA s26 (race, biometrics, health, criminal)
  image_retention_days     integer NOT NULL DEFAULT 90   -- raw image/PDF kept for review & disputes only
);

-- Regulator-announced grace periods (e.g. driving-licence card backlog extensions).
CREATE TABLE ref_regulatory_grace_periods (
  id                 serial PRIMARY KEY,
  document_type      text NOT NULL REFERENCES ref_document_types(code),
  expired_from       date NOT NULL,
  expired_to         date NOT NULL,
  valid_until        date NOT NULL,
  authority          text NOT NULL,
  gazette_reference  text NOT NULL,
  CHECK (expired_to >= expired_from)
);

-- POPIA s14 retention schedule per data category.
CREATE TABLE ref_retention_policies (
  data_category     text PRIMARY KEY,
  retention_days    integer NOT NULL CHECK (retention_days > 0),
  clock_starts      text NOT NULL CHECK (clock_starts IN ('created','relationship_end','expiry','last_activity')),
  legal_basis_note  text NOT NULL
);

-- =============================================================================
-- 2. TENANCY & ACCESS
-- =============================================================================

CREATE TABLE tenants (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  legal_name               text NOT NULL,
  cipc_enterprise_number   text,
  vat_number               text,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  is_public_sector         boolean NOT NULL DEFAULT false,  -- PFMA/MFMA buyers: CSD number mandatory
  information_officer_email citext,
  data_region              text NOT NULL DEFAULT 'za',       -- POPIA s72: keep processing in-country by default
  settings                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_users (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         citext NOT NULL,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','admin','compliance_officer','procurement','ap_clerk','viewer')),
  can_view_special_pi boolean NOT NULL DEFAULT false,   -- B-BBEE ownership data, biometrics
  mfa_enrolled  boolean NOT NULL DEFAULT false,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  prefix        text NOT NULL UNIQUE,               -- public lookup part, e.g. 'tv_live_8f3k2m1q'
  secret_hash   bytea NOT NULL,                     -- HMAC-SHA256(pepper, full key); keys are 256-bit random
  environment   text NOT NULL CHECK (environment IN ('live','test')),
  scopes        text[] NOT NULL DEFAULT '{verify:write,verify:read}',
  name          text NOT NULL,
  created_by    uuid REFERENCES tenant_users(id),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);

-- =============================================================================
-- 3. VENDOR PASSPORTS (global, vendor-owned)
-- =============================================================================

CREATE TABLE vendors (
  id                        uuid PRIMARY KEY DEFAULT uuid_v7(),
  entity_kind               text NOT NULL CHECK (entity_kind IN (
                              'private_company','public_company','non_profit_company','personal_liability_company',
                              'state_owned_company','external_company','close_corporation','cooperative',
                              'sole_proprietor','partnership','trust','npo_unincorporated','statutory_body','other')),
  -- CIPC enterprise number, normalised to YYYY/NNNNNN/TT (no 'CK' / 'K' prefix).
  cipc_enterprise_number    text UNIQUE CHECK (cipc_enterprise_number ~ '^\d{4}/\d{6}/\d{2}$'),
  cipc_type_code            char(2) REFERENCES ref_cipc_entity_types(code),
  legal_name                text NOT NULL,
  trading_name              text,
  incorporation_date        date,       -- NOT derived from the number's year (CIPC Notice 1 of 2026)
  cipc_status               text,       -- normalised, see domain/sa/cipc.ts
  cipc_status_raw           text,
  annual_return_due_date    date,
  vat_number                text CHECK (vat_number ~ '^4\d{9}$'),
  csd_supplier_number       text CHECK (csd_supplier_number ~ '^MAAA\d{7}$'), -- National Treasury CSD
  master_trust_number       text,       -- e.g. IT1234/2015 (Master of the High Court)
  npo_number                text,       -- DSD NPO number, e.g. 123-456 NPO
  -- Sole proprietors have no CIPC record: the owner's SA ID is the anchor identifier.
  owner_id_number_enc       bytea,
  owner_id_number_bidx      bytea,
  income_tax_ref_enc        bytea,
  income_tax_ref_bidx       bytea,
  registered_address        jsonb,
  address_bidx              bytea,      -- HMAC of normalised address, for ghost-supplier matching
  -- Passport (viral loop)
  passport_public_id        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),
  passport_status           text NOT NULL DEFAULT 'none' CHECK (passport_status IN ('none','active','suspended','revoked')),
  passport_public_fields    text[] NOT NULL DEFAULT '{legal_name,cipc_status,bbbee_level,tcs_status,verified_at}',
  passport_last_verified_at timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (entity_kind <> 'sole_proprietor' OR owner_id_number_bidx IS NOT NULL),
  CHECK (entity_kind IN ('sole_proprietor','partnership','trust','npo_unincorporated','other')
         OR cipc_enterprise_number IS NOT NULL)
);
CREATE TRIGGER trg_vendors_updated BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX uq_vendors_sole_prop ON vendors (owner_id_number_bidx) WHERE entity_kind = 'sole_proprietor';
CREATE INDEX idx_vendors_vat ON vendors (vat_number) WHERE vat_number IS NOT NULL;
CREATE INDEX idx_vendors_address_bidx ON vendors (address_bidx) WHERE address_bidx IS NOT NULL;
CREATE INDEX idx_vendors_name_trgm ON vendors USING gin (legal_name gin_trgm_ops);

-- Directors / CC members (public record via CIPC, still personal information).
CREATE TABLE vendor_directors (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  full_name           text NOT NULL,
  id_number_enc       bytea,                 -- SA ID or passport number
  id_number_bidx      bytea,                 -- GLOBAL blind index: "one person, many vendors" signal
  id_type             text NOT NULL DEFAULT 'sa_id' CHECK (id_type IN ('sa_id','passport','unknown')),
  role                text NOT NULL DEFAULT 'director' CHECK (role IN ('director','alternate_director','member','board_member','trustee','public_officer','company_secretary')),
  status              text NOT NULL CHECK (status IN ('active','resigned','removed','deceased','unknown')),
  appointed_on        date,
  resigned_on         date,
  dha_verified_at     timestamptz,           -- identity confirmed against DHA NPR via bureau
  source_provider     text NOT NULL,
  as_of               timestamptz NOT NULL,
  purge_after         timestamptz
);
CREATE INDEX idx_vendor_directors_vendor ON vendor_directors (vendor_id);
CREATE INDEX idx_vendor_directors_bidx ON vendor_directors (id_number_bidx) WHERE id_number_bidx IS NOT NULL;

-- Beneficial owners (Companies Act s56 / FIC Act; 5% threshold), self-declared or from BO register.
CREATE TABLE vendor_beneficial_owners (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  full_name           text NOT NULL,
  id_number_enc       bytea,
  id_number_bidx      bytea,
  ownership_pct       numeric(5,2) CHECK (ownership_pct BETWEEN 0 AND 100),
  control_type        text CHECK (control_type IN ('shareholding','voting_rights','other_control','trust_beneficiary','founder')),
  source              text NOT NULL CHECK (source IN ('self_declared','cipc_bo_register','bureau')),
  declared_at         timestamptz NOT NULL,
  purge_after         timestamptz
);
CREATE INDEX idx_vendor_bo_vendor ON vendor_beneficial_owners (vendor_id);

CREATE TABLE vendor_contacts (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  full_name                text NOT NULL,
  email                    citext,
  msisdn_enc               bytea,
  msisdn_bidx              bytea,
  role                     text,
  is_authorised_signatory  boolean NOT NULL DEFAULT false,
  authority_basis          text CHECK (authority_basis IN ('director','member','resolution','power_of_attorney','sole_proprietor','unverified')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  purge_after              timestamptz
);
CREATE INDEX idx_vendor_contacts_vendor ON vendor_contacts (vendor_id);
CREATE INDEX idx_vendor_contacts_msisdn ON vendor_contacts (msisdn_bidx) WHERE msisdn_bidx IS NOT NULL;

CREATE TABLE vendor_bank_accounts (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id             uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  bank_name             text NOT NULL,
  universal_branch_code text,
  account_number_enc    bytea NOT NULL,
  account_number_bidx   bytea NOT NULL,
  account_last4         char(4) NOT NULL,
  account_type          text CHECK (account_type IN ('current','savings','transmission','other')),
  avs_status            text CHECK (avs_status IN ('match','partial','no_match','not_checked','error')),
  avs_checked_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  purge_after           timestamptz
);
CREATE INDEX idx_vendor_bank_bidx ON vendor_bank_accounts (account_number_bidx);

-- B-BBEE evidence & computed level (special PI: ownership by race - POPIA s26/s29).
CREATE TABLE vendor_bbbee_profiles (
  id                             uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id                      uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  evidence_document_id           uuid,      -- FK added after vendor_documents
  evidence_type                  text NOT NULL CHECK (evidence_type IN ('eme_affidavit','qse_affidavit','sanas_certificate','cipc_eme_certificate')),
  sector_code                    text NOT NULL DEFAULT 'generic',
  financial_year_end             date,
  annual_turnover_cents          bigint CHECK (annual_turnover_cents >= 0),
  black_ownership_pct            numeric(5,2) CHECK (black_ownership_pct BETWEEN 0 AND 100),
  black_female_ownership_pct     numeric(5,2) CHECK (black_female_ownership_pct BETWEEN 0 AND 100),
  designated_group_ownership_pct numeric(5,2) CHECK (designated_group_ownership_pct BETWEEN 0 AND 100),
  bbbee_level                    smallint REFERENCES ref_bbbee_recognition_levels(level),
  procurement_recognition_pct    numeric(5,2),
  is_empowering_supplier         boolean,
  is_51pct_black_owned           boolean GENERATED ALWAYS AS (black_ownership_pct >= 51) STORED,
  is_30pct_black_female_owned    boolean GENERATED ALWAYS AS (black_female_ownership_pct >= 30) STORED,
  issued_on                      date NOT NULL,
  valid_until                    date NOT NULL,     -- affidavits and certificates: 12 months
  verification_agency            text,
  sanas_accreditation_number     text,               -- e.g. BVA123
  certificate_number             text,
  commissioner_of_oaths          jsonb,              -- name, designation, area, date (affidavits)
  validation_flags               text[] NOT NULL DEFAULT '{}',
  status                         text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','accepted','rejected','expired','superseded')),
  reviewed_by                    uuid,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CHECK (black_female_ownership_pct IS NULL OR black_ownership_pct IS NULL OR black_female_ownership_pct <= black_ownership_pct),
  CHECK (valid_until > issued_on)
);
CREATE INDEX idx_bbbee_vendor ON vendor_bbbee_profiles (vendor_id, valid_until DESC);

-- =============================================================================
-- 4. BUYER <-> VENDOR RELATIONSHIPS (tenant-scoped)
-- =============================================================================

CREATE TABLE tenant_vendors (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  vendor_id              uuid NOT NULL REFERENCES vendors(id),
  external_ref           text,                -- buyer's ERP supplier code
  status                 text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','onboarding','pending_review','approved','rejected','suspended','offboarded')),
  risk_rating            text CHECK (risk_rating IN ('low','medium','high','critical')),
  onboarding_channel     text NOT NULL DEFAULT 'api' CHECK (onboarding_channel IN ('api','portal','whatsapp','csv','passport')),
  industry_profile       text CHECK (industry_profile IN ('general','construction','logistics')),
  approved_by            uuid REFERENCES tenant_users(id),
  approved_at            timestamptz,
  payment_lock_status    text NOT NULL DEFAULT 'unlocked' CHECK (payment_lock_status IN ('unlocked','locked','override')),
  payment_lock_reason    text,
  erp_connection_id      uuid,
  erp_contact_id         text,
  relationship_ended_at  timestamptz,          -- starts FICA/Companies Act retention clocks
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, vendor_id),
  UNIQUE (tenant_id, external_ref)
);
CREATE TRIGGER trg_tenant_vendors_updated BEFORE UPDATE ON tenant_vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_tenant_vendors_vendor ON tenant_vendors (vendor_id);

-- The vendor's instruction to share its passport with another buyer (TshepoVet is
-- the responsible party for the passport; the buyer becomes a recipient).
CREATE TABLE vendor_passport_shares (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id        uuid NOT NULL REFERENCES vendors(id),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  scopes           text[] NOT NULL CHECK (scopes <@ ARRAY['registration','directors','tax','bbbee','bank','documents','licences']::text[]),
  consent_id       uuid NOT NULL,           -- FK added after consent_records
  granted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  revoked_at       timestamptz,
  UNIQUE (vendor_id, tenant_id, granted_at)
);
CREATE INDEX idx_passport_shares_tenant ON vendor_passport_shares (tenant_id) WHERE revoked_at IS NULL;

-- Monitoring enrolments (billed R15 / vendor / month). Exclusion constraint
-- prevents overlapping enrolments for the same relationship.
CREATE TABLE monitoring_enrolments (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  tenant_vendor_id  uuid NOT NULL REFERENCES tenant_vendors(id),
  period            tstzrange NOT NULL,
  erp_lock_enabled  boolean NOT NULL DEFAULT false,
  EXCLUDE USING gist (tenant_vendor_id WITH =, period WITH &&)
);
CREATE INDEX idx_monitoring_tenant ON monitoring_enrolments (tenant_id);

-- HR-sourced employee data for the Conflict-of-Interest / Ghost-Supplier radar.
-- Blind indexes here use a TENANT-SPECIFIC key so identifiers cannot be linked
-- across tenants (POPIA s57(1)(a) prior-authorisation risk minimisation).
CREATE TABLE tenant_employees (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  employee_number       text NOT NULL,
  full_name             text NOT NULL,
  id_number_bidx        bytea,
  bank_account_bidx     bytea,
  msisdn_bidx           bytea,
  address_bidx          bytea,
  department            text,
  is_procurement_role   boolean NOT NULL DEFAULT false,
  employment_status     text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','terminated','suspended')),
  source_batch_id       uuid,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  purge_after           timestamptz,
  UNIQUE (tenant_id, employee_number)
);
CREATE INDEX idx_employees_id_bidx ON tenant_employees (tenant_id, id_number_bidx);
CREATE INDEX idx_employees_bank_bidx ON tenant_employees (tenant_id, bank_account_bidx);
CREATE INDEX idx_employees_name_trgm ON tenant_employees USING gin (full_name gin_trgm_ops);

-- Tenant-keyed projections of vendor identifiers, computed by the COI worker for
-- vendors linked to the tenant, so matching is a tenant-local equi-join.
CREATE TABLE coi_vendor_index (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  source_kind   text NOT NULL CHECK (source_kind IN ('director_id','bo_id','bank_account','msisdn','address')),
  source_id     uuid NOT NULL,
  bidx          bytea NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_kind, source_id)
);
CREATE INDEX idx_coi_vendor_index_bidx ON coi_vendor_index (tenant_id, bidx);

CREATE TABLE coi_matches (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL REFERENCES tenant_employees(id),
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  match_type    text NOT NULL CHECK (match_type IN ('director_id','bo_id','bank_account','msisdn','address','name_fuzzy_plus_address')),
  score         numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','confirmed_declared','confirmed_undeclared','escalated')),
  reviewed_by   uuid REFERENCES tenant_users(id),
  review_notes  text,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, vendor_id, match_type)
);

-- =============================================================================
-- 5. POPIA: NOTICES, CONSENT, LAWFUL BASIS, DATA SUBJECT REQUESTS
-- =============================================================================

-- Exact text shown to the data subject (s18 notification). Immutable; versioned.
CREATE TABLE privacy_notices (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  code            text NOT NULL,            -- 'vendor_onboarding', 'driver_check', 'passport_share'
  version         integer NOT NULL,
  language        text NOT NULL DEFAULT 'en' CHECK (language IN ('en','zu','xh','af','st','tn','nso','ts','ss','ve','nr')),
  channel         text NOT NULL CHECK (channel IN ('whatsapp','web','api','paper')),
  body            text NOT NULL,
  body_sha256     bytea NOT NULL,
  effective_from  timestamptz NOT NULL,
  retired_at      timestamptz,
  UNIQUE (code, version, language, channel)
);

-- One capture event. Immutable (withdrawal is per purpose, below).
CREATE TABLE consent_records (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id             uuid REFERENCES tenants(id),   -- NULL = consent to TshepoVet as responsible party (passport)
  vendor_id             uuid REFERENCES vendors(id),
  subject_type          text NOT NULL CHECK (subject_type IN ('juristic_person','natural_person')),
  subject_role          text NOT NULL CHECK (subject_role IN ('vendor_entity','authorised_representative','director','beneficial_owner','driver','sole_proprietor','employee')),
  subject_ref_bidx      bytea,                 -- blind index of the subject's ID/MSISDN
  subject_display       text NOT NULL,         -- masked, e.g. 'T. M*** (******5083)'
  given_by_contact_id   uuid REFERENCES vendor_contacts(id),
  on_behalf_of_subject  boolean NOT NULL DEFAULT false,  -- e.g. employer attests driver consent
  notice_id             uuid NOT NULL REFERENCES privacy_notices(id),
  capture_method        text NOT NULL CHECK (capture_method IN ('whatsapp_button','whatsapp_flow','web_checkbox','api_attestation','signed_form_upload','email_link','ussd')),
  evidence              jsonb NOT NULL,        -- wa message id, ip, UA, timestamps, attestation text
  evidence_sha256       bytea NOT NULL,        -- hash over canonical evidence + notice hash
  captured_by_api_key   uuid REFERENCES api_keys(id),
  captured_by_user      uuid REFERENCES tenant_users(id),
  granted_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  purge_after           timestamptz
);
CREATE INDEX idx_consent_tenant_vendor ON consent_records (tenant_id, vendor_id);
CREATE INDEX idx_consent_subject ON consent_records (subject_ref_bidx) WHERE subject_ref_bidx IS NOT NULL;

-- Granular, independently withdrawable purposes.
CREATE TABLE consent_purposes (
  consent_id         uuid NOT NULL REFERENCES consent_records(id),
  tenant_id          uuid REFERENCES tenants(id),   -- denormalised for RLS
  purpose            text NOT NULL CHECK (purpose IN (
                       'kyb_company_verification','director_identity_verification','tax_compliance_verification',
                       'driver_licence_verification','bbbee_verification','bank_account_verification',
                       'continuous_monitoring','passport_sharing','conflict_of_interest_screening',
                       'document_ocr_processing','cross_border_processing','whatsapp_service_messages','direct_marketing')),
  lawful_basis       text NOT NULL CHECK (lawful_basis IN ('consent','contract','legal_obligation','legitimate_interest_subject','public_law_duty','legitimate_interest_responsible_party')),
  -- Biometrics (selfie/face match) rely on s27(1)(a) consent; s33 offers no general private-sector exemption.
  special_pi_basis   text CHECK (special_pi_basis IN ('s27_1_a_consent','s27_1_b_legal_right_or_obligation','s29_bbbee_redress')),
  withdrawn_at       timestamptz,
  withdrawal_channel text,
  PRIMARY KEY (consent_id, purpose)
);
CREATE INDEX idx_consent_purposes_tenant ON consent_purposes (tenant_id, purpose) WHERE withdrawn_at IS NULL;

-- Record of Processing Activities (POPIA s17 / PAIA s51 documentation).
CREATE TABLE processing_activities (
  code                text PRIMARY KEY,
  description         text NOT NULL,
  purpose             text NOT NULL,
  lawful_basis        text NOT NULL,
  data_categories     text[] NOT NULL,
  special_pi          boolean NOT NULL DEFAULT false,
  operators           text[] NOT NULL DEFAULT '{}',   -- bureaus, cloud, LLM vendor (s20/s21 agreements)
  cross_border        boolean NOT NULL DEFAULT false,
  cross_border_basis  text,                            -- s72(1)(a)-(e)
  retention_category  text REFERENCES ref_retention_policies(data_category),
  prior_authorisation text                             -- s57 assessment outcome / IR reference
);

CREATE TABLE data_subject_requests (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid REFERENCES tenants(id),
  vendor_id         uuid REFERENCES vendors(id),
  request_type      text NOT NULL CHECK (request_type IN ('access','correction','deletion','objection','withdraw_consent','restrict')),
  requester_display text NOT NULL,
  identity_verified boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received','verifying','in_progress','completed','refused','escalated_to_ir')),
  received_at       timestamptz NOT NULL DEFAULT now(),
  due_at            timestamptz NOT NULL DEFAULT now() + interval '30 days', -- PAIA s25 / POPIA s23
  completed_at      timestamptz,
  outcome_notes     text
);

-- =============================================================================
-- 6. SARS TAX COMPLIANCE STATUS (TCS) PIN VAULT
-- =============================================================================
-- The PIN lets a third party view the taxpayer's live compliance status on
-- eFiling. It is a bearer credential: envelope-encrypted, never logged,
-- de-duplicated by HMAC fingerprint, and purged at expiry / revocation / end of
-- monitoring - whichever comes first.
CREATE TABLE tax_compliance_pins (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id            uuid NOT NULL REFERENCES vendors(id),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),  -- buyer it was disclosed to
  tax_reference_enc    bytea NOT NULL,
  tax_reference_bidx   bytea NOT NULL,
  pin_enc              bytea,                 -- NULL once purged
  pin_fingerprint      bytea NOT NULL,        -- HMAC(pin) for dedupe/lookup
  key_version          integer NOT NULL,
  tcs_type             text CHECK (tcs_type IN ('good_standing','tender','foreign_investment_allowance','emigration','unknown')),
  pin_issued_on        date,
  pin_expires_on       date,                  -- taxpayer-selected at request time; do not assume 12 months
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked','invalid','purged')),
  last_tcs_status      text CHECK (last_tcs_status IN ('compliant','non_compliant','unknown')),
  last_verified_at     timestamptz,
  verification_method  text CHECK (verification_method IN ('efiling_assisted','csd_report','bureau','document_only')),
  purge_after          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, pin_fingerprint)
);
CREATE INDEX idx_tcs_pins_vendor ON tax_compliance_pins (vendor_id);
CREATE INDEX idx_tcs_pins_purge ON tax_compliance_pins (purge_after) WHERE pin_enc IS NOT NULL;

-- =============================================================================
-- 7. DOCUMENTS & EXPIRY SCHEDULES
-- =============================================================================

CREATE TABLE vendor_documents (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id              uuid NOT NULL REFERENCES vendors(id),
  tenant_id              uuid REFERENCES tenants(id),     -- NULL = passport-level (vendor-owned)
  document_type          text NOT NULL REFERENCES ref_document_types(code),
  storage_key            text,                            -- object key (af-south-1, SSE-KMS); NULL after purge
  sha256                 bytea NOT NULL,
  perceptual_hash        bigint,                          -- pHash: same ID photo reused by different vendors = fraud signal
  mime_type              text NOT NULL,
  size_bytes             integer NOT NULL CHECK (size_bytes > 0),
  source_channel         text NOT NULL CHECK (source_channel IN ('whatsapp','portal','api','email')),
  issued_on              date,
  expires_on             date,
  issuer                 text,
  document_number_bidx   bytea,
  extracted_fields       jsonb,                           -- non-sensitive fields only
  extracted_fields_enc   bytea,                           -- ID numbers, names, DOB, etc.
  extraction_confidence  numeric(4,3),
  extraction_model       text,
  review_status          text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','auto_accepted','needs_review','accepted','rejected')),
  rejection_reason       text,
  reviewed_by            uuid REFERENCES tenant_users(id),
  superseded_by          uuid REFERENCES vendor_documents(id),
  image_purge_after      timestamptz NOT NULL,
  record_purge_after     timestamptz,
  purged_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_vendor_docs_vendor ON vendor_documents (vendor_id, document_type);
CREATE INDEX idx_vendor_docs_phash ON vendor_documents (perceptual_hash) WHERE perceptual_hash IS NOT NULL;
CREATE INDEX idx_vendor_docs_image_purge ON vendor_documents (image_purge_after) WHERE storage_key IS NOT NULL;

ALTER TABLE vendor_bbbee_profiles
  ADD CONSTRAINT fk_bbbee_evidence FOREIGN KEY (evidence_document_id) REFERENCES vendor_documents(id);

-- Industry add-on credentials (CIDB grading, COIDA LOGS, licences/PrDP on drivers).
CREATE TABLE vendor_credentials (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_id         uuid NOT NULL REFERENCES vendors(id),
  tenant_id         uuid REFERENCES tenants(id),
  credential_type   text NOT NULL CHECK (credential_type IN ('cidb_grading','coida_letter_of_good_standing','driver_licence','prdp','sanas_accreditation','professional_registration')),
  holder_display    text,                         -- masked natural-person holder (drivers)
  holder_id_bidx    bytea,
  reference_number  text,                         -- CRS number, LOGS number (not personal)
  attributes        jsonb NOT NULL DEFAULT '{}',  -- e.g. {"grade":"7","class":"GB","pe":true} or {"codes":["C1","EC"],"prdp":["G","D"]}
  issuer            text,                         -- 'CIDB', 'Compensation Fund', 'FEM', 'RMA', 'RTMC/eNaTIS'
  valid_from        date,
  valid_until       date,
  status            text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','valid','expired','suspended','not_found','grace_period')),
  verified_at       timestamptz,
  document_id       uuid REFERENCES vendor_documents(id),
  purge_after       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_vendor_credentials_vendor ON vendor_credentials (vendor_id, credential_type);

-- Drives reminders (T-30/T-14/T-7/T-0) and the accounting payment lock (T+grace).
CREATE TABLE expiry_schedules (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  tenant_vendor_id  uuid NOT NULL REFERENCES tenant_vendors(id),
  subject_type      text NOT NULL CHECK (subject_type IN ('document','tcs_pin','bbbee','cipc_annual_return','credential')),
  subject_id        uuid NOT NULL,
  expires_on        date NOT NULL,
  grace_until       date,
  next_action_at    timestamptz,
  next_action       text CHECK (next_action IN ('remind','expire','lock','recheck')),
  reminders_sent    integer[] NOT NULL DEFAULT '{}',   -- offsets already sent, for idempotency
  state             text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','expired','locked','renewed','cancelled')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_vendor_id, subject_type, subject_id)
);
CREATE INDEX idx_expiry_due ON expiry_schedules (next_action_at) WHERE state IN ('scheduled','expired');

-- =============================================================================
-- 8. VERIFICATION ENGINE: PROVIDERS, CALLS, CACHE, VERIFICATIONS
-- =============================================================================

CREATE TABLE providers (
  code                         text PRIMARY KEY,   -- 'xds','cpb','searchworks','verifyid','mock'
  name                         text NOT NULL,
  is_active                    boolean NOT NULL DEFAULT true,
  operator_agreement_signed_on date,                -- POPIA s21 written contract
  data_region                  text NOT NULL DEFAULT 'za',
  notes                        text
);

CREATE TABLE provider_capabilities (
  provider_code      text NOT NULL REFERENCES providers(code),
  capability         text NOT NULL CHECK (capability IN ('company_registration','company_directors','vat_status','tax_compliance_status','driver_licence','prdp','id_verification','bank_account_verification')),
  unit_cost_cents    integer NOT NULL CHECK (unit_cost_cents >= 0),   -- contracted wholesale, excl VAT
  volume_tiers       jsonb NOT NULL DEFAULT '[]',   -- [{"from":0,"cost_cents":450},{"from":50000,"cost_cents":290}]
  prepaid_remaining  integer,                       -- prepaid bundle units: sunk cost, prefer first
  is_live_source     boolean NOT NULL DEFAULT false,-- live CIPC/eNaTIS vs bureau-cached copy
  timeout_ms         integer NOT NULL DEFAULT 4000,
  max_rps            integer,
  daily_quota        integer,
  enabled            boolean NOT NULL DEFAULT true,
  PRIMARY KEY (provider_code, capability)
);

CREATE TABLE provider_calls (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id             uuid REFERENCES tenants(id),
  verification_id       uuid,
  provider_code         text NOT NULL REFERENCES providers(code),
  capability            text NOT NULL,
  attempt_no            smallint NOT NULL,
  outcome               text NOT NULL CHECK (outcome IN ('success','not_found','timeout','error_5xx','error_4xx','rate_limited','circuit_open','skipped_budget')),
  http_status           smallint,
  duration_ms           integer,
  cost_cents            integer NOT NULL DEFAULT 0,
  request_fingerprint   bytea,          -- HMAC of the query; never raw identifiers
  response_enc          bytea,          -- raw bureau payload for disputes, encrypted, short retention
  purge_after           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_calls_verification ON provider_calls (verification_id);
CREATE INDEX idx_provider_calls_cost ON provider_calls (provider_code, created_at);
CREATE INDEX idx_provider_calls_purge ON provider_calls (purge_after) WHERE response_enc IS NOT NULL;

-- L2 cache (L1 is Redis). scope='global' rows hold public-register data that
-- TshepoVet may lawfully reuse across buyers (CIPC registration/status/directors,
-- VAT vendor status). scope='tenant' rows hold buyer-disclosed data (TCS results,
-- driver licence results) and are never served to another tenant.
CREATE TABLE verification_cache (
  cache_key        bytea NOT NULL,          -- HMAC(capability || normalised subject)
  scope            text NOT NULL CHECK (scope IN ('global','tenant')),
  tenant_id        uuid REFERENCES tenants(id),
  capability       text NOT NULL,
  payload          jsonb NOT NULL,          -- non-sensitive normalised result
  payload_enc      bytea,                   -- sensitive fields (director IDs, names of natural persons)
  source_provider  text NOT NULL,
  fetched_at       timestamptz NOT NULL,
  fresh_until      timestamptz NOT NULL,    -- serve without refresh
  stale_until      timestamptz NOT NULL,    -- serve only if all providers fail (stale-if-error)
  purge_after      timestamptz NOT NULL,
  CHECK ((scope = 'global' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL)),
  CHECK (stale_until >= fresh_until)
);
CREATE UNIQUE INDEX uq_verification_cache ON verification_cache (cache_key, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_verification_cache_purge ON verification_cache (purge_after);

CREATE TABLE verifications (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  verification_type        text NOT NULL CHECK (verification_type IN ('company','driver_licence')),
  status                   text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  outcome                  text CHECK (outcome IN ('verified','verified_with_warnings','failed_checks','not_found','unable_to_verify')),
  tenant_vendor_id         uuid REFERENCES tenant_vendors(id),
  vendor_id                uuid REFERENCES vendors(id),
  subject_fingerprint      bytea NOT NULL,          -- HMAC of the normalised subject (dedupe, analytics)
  subject_display          text NOT NULL,           -- masked
  consent_id               uuid REFERENCES consent_records(id),
  checks_requested         text[] NOT NULL,
  sku                      text NOT NULL,
  price_cents              integer NOT NULL CHECK (price_cents >= 0),
  wallet_hold_id           uuid,
  charged                  boolean NOT NULL DEFAULT false,
  bureau_cost_cents        integer NOT NULL DEFAULT 0,   -- unit-economics tracking
  result                   jsonb,                        -- normalised, minimised
  risk_flags               text[] NOT NULL DEFAULT '{}',
  requested_by_api_key     uuid REFERENCES api_keys(id),
  request_id               text,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,
  purge_after              timestamptz NOT NULL
);
CREATE INDEX idx_verifications_tenant_time ON verifications (tenant_id, requested_at DESC);
CREATE INDEX idx_verifications_vendor ON verifications (vendor_id);

CREATE TABLE verification_checks (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  verification_id   uuid NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  check_type        text NOT NULL CHECK (check_type IN ('registration','directors','vat','tcs','licence','prdp','id_match')),
  status            text NOT NULL CHECK (status IN ('passed','failed','warning','not_found','pending','error','skipped')),
  source            text NOT NULL,           -- 'cache:redis','cache:pg','provider:xds','stale_cache:pg'
  data_as_of        timestamptz,
  result            jsonb,
  error_code        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_verification_checks_verification ON verification_checks (verification_id);

-- =============================================================================
-- 9. BILLING: PRICE BOOK, WALLET, DOUBLE-ENTRY LEDGER, SUBSCRIPTIONS
-- =============================================================================

CREATE TABLE price_book (
  sku               text NOT NULL,
  description       text NOT NULL,
  billing_type      text NOT NULL CHECK (billing_type IN ('usage','subscription_monthly','per_vendor_monthly')),
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),   -- VAT exclusive
  effective_from    date NOT NULL,
  effective_to      date,
  PRIMARY KEY (sku, effective_from)
);

CREATE TABLE tenant_price_overrides (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  sku               text NOT NULL,
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  effective_from    date NOT NULL,
  effective_to      date,
  PRIMARY KEY (tenant_id, sku, effective_from)
);

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid REFERENCES tenants(id),       -- NULL for platform accounts
  code        text NOT NULL,                     -- 'customer_wallet','cash_clearing','revenue_usage','revenue_subscription','promo_credit_expense'
  kind        text NOT NULL CHECK (kind IN ('asset','liability','revenue','expense','equity')),
  currency    char(3) NOT NULL DEFAULT 'ZAR'
);
CREATE UNIQUE INDEX uq_ledger_accounts ON ledger_accounts (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

-- Prepaid wallet = projection of the tenant's 'customer_wallet' liability account.
-- The CHECK constraint makes over-spend impossible even under concurrency bugs.
CREATE TABLE wallets (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id                  uuid NOT NULL UNIQUE REFERENCES tenants(id),
  ledger_account_id          uuid NOT NULL UNIQUE REFERENCES ledger_accounts(id),
  currency                   char(3) NOT NULL DEFAULT 'ZAR',
  balance_cents              bigint NOT NULL DEFAULT 0,     -- posted
  held_cents                 bigint NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
  credit_limit_cents         bigint NOT NULL DEFAULT 0 CHECK (credit_limit_cents >= 0),  -- post-paid enterprise
  low_balance_threshold_cents bigint NOT NULL DEFAULT 10000,
  low_balance_notified_at    timestamptz,
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_no_overspend CHECK (balance_cents - held_cents + credit_limit_cents >= 0)
);

CREATE TABLE wallet_holds (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  wallet_id        uuid NOT NULL REFERENCES wallets(id),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  sku              text NOT NULL,
  reference_type   text NOT NULL,
  reference_id     uuid NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','captured','released','expired')),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  settled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_type, reference_id)
);
CREATE INDEX idx_wallet_holds_expiry ON wallet_holds (expires_at) WHERE status = 'active';

CREATE TABLE ledger_transactions (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid REFERENCES tenants(id),
  kind             text NOT NULL CHECK (kind IN ('topup','usage_capture','refund','adjustment','subscription_charge','monitoring_charge','promo_credit')),
  reference_type   text,
  reference_id     uuid,
  idempotency_key  text NOT NULL UNIQUE,
  memo             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_tx_tenant ON ledger_transactions (tenant_id, created_at DESC);

-- amount_cents: positive = debit, negative = credit.
CREATE TABLE ledger_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id   uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id       uuid NOT NULL REFERENCES ledger_accounts(id),
  tenant_id        uuid REFERENCES tenants(id),
  amount_cents     bigint NOT NULL CHECK (amount_cents <> 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_entries_account ON ledger_entries (account_id, id);
CREATE INDEX idx_ledger_entries_tx ON ledger_entries (transaction_id);

-- Double-entry invariant: each transaction's entries sum to zero (checked at commit).
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
BEGIN
  SELECT coalesce(sum(amount_cents), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%)', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- Ledger is immutable: corrections are new transactions.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER trg_ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE wallet_topups (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  payment_provider     text NOT NULL CHECK (payment_provider IN ('payfast','ozow','peach','eft','card_on_file','manual')),
  provider_reference   text,
  gross_cents          bigint NOT NULL CHECK (gross_cents > 0),   -- incl. 15% VAT
  vat_cents            bigint NOT NULL CHECK (vat_cents >= 0),
  credit_cents         bigint NOT NULL CHECK (credit_cents > 0),  -- VAT-exclusive credits added
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refunded')),
  tax_invoice_number   text UNIQUE,
  ledger_transaction_id uuid REFERENCES ledger_transactions(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_cents = credit_cents + vat_cents),
  UNIQUE (payment_provider, provider_reference)
);

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  sku                   text NOT NULL,     -- MOD_BBBEE, MOD_COI_RADAR, MOD_CONSTRUCTION, MOD_LOGISTICS
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing','active','past_due','cancelled')),
  unit_price_cents      integer NOT NULL,
  current_period_start  date NOT NULL,
  current_period_end    date NOT NULL,
  cancel_at             date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

-- =============================================================================
-- 10. IDEMPOTENCY, WEBHOOKS (transactional outbox)
-- =============================================================================

CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_hash     bytea NOT NULL,
  status           text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  response_status  smallint,
  response_body    jsonb,
  locked_until     timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys (expires_at);

CREATE TABLE webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  url              text NOT NULL CHECK (url ~ '^https://'),
  secret_enc       bytea NOT NULL,
  events           text[] NOT NULL DEFAULT '{verification.completed,verification.failed}',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id) WHERE status = 'active';

-- Thin events: IDs + statuses only. Consumers fetch details over the API
-- (minimises PII in third-party logs).
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  event_type    text NOT NULL,
  aggregate_id  uuid NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_events_tenant ON webhook_events (tenant_id, created_at DESC);

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  event_id         uuid NOT NULL REFERENCES webhook_events(id),
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','succeeded','failed','dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_http_status smallint,
  last_error       text,
  delivered_at     timestamptz,
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending','failed');

-- =============================================================================
-- 11. WHATSAPP ONBOARDING
-- =============================================================================

CREATE TABLE wa_conversations (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),      -- inviting buyer
  tenant_vendor_id  uuid REFERENCES tenant_vendors(id),
  vendor_id         uuid REFERENCES vendors(id),
  msisdn_enc        bytea NOT NULL,
  msisdn_bidx       bytea NOT NULL,
  language          text NOT NULL DEFAULT 'en',
  state             text NOT NULL DEFAULT 'INVITED',
  state_data        jsonb NOT NULL DEFAULT '{}',                 -- no raw identifiers; references only
  consent_id        uuid REFERENCES consent_records(id),
  last_inbound_at   timestamptz,                                 -- 24h customer-service window
  version           integer NOT NULL DEFAULT 0,                  -- optimistic concurrency
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '14 days',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_wa_conversation_active ON wa_conversations (tenant_id, msisdn_bidx)
  WHERE state NOT IN ('COMPLETED','ABANDONED','OPTED_OUT');
CREATE INDEX idx_wa_conversations_msisdn ON wa_conversations (msisdn_bidx);

CREATE TABLE wa_inbound_messages (
  wa_message_id     text PRIMARY KEY,                 -- Meta retries webhooks: dedupe here
  conversation_id   uuid REFERENCES wa_conversations(id),
  message_type      text NOT NULL,
  media_id          text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  processing_error  text,
  purge_after       timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

CREATE TABLE ocr_jobs (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  conversation_id    uuid REFERENCES wa_conversations(id),
  document_id        uuid REFERENCES vendor_documents(id),
  expected_type      text,
  detected_type      text,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','needs_review','failed')),
  model              text,
  input_tokens       integer,
  output_tokens      integer,
  attempts           integer NOT NULL DEFAULT 0,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);

-- =============================================================================
-- 12. AUDIT LOG (append-only, hash-chained per tenant, monthly partitions)
-- =============================================================================

CREATE TABLE audit_chain_heads (
  chain_key   text PRIMARY KEY,           -- tenant uuid or 'platform'
  last_seq    bigint NOT NULL,
  last_hash   bytea NOT NULL
);

CREATE SEQUENCE audit_log_id_seq;

CREATE TABLE audit_log (
  id            bigint NOT NULL DEFAULT nextval('audit_log_id_seq'),
  tenant_id     uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','api_key','system','vendor_contact','tshepovet_staff')),
  actor_id      text,
  action        text NOT NULL,            -- 'verification.created','consent.withdrawn','tcs_pin.decrypted', ...
  entity_type   text NOT NULL,
  entity_id     text,
  request_id    text,
  ip            inet,
  details       jsonb NOT NULL DEFAULT '{}',   -- never raw PII
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  chain_seq     bigint,                   -- position in the tenant's chain (assigned under lock)
  prev_hash     bytea,
  row_hash      bytea,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE OR REPLACE FUNCTION audit_log_hash(p_prev bytea, p_seq bigint, p_key text, r audit_log) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(p_prev || convert_to(concat_ws('|', p_seq, p_key, r.actor_type, r.actor_id, r.action, r.entity_type,
                r.entity_id, r.request_id, r.details::text,
                to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8'));
$$;

-- SECURITY DEFINER: the app role cannot touch audit_chain_heads directly.
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  k     text := coalesce(NEW.tenant_id::text, 'platform');
  head  audit_chain_heads%ROWTYPE;
BEGIN
  INSERT INTO audit_chain_heads (chain_key, last_seq, last_hash)
  VALUES (k, 0, '\x00'::bytea)
  ON CONFLICT (chain_key) DO NOTHING;

  -- Row lock on the chain head serialises writers per tenant only; the sequence
  -- number is assigned under the lock so chain order == chain_seq order even
  -- when transactions interleave.
  SELECT * INTO head FROM audit_chain_heads WHERE chain_key = k FOR UPDATE;

  NEW.chain_seq := head.last_seq + 1;
  NEW.prev_hash := head.last_hash;
  NEW.row_hash  := audit_log_hash(head.last_hash, NEW.chain_seq, k, NEW);

  UPDATE audit_chain_heads SET last_seq = NEW.chain_seq, last_hash = NEW.row_hash WHERE chain_key = k;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Partition helper (run monthly by the worker; pg_partman is a drop-in alternative).
CREATE OR REPLACE FUNCTION ensure_audit_partitions(months_ahead integer DEFAULT 3) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  m   date := date_trunc('month', now())::date;
  i   integer;
  nm  text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    nm := format('audit_log_%s', to_char(m + (i || ' month')::interval, 'YYYY_MM'));
    IF to_regclass(nm) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
                     nm, m + (i || ' month')::interval, m + ((i + 1) || ' month')::interval);
    END IF;
  END LOOP;
END $$;

SELECT ensure_audit_partitions(3);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_chain ON audit_log (tenant_id, chain_seq);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);

-- Verify a tenant's chain; returns the first broken chain_seq, or NULL if intact.
-- Also detects deletions (gaps) because chain_seq must be contiguous.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r         audit_log%ROWTYPE;
  prev      bytea := '\x00'::bytea;
  expected  bigint := 1;
  k         text := coalesce(p_tenant::text, 'platform');
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id IS NOT DISTINCT FROM p_tenant ORDER BY chain_seq LOOP
    IF r.chain_seq <> expected
       OR r.prev_hash IS DISTINCT FROM prev
       OR r.row_hash IS DISTINCT FROM audit_log_hash(prev, r.chain_seq, k, r) THEN
      RETURN coalesce(r.chain_seq, -1);
    END IF;
    prev := r.row_hash;
    expected := expected + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- =============================================================================
-- 13. GLOBAL ENTITY RESOLUTION (SECURITY DEFINER)
-- =============================================================================
-- Tenants cannot SELECT vendors they are not linked to, yet must be able to
-- resolve "is 2019/123456/07 already a passport?" without seeing it. This
-- function upserts by natural key and returns only the id; linking happens in
-- tenant_vendors under RLS.
CREATE OR REPLACE FUNCTION resolve_vendor_by_cipc(
  p_enterprise_number text, p_type_code char(2), p_entity_kind text, p_legal_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_enterprise_number !~ '^\d{4}/\d{6}/\d{2}$' THEN
    RAISE EXCEPTION 'invalid enterprise number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO vendors (entity_kind, cipc_enterprise_number, cipc_type_code, legal_name)
  VALUES (p_entity_kind, p_enterprise_number, p_type_code, coalesce(p_legal_name, 'PENDING VERIFICATION'))
  ON CONFLICT (cipc_enterprise_number) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM vendors WHERE cipc_enterprise_number = p_enterprise_number;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION resolve_vendor_sole_proprietor(
  p_owner_id_bidx bytea, p_owner_id_enc bytea, p_legal_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vendors WHERE entity_kind = 'sole_proprietor' AND owner_id_number_bidx = p_owner_id_bidx;
  IF v_id IS NULL THEN
    INSERT INTO vendors (entity_kind, legal_name, owner_id_number_bidx, owner_id_number_enc)
    VALUES ('sole_proprietor', p_legal_name, p_owner_id_bidx, p_owner_id_enc)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM vendors WHERE entity_kind = 'sole_proprietor' AND owner_id_number_bidx = p_owner_id_bidx;
    END IF;
  END IF;
  RETURN v_id;
END $$;

-- API-key authentication happens before the tenant is known, so RLS would hide
-- the row. This definer function returns only what the auth middleware needs.
CREATE OR REPLACE FUNCTION authenticate_api_key(p_prefix text)
RETURNS TABLE (key_id uuid, tenant_id uuid, secret_hash bytea, environment text, scopes text[], tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.secret_hash, k.environment, k.scopes, t.status
  FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
  WHERE k.prefix = p_prefix AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now());
$$;

-- Driver checks hang off a vendor (the employer/fleet operator) that the tenant
-- already has a relationship with; resolution is RLS-scoped, no definer needed.

-- =============================================================================
-- 14. RETENTION PURGE (POPIA s14) - executed by tshepovet_worker
-- =============================================================================
CREATE TABLE purge_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  counts        jsonb
);

CREATE OR REPLACE FUNCTION run_retention_purge(p_batch integer DEFAULT 5000) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c        jsonb := '{}'::jsonb;
  n        integer;
  run_id   bigint;
BEGIN
  INSERT INTO purge_runs DEFAULT VALUES RETURNING id INTO run_id;

  -- TCS PINs: crypto-shred the PIN itself; keep the non-secret status history.
  WITH t AS (
    SELECT id FROM tax_compliance_pins
    WHERE pin_enc IS NOT NULL AND (purge_after <= now() OR status IN ('revoked','invalid'))
    LIMIT p_batch FOR UPDATE SKIP LOCKED)
  UPDATE tax_compliance_pins p SET pin_enc = NULL, status = 'purged' FROM t WHERE p.id = t.id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('tcs_pins', n);

  -- Raw bureau payloads (dispute window only).
  WITH t AS (SELECT id FROM provider_calls WHERE response_enc IS NOT NULL AND purge_after <= now() LIMIT p_batch FOR UPDATE SKIP LOCKED)
  UPDATE provider_calls pc SET response_enc = NULL FROM t WHERE pc.id = t.id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('provider_payloads', n);

  -- Document images: the worker deletes the object first, then nulls storage_key.
  -- Here we only flag them; see workers/retentionPurge.ts.
  SELECT count(*) INTO n FROM vendor_documents WHERE storage_key IS NOT NULL AND image_purge_after <= now();
  c := c || jsonb_build_object('document_images_due', n);

  -- Document records past their record retention: strip extracted PII.
  WITH t AS (SELECT id FROM vendor_documents WHERE purged_at IS NULL AND record_purge_after <= now() AND storage_key IS NULL LIMIT p_batch FOR UPDATE SKIP LOCKED)
  UPDATE vendor_documents d SET extracted_fields_enc = NULL, document_number_bidx = NULL, purged_at = now() FROM t WHERE d.id = t.id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('document_records', n);

  DELETE FROM verification_cache WHERE ctid IN (SELECT ctid FROM verification_cache WHERE purge_after <= now() LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('cache_rows', n);

  -- Verifications: keep the billing/audit skeleton, drop the result body.
  WITH t AS (SELECT id FROM verifications WHERE result IS NOT NULL AND purge_after <= now() LIMIT p_batch FOR UPDATE SKIP LOCKED)
  UPDATE verifications v SET result = NULL, subject_display = '[purged]' FROM t WHERE v.id = t.id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('verification_results', n);

  DELETE FROM wa_inbound_messages WHERE wa_message_id IN (SELECT wa_message_id FROM wa_inbound_messages WHERE purge_after <= now() LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('wa_messages', n);

  WITH t AS (SELECT id FROM vendor_directors WHERE id_number_enc IS NOT NULL AND purge_after <= now() LIMIT p_batch FOR UPDATE SKIP LOCKED)
  UPDATE vendor_directors d SET id_number_enc = NULL FROM t WHERE d.id = t.id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('director_ids', n);

  DELETE FROM tenant_employees WHERE id IN (SELECT id FROM tenant_employees WHERE purge_after <= now() LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('employees', n);

  DELETE FROM idempotency_keys WHERE expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('idempotency_keys', n);

  UPDATE purge_runs SET finished_at = now(), counts = c WHERE id = run_id;
  INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, details)
  VALUES (NULL, 'system', 'retention_purge', 'retention.purged', 'purge_run', run_id::text, c);
  RETURN c;
END $$;

-- =============================================================================
-- 15. ROW-LEVEL SECURITY
-- =============================================================================

-- Straight tenant-owned tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_users','api_keys','tenant_vendors','monitoring_enrolments','tenant_employees','coi_vendor_index',
    'coi_matches','tax_compliance_pins','expiry_schedules','verifications','verification_checks',
    'wallets','wallet_holds','wallet_topups','subscriptions','tenant_price_overrides','idempotency_keys',
    'webhook_endpoints','webhook_events','webhook_deliveries','wa_conversations','ocr_jobs','vendor_passport_shares'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id());

-- Tables where NULL tenant_id means "platform / passport-level" data.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consent_records','consent_purposes','ledger_transactions','ledger_entries','ledger_accounts','provider_calls','data_subject_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_rw ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id() OR tenant_id IS NULL)', t);
  END LOOP;
END $$;
-- The usage-capture transaction posts to the platform revenue account (tenant_id NULL);
-- the API must be able to read that account row to reference it.
CREATE POLICY platform_accounts_read ON ledger_accounts FOR SELECT USING (tenant_id IS NULL);

-- Cache: global rows readable by all tenants; tenant rows isolated.
ALTER TABLE verification_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY cache_read ON verification_cache FOR SELECT USING (scope = 'global' OR tenant_id = current_tenant_id());
CREATE POLICY cache_write ON verification_cache FOR INSERT WITH CHECK (scope = 'global' OR tenant_id = current_tenant_id());
CREATE POLICY cache_update ON verification_cache FOR UPDATE USING (scope = 'global' OR tenant_id = current_tenant_id());

-- Vendor passport tables: visible when the tenant has a relationship or an active share.
CREATE OR REPLACE FUNCTION tenant_can_see_vendor(p_vendor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_vendors tv WHERE tv.vendor_id = p_vendor AND tv.tenant_id = current_tenant_id())
      OR EXISTS (SELECT 1 FROM vendor_passport_shares s WHERE s.vendor_id = p_vendor AND s.tenant_id = current_tenant_id()
                   AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()));
$$;

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_visible ON vendors FOR SELECT USING (tenant_can_see_vendor(id));
CREATE POLICY vendor_update ON vendors FOR UPDATE USING (tenant_can_see_vendor(id));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_directors','vendor_beneficial_owners','vendor_contacts','vendor_bank_accounts','vendor_bbbee_profiles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY vendor_child ON %I USING (tenant_can_see_vendor(vendor_id)) WITH CHECK (tenant_can_see_vendor(vendor_id))', t);
  END LOOP;
END $$;

-- Documents/credentials: tenant-uploaded OR passport-level shared with the tenant.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_documents','vendor_credentials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY doc_visible ON %I
      USING (tenant_id = current_tenant_id() OR (tenant_id IS NULL AND tenant_can_see_vendor(vendor_id)))
      WITH CHECK (tenant_id = current_tenant_id() OR (tenant_id IS NULL AND tenant_can_see_vendor(vendor_id)))$p$, t);
  END LOOP;
END $$;

-- Audit log: tenants read their own chain; inserts allowed for own tenant.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO tshepovet_app, tshepovet_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tshepovet_app, tshepovet_worker;
GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO tshepovet_app, tshepovet_worker;
GRANT DELETE ON verification_cache, idempotency_keys, wa_inbound_messages, tenant_employees, coi_vendor_index, vendor_directors TO tshepovet_app;
GRANT DELETE ON ALL TABLES IN SCHEMA public TO tshepovet_worker;
REVOKE UPDATE, DELETE ON audit_log, ledger_entries, ledger_transactions FROM tshepovet_app, tshepovet_worker;
REVOKE ALL ON audit_chain_heads, purge_runs FROM tshepovet_app;
REVOKE INSERT, UPDATE ON ref_cipc_entity_types, ref_bbbee_thresholds, ref_bbbee_recognition_levels, ref_document_types,
  ref_regulatory_grace_periods, ref_retention_policies, price_book, providers, provider_capabilities, privacy_notices
  FROM tshepovet_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tshepovet_app, tshepovet_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tshepovet_app, tshepovet_worker;
REVOKE EXECUTE ON FUNCTION run_retention_purge(integer) FROM tshepovet_app;
REVOKE EXECUTE ON FUNCTION run_retention_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_retention_purge(integer) TO tshepovet_worker;
REVOKE EXECUTE ON FUNCTION ensure_audit_partitions(integer) FROM tshepovet_app, PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_audit_partitions(integer) TO tshepovet_worker;

COMMIT;
