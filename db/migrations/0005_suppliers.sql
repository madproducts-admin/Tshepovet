-- =============================================================================
-- 0005 - The supplier's side (docs/PLAN.md M6)
--
-- * Onboarding invitations: a buyer sends a supplier a single link; the supplier gives
--   consent, confirms the company, adds documents, bank details and a tax PIN, and submits.
--   The link's token is the only credential (only its hash is stored).
-- * Supplier self-service: a contact signs in with a magic link sent to the email address
--   they onboarded with, and controls the supplier's passport, consents and requests.
-- * The public Verified Vendor Passport, readable by anyone with its link.
--
-- Supplier contacts and the public are not tenant users, so - like sign-in - the steps that
-- cross tenants go through narrow SECURITY DEFINER functions that take the vendor (or the
-- token hash) and return only what that step needs.
--
-- The trust boundary: anyone can sign up as a buyer, add any company and invite an address
-- they control. So whatever is entered through an invitation (contact, bank account, B-BBEE
-- profile, documents) belongs to the INVITING BUYER ONLY (tenant_id set). It becomes the
-- supplier's shared record (tenant_id NULL), visible to every buyer and able to publish the
-- passport or sign in to self-service, only through onboarding_promote(): when the identity
-- document matched an active director on the CIPC register. The API role cannot write shared
-- rows at all.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- Onboarding invitations
-- -----------------------------------------------------------------------------
CREATE TABLE vendor_invites (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  tenant_vendor_id  uuid NOT NULL REFERENCES tenant_vendors(id),
  email             citext NOT NULL,
  contact_name      text CHECK (length(contact_name) <= 120),
  token_hash        bytea NOT NULL UNIQUE,
  created_by        uuid REFERENCES tenant_users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  opened_at         timestamptz,
  completed_at      timestamptz,
  revoked_at        timestamptz,
  -- Progress through the steps, written by the API as the supplier goes.
  progress          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_vendor_invites_tv ON vendor_invites (tenant_vendor_id, created_at DESC);
ALTER TABLE vendor_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_invites USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT (id, tenant_id, tenant_vendor_id, email, contact_name, created_by, created_at, expires_at, opened_at, completed_at, revoked_at, progress) ON vendor_invites TO tshepovet_app;
GRANT INSERT ON vendor_invites TO tshepovet_app;
GRANT UPDATE (opened_at, completed_at, revoked_at, progress) ON vendor_invites TO tshepovet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_invites TO tshepovet_worker;

-- Opens an invitation by its token, before the tenant is known. Only a live invitation
-- (not revoked, not expired) opens; the caller then works inside that tenant's RLS.
CREATE FUNCTION onboarding_open(p_hash bytea)
RETURNS TABLE (invite_id uuid, tenant_id uuid, tenant_vendor_id uuid, vendor_id uuid, buyer_name text, email citext, contact_name text, completed_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.tenant_id, i.tenant_vendor_id, tv.vendor_id, t.legal_name, i.email, i.contact_name, i.completed_at
    FROM vendor_invites i
    JOIN tenant_vendors tv ON tv.id = i.tenant_vendor_id
    JOIN tenants t ON t.id = i.tenant_id AND t.status = 'active'
   WHERE i.token_hash = p_hash AND i.revoked_at IS NULL AND i.expires_at > now();
$$;

-- -----------------------------------------------------------------------------
-- Supplier contacts: sign-in by magic link
-- -----------------------------------------------------------------------------
ALTER TABLE vendor_contacts ADD COLUMN email_verified_at timestamptz;   -- set when they onboard from the emailed link

-- Supplier-entered data: the inviting buyer's own (tenant_id) until promoted (NULL = shared).
ALTER TABLE vendor_contacts      ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE vendor_bank_accounts ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE vendor_bbbee_profiles ADD COLUMN tenant_id uuid REFERENCES tenants(id);
-- One contact per address per buyer, and one shared contact per address.
CREATE UNIQUE INDEX uq_vendor_contacts_email ON vendor_contacts (vendor_id, email, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE email IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_contacts', 'vendor_bank_accounts', 'vendor_bbbee_profiles'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS vendor_child ON %I', t);
    -- Read: the shared record of a visible supplier, plus this buyer's own rows.
    EXECUTE format('CREATE POLICY supplier_data_read ON %I FOR SELECT USING (tenant_can_see_vendor(vendor_id) AND (tenant_id IS NULL OR tenant_id = current_tenant_id()))', t);
    -- Write: only this buyer's own rows. Shared rows come only from onboarding_promote().
    EXECUTE format('CREATE POLICY supplier_data_insert ON %I FOR INSERT WITH CHECK (tenant_can_see_vendor(vendor_id) AND tenant_id = current_tenant_id())', t);
    EXECUTE format('CREATE POLICY supplier_data_update ON %I FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;
-- Documents likewise: the API role may no longer write passport-level (tenant_id NULL) rows.
DROP POLICY IF EXISTS doc_visible ON vendor_documents;
CREATE POLICY doc_read ON vendor_documents FOR SELECT USING (tenant_id = current_tenant_id() OR (tenant_id IS NULL AND tenant_can_see_vendor(vendor_id)));
CREATE POLICY doc_insert ON vendor_documents FOR INSERT WITH CHECK (tenant_id = current_tenant_id() AND tenant_can_see_vendor(vendor_id));
CREATE POLICY doc_update ON vendor_documents FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE vendor_login_tokens (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  vendor_contact_id  uuid NOT NULL REFERENCES vendor_contacts(id) ON DELETE CASCADE,
  token_hash         bytea NOT NULL UNIQUE,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON vendor_login_tokens FROM tshepovet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_login_tokens TO tshepovet_worker;

-- The contacts an email address may sign in as (one per supplier it onboarded).
CREATE FUNCTION vendor_login_candidates(p_email citext)
RETURNS TABLE (contact_id uuid, vendor_id uuid, full_name text, legal_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.vendor_id, c.full_name, v.legal_name
    FROM vendor_contacts c JOIN vendors v ON v.id = c.vendor_id
   WHERE c.email = p_email AND c.email_verified_at IS NOT NULL
     AND c.tenant_id IS NULL AND c.authority_basis IN ('director', 'member', 'sole_proprietor');
$$;

-- Issues a sign-in link for a contact; earlier unused links for that contact stop working.
CREATE FUNCTION vendor_issue_login_token(p_contact uuid, p_hash bytea, p_ttl interval)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE vendor_login_tokens SET consumed_at = now() WHERE vendor_contact_id = p_contact AND consumed_at IS NULL;
  INSERT INTO vendor_login_tokens (vendor_contact_id, token_hash, expires_at) VALUES (p_contact, p_hash, now() + p_ttl);
END $$;

-- Spends a sign-in link atomically: of two concurrent uses, exactly one gets the contact.
CREATE FUNCTION vendor_consume_login_token(p_hash bytea)
RETURNS TABLE (contact_id uuid, vendor_id uuid, full_name text, email citext)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH spent AS (
    UPDATE vendor_login_tokens SET consumed_at = now()
     WHERE token_hash = p_hash AND consumed_at IS NULL AND expires_at > now()
     RETURNING vendor_contact_id
  )
  SELECT c.id, c.vendor_id, c.full_name, c.email FROM spent JOIN vendor_contacts c ON c.id = spent.vendor_contact_id;
$$;

-- Whether a signed-in contact still exists (re-checked on every request).
CREATE FUNCTION vendor_contact_live(p_contact uuid)
RETURNS TABLE (vendor_id uuid, full_name text, email citext)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT vendor_id, full_name, email FROM vendor_contacts
   WHERE id = p_contact AND email_verified_at IS NOT NULL AND tenant_id IS NULL AND authority_basis IN ('director', 'member', 'sole_proprietor');
$$;

-- -----------------------------------------------------------------------------
-- Supplier self-service (scoped to one vendor; the API passes the signed-in contact's vendor)
-- -----------------------------------------------------------------------------
CREATE FUNCTION vendor_portal_view(p_vendor uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'vendor', (SELECT jsonb_build_object(
        'id', v.id, 'legal_name', v.legal_name, 'trading_name', v.trading_name, 'registration_number', v.cipc_enterprise_number,
        'entity_kind', v.entity_kind, 'cipc_status', v.cipc_status, 'vat_number', v.vat_number,
        'passport_status', v.passport_status, 'passport_public_id', v.passport_public_id,
        'passport_public_fields', to_jsonb(v.passport_public_fields), 'passport_last_verified_at', v.passport_last_verified_at)
      FROM vendors v WHERE v.id = p_vendor),
    'buyers', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'relationship_id', tv.id, 'buyer', t.legal_name, 'status', tv.status, 'since', tv.created_at,
        'monitored', EXISTS (SELECT 1 FROM monitoring_enrolments m WHERE m.tenant_vendor_id = tv.id AND m.period @> now()))
        ORDER BY t.legal_name)
      FROM tenant_vendors tv JOIN tenants t ON t.id = tv.tenant_id
     WHERE tv.vendor_id = p_vendor AND tv.status <> 'offboarded'), '[]'::jsonb),
    'consents', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', cr.id, 'buyer', t.legal_name, 'granted_at', cr.granted_at, 'capture_method', cr.capture_method,
        'purposes', (SELECT jsonb_agg(jsonb_build_object('purpose', p.purpose, 'withdrawn_at', p.withdrawn_at) ORDER BY p.purpose)
                       FROM consent_purposes p WHERE p.consent_id = cr.id))
        ORDER BY cr.granted_at DESC)
      FROM consent_records cr LEFT JOIN tenants t ON t.id = cr.tenant_id
     WHERE cr.vendor_id = p_vendor), '[]'::jsonb),
    'documents', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'document_type', d.document_type, 'name', coalesce(rt.name, d.document_type), 'review_status', d.review_status,
        'expires_on', d.expires_on, 'created_at', d.created_at)
        ORDER BY d.created_at DESC)
      FROM vendor_documents d LEFT JOIN ref_document_types rt ON rt.code = d.document_type
     WHERE d.vendor_id = p_vendor AND d.superseded_by IS NULL AND d.tenant_id IS NULL), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'buyer', t.legal_name, 'request_type', r.request_type, 'status', r.status, 'received_at', r.received_at, 'due_at', r.due_at)
        ORDER BY r.received_at DESC)
      FROM data_subject_requests r LEFT JOIN tenants t ON t.id = r.tenant_id
     WHERE r.vendor_id = p_vendor), '[]'::jsonb)
  );
$$;

-- Publish or withdraw the passport, and choose what it shows. Only the supplier decides.
-- Returns false when TshepoVet suspended the passport: only staff lift a suspension.
CREATE FUNCTION vendor_set_passport(p_vendor uuid, p_status text, p_fields text[])
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('active', 'revoked') THEN RAISE EXCEPTION 'invalid passport status' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF NOT (p_fields <@ ARRAY['legal_name','registration_number','cipc_status','vat_status','tcs_status','bbbee_level','directors_initials','verified_at']) THEN
    RAISE EXCEPTION 'invalid passport field' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE vendors SET passport_status = p_status, passport_public_fields = p_fields WHERE id = p_vendor AND passport_status <> 'suspended';
  RETURN FOUND;
END $$;

-- Withdraw consent purposes on one of the supplier's own consent records.
CREATE FUNCTION vendor_withdraw_consent(p_vendor uuid, p_consent uuid, p_purposes text[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE consent_purposes p SET withdrawn_at = now(), withdrawal_channel = 'supplier_portal'
    FROM consent_records cr
   WHERE p.consent_id = cr.id AND cr.id = p_consent AND cr.vendor_id = p_vendor AND p.withdrawn_at IS NULL
     AND (p_purposes IS NULL OR p.purpose = ANY(p_purposes));
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Monitoring rests on consent: without it, the buyer's monitoring of this supplier ends.
  IF n > 0 AND NOT EXISTS (
       SELECT 1 FROM consent_records r JOIN consent_purposes q ON q.consent_id = r.id
        WHERE r.vendor_id = p_vendor AND r.tenant_id IS NOT DISTINCT FROM (SELECT tenant_id FROM consent_records WHERE id = p_consent)
          AND q.purpose = 'continuous_monitoring' AND q.withdrawn_at IS NULL) THEN
    UPDATE monitoring_enrolments m SET period = tstzrange(lower(m.period), now())
      FROM tenant_vendors tv
     WHERE m.tenant_vendor_id = tv.id AND tv.vendor_id = p_vendor
       AND tv.tenant_id = (SELECT tenant_id FROM consent_records WHERE id = p_consent) AND m.period @> now();
  END IF;
  RETURN n;
END $$;

-- A supplier's request about its information (access, correction, deletion, objection), sent
-- to one buyer's compliance queue on the 30-day clock.
CREATE FUNCTION vendor_submit_request(p_vendor uuid, p_relationship uuid, p_type text, p_requester text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_id uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM tenant_vendors WHERE id = p_relationship AND vendor_id = p_vendor;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'unknown relationship' USING ERRCODE = 'no_data_found'; END IF;
  INSERT INTO data_subject_requests (tenant_id, vendor_id, request_type, requester_display, outcome_notes)
    VALUES (v_tenant, p_vendor, p_type, p_requester, p_notes) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- -----------------------------------------------------------------------------
-- The public passport: only what the supplier chose to show, only while it is active.
-- Directors appear as initials; a PIN, ID numbers and bank details never appear.
-- -----------------------------------------------------------------------------
CREATE FUNCTION passport_public_view(p_public_id text)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'status', v.passport_status,
    'public_id', v.passport_public_id,
    'fields', to_jsonb(v.passport_public_fields),
    'legal_name', v.legal_name,
    'registration_number', v.cipc_enterprise_number,
    'cipc_status', v.cipc_status,
    'verified_at', v.passport_last_verified_at,
    'vat_registered', v.vat_number IS NOT NULL,
    'tcs', (SELECT jsonb_build_object('status', p.last_tcs_status, 'expires_on', p.pin_expires_on, 'checked_at', p.last_verified_at)
              FROM tax_compliance_pins p WHERE p.vendor_id = v.id AND p.last_verified_at IS NOT NULL
             ORDER BY p.last_verified_at DESC LIMIT 1),
    'bbbee', (SELECT jsonb_build_object('level', b.bbbee_level, 'valid_until', b.valid_until)
                FROM vendor_bbbee_profiles b WHERE b.vendor_id = v.id AND b.status = 'accepted' AND b.tenant_id IS NULL
               ORDER BY b.valid_until DESC LIMIT 1),
    'directors', coalesce((SELECT jsonb_agg(
        regexp_replace(initcap(d.full_name), '(\w)\w*\s*', '\1.', 'g') ORDER BY d.full_name)
        FROM vendor_directors d WHERE d.vendor_id = v.id AND d.status = 'active'), '[]'::jsonb)
  )
  FROM vendors v WHERE v.passport_public_id = p_public_id AND v.passport_status <> 'none';
$$;

-- -----------------------------------------------------------------------------
-- Promotion: an onboarding's data becomes the supplier's shared record only when its identity
-- document matched an active director on the register (authority_basis = 'director', set by
-- the API after comparing blind indexes). Every row is checked to belong to this invitation's
-- buyer and supplier; anything else is left alone. Returns whether it promoted, and whether
-- the passport was published.
-- -----------------------------------------------------------------------------
CREATE FUNCTION onboarding_promote(p_invite uuid, p_publish boolean)
RETURNS TABLE (promoted boolean, published boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  i vendor_invites%ROWTYPE;
  v_vendor uuid;
  c vendor_contacts%ROWTYPE;
  v_shared uuid;
  v_published boolean := false;
BEGIN
  SELECT * INTO i FROM vendor_invites WHERE id = p_invite AND tenant_id = current_tenant_id() AND completed_at IS NOT NULL;
  IF NOT FOUND THEN RETURN QUERY SELECT false, false; RETURN; END IF;
  SELECT vendor_id INTO v_vendor FROM tenant_vendors WHERE id = i.tenant_vendor_id;
  SELECT * INTO c FROM vendor_contacts
   WHERE id = (i.progress->>'contact_id')::uuid AND vendor_id = v_vendor AND tenant_id = i.tenant_id;
  IF NOT FOUND OR c.authority_basis IS DISTINCT FROM 'director' OR (i.progress->'identity'->>'is_director')::boolean IS NOT TRUE THEN
    RETURN QUERY SELECT false, false; RETURN;
  END IF;

  -- The contact: becomes (or refreshes) the shared contact for this address.
  SELECT id INTO v_shared FROM vendor_contacts WHERE vendor_id = v_vendor AND email = c.email AND tenant_id IS NULL;
  IF v_shared IS NULL THEN
    UPDATE vendor_contacts SET tenant_id = NULL WHERE id = c.id;
  ELSE
    UPDATE vendor_contacts SET full_name = c.full_name, role = coalesce(c.role, role), authority_basis = 'director',
                               is_authorised_signatory = true, email_verified_at = now() WHERE id = v_shared;
  END IF;

  UPDATE vendor_bank_accounts SET tenant_id = NULL
   WHERE id = (i.progress->'bank'->>'account_id')::uuid AND vendor_id = v_vendor AND tenant_id = i.tenant_id;
  UPDATE vendor_bbbee_profiles SET tenant_id = NULL
   WHERE id = (i.progress->'bbbee'->>'profile_id')::uuid AND vendor_id = v_vendor AND tenant_id = i.tenant_id;
  UPDATE vendor_documents SET tenant_id = NULL
   WHERE id IN ((i.progress->'identity'->>'document_id')::uuid, (i.progress->'bbbee'->>'document_id')::uuid)
     AND vendor_id = v_vendor AND tenant_id = i.tenant_id;

  IF p_publish THEN
    UPDATE vendors SET passport_status = 'active',
           passport_public_fields = ARRAY['legal_name','registration_number','cipc_status','vat_status','tcs_status','bbbee_level','directors_initials','verified_at']
     WHERE id = v_vendor AND passport_last_verified_at IS NOT NULL AND passport_status <> 'active';
    v_published := FOUND;
  END IF;
  RETURN QUERY SELECT true, v_published;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'onboarding_promote(uuid, boolean)',
    'onboarding_open(bytea)', 'vendor_login_candidates(citext)', 'vendor_issue_login_token(uuid, bytea, interval)',
    'vendor_consume_login_token(bytea)', 'vendor_contact_live(uuid)', 'vendor_portal_view(uuid)',
    'vendor_set_passport(uuid, text, text[])', 'vendor_withdraw_consent(uuid, uuid, text[])',
    'vendor_submit_request(uuid, uuid, text, text, text)', 'passport_public_view(text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tshepovet_app, tshepovet_worker', f);
  END LOOP;
END $$;

-- The withdrawal channel now includes the supplier's own portal.
-- (consent_purposes.withdrawal_channel is free text; nothing to change.)

-- Web-channel notice for suppliers onboarding themselves.
INSERT INTO privacy_notices (code, version, language, channel, body, body_sha256, effective_from)
SELECT 'vendor_onboarding', 1, 'en', 'web', body, sha256(convert_to(body, 'UTF8')), '2026-11-01'
FROM (VALUES (
  'Your customer (the responsible party) uses TshepoVet (its operator) to onboard its suppliers. We will ask for your company details, an identity document of the person completing this, and where your customer needs them, B-BBEE evidence, bank details and a SARS tax compliance PIN. We verify them with the CIPC register, SARS and licensed data bureaus in South Africa. Photos of documents are read by automated software and deleted within 30 to 90 days; what was read from them is kept while you supply your customer, plus five years. If you choose to publish a Verified Vendor Passport, the facts you select are shown to anyone with its link, and you can withdraw it at any time. You may ask to see or correct your information, object to its use, or complain to the Information Regulator (inforeg.org.za).'
)) AS n(body);

COMMIT;
