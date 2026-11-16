-- =============================================================================
-- 0003 - Portal accounts (docs/PLAN.md M2)
--
-- Email + password sign-in for buyer users (tenant_users) and TshepoVet staff (staff_users):
-- argon2id password hashes, email verification, TOTP MFA with recovery codes, lockout,
-- single-use tokens (verify email, reset password, invitation) and a transactional email
-- outbox (sandbox: nothing leaves the box; the staff console shows it).
--
-- Sign-in happens before the tenant is known, so - like authenticate_api_key() - it goes
-- through SECURITY DEFINER functions. The API role never reads a password hash, an MFA
-- secret, a token hash or a recovery code: column privileges hide them, and the functions
-- return only what each step needs.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- Buyer users: credentials and sign-in state
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_users
  ADD COLUMN password_hash        text,
  ADD COLUMN email_verified_at    timestamptz,
  ADD COLUMN mfa_secret_enc       bytea,          -- envelope-encrypted TOTP secret (AAD mfa_secret:<user id>)
  ADD COLUMN failed_logins        integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until         timestamptz,
  ADD COLUMN last_login_at        timestamptz,
  ADD COLUMN password_changed_at  timestamptz,
  ADD COLUMN invited_by           uuid REFERENCES tenant_users(id);

-- One sign-in identity per email across the platform.
CREATE UNIQUE INDEX tenant_users_login_email ON tenant_users (email) WHERE disabled_at IS NULL;

-- The API sees users through RLS, but never their secrets.
REVOKE SELECT, INSERT, UPDATE ON tenant_users FROM tshepovet_app;
GRANT SELECT (id, tenant_id, email, full_name, role, can_view_special_pi, mfa_enrolled, disabled_at, created_at,
              email_verified_at, failed_logins, locked_until, last_login_at, password_changed_at, invited_by)
  ON tenant_users TO tshepovet_app;
GRANT UPDATE (full_name, role, can_view_special_pi, disabled_at) ON tenant_users TO tshepovet_app;

-- -----------------------------------------------------------------------------
-- Staff (platform operators): no tenant, separate sessions, MFA mandatory
-- -----------------------------------------------------------------------------
CREATE TABLE staff_users (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  email                citext NOT NULL UNIQUE,
  full_name            text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('support','reviewer','admin')),
  password_hash        text,
  mfa_secret_enc       bytea,
  mfa_enrolled         boolean NOT NULL DEFAULT false,
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON staff_users FROM tshepovet_app;

-- -----------------------------------------------------------------------------
-- Single-use tokens. Only a SHA-256 of the token is stored; the token itself exists only
-- in the email that carries it.
-- -----------------------------------------------------------------------------
CREATE TABLE auth_tokens (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  purpose      text NOT NULL CHECK (purpose IN ('verify_email','reset_password','invite','staff_reset')),
  token_hash   bytea NOT NULL UNIQUE,
  tenant_id    uuid REFERENCES tenants(id),
  user_id      uuid REFERENCES tenant_users(id),
  staff_id     uuid REFERENCES staff_users(id),
  email        citext NOT NULL,
  role         text CHECK (role IS NULL OR role IN ('owner','admin','compliance_officer','procurement','ap_clerk','viewer')),
  created_by   uuid,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_pending ON auth_tokens (tenant_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL;
-- The team page lists and revokes its own pending invitations through RLS (never the hash).
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_tokens USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
REVOKE ALL ON auth_tokens FROM tshepovet_app;
GRANT SELECT (id, purpose, tenant_id, email, role, created_by, expires_at, consumed_at, revoked_at, created_at) ON auth_tokens TO tshepovet_app;
GRANT UPDATE (revoked_at) ON auth_tokens TO tshepovet_app;

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id     uuid REFERENCES tenant_users(id) ON DELETE CASCADE,
  staff_id    uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  code_hash   bytea NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (staff_id IS NULL))
);
CREATE INDEX recovery_codes_user ON recovery_codes (user_id) WHERE used_at IS NULL;
CREATE INDEX recovery_codes_staff ON recovery_codes (staff_id) WHERE used_at IS NULL;
REVOKE ALL ON recovery_codes FROM tshepovet_app;

-- -----------------------------------------------------------------------------
-- Transactional email. The API only appends; the worker (and the staff console) read.
-- -----------------------------------------------------------------------------
CREATE TABLE email_outbox (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid REFERENCES tenants(id),
  to_email    citext NOT NULL,
  template    text NOT NULL,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','sandbox')),
  attempts    integer NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_queued ON email_outbox (created_at) WHERE status = 'queued';
REVOKE ALL ON email_outbox FROM tshepovet_app;
GRANT INSERT ON email_outbox TO tshepovet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_users, auth_tokens, recovery_codes, email_outbox TO tshepovet_worker;

-- -----------------------------------------------------------------------------
-- Sign-in functions (SECURITY DEFINER). Each does one step and returns only what it needs.
-- -----------------------------------------------------------------------------

-- The login record for an email (any tenant). The caller verifies the password hash.
CREATE OR REPLACE FUNCTION auth_find_user(p_email citext)
RETURNS TABLE (user_id uuid, tenant_id uuid, tenant_status text, legal_name text, email citext, full_name text, role text,
               password_hash text, email_verified_at timestamptz, mfa_enrolled boolean, mfa_secret_enc bytea,
               locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, t.status, t.legal_name, u.email, u.full_name, u.role, u.password_hash, u.email_verified_at,
         u.mfa_enrolled, u.mfa_secret_enc, u.locked_until
  FROM tenant_users u JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = p_email AND u.disabled_at IS NULL;
$$;

-- The same record by id (sessions re-read it to catch a disabled user or a changed role).
CREATE OR REPLACE FUNCTION auth_user_by_id(p_user_id uuid)
RETURNS TABLE (user_id uuid, tenant_id uuid, tenant_status text, legal_name text, email citext, full_name text, role text,
               email_verified_at timestamptz, mfa_enrolled boolean, mfa_secret_enc bytea, password_hash text,
               password_changed_at timestamptz, disabled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, t.status, t.legal_name, u.email, u.full_name, u.role, u.email_verified_at, u.mfa_enrolled,
         u.mfa_secret_enc, u.password_hash, u.password_changed_at, u.disabled_at
  FROM tenant_users u JOIN tenants t ON t.id = u.tenant_id
  WHERE u.id = p_user_id;
$$;

-- Records a sign-in attempt; locks the account after p_max consecutive failures.
CREATE OR REPLACE FUNCTION auth_record_login(p_user_id uuid, p_success boolean, p_max integer, p_lock interval)
RETURNS TABLE (failed_logins integer, locked_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    RETURN QUERY UPDATE tenant_users u SET failed_logins = 0, locked_until = NULL, last_login_at = now()
                 WHERE u.id = p_user_id RETURNING u.failed_logins, u.locked_until;
  ELSE
    RETURN QUERY UPDATE tenant_users u
                 SET failed_logins = CASE WHEN u.failed_logins + 1 >= p_max THEN 0 ELSE u.failed_logins + 1 END,
                     locked_until  = CASE WHEN u.failed_logins + 1 >= p_max THEN now() + p_lock ELSE u.locked_until END
                 WHERE u.id = p_user_id RETURNING u.failed_logins, u.locked_until;
  END IF;
END $$;

-- Creates a tenant, its wallet and its owner. Returns no row when the email already signs in
-- somewhere: the caller answers exactly as for a new sign-up (no account enumeration).
CREATE OR REPLACE FUNCTION auth_signup(p_org text, p_full_name text, p_email citext, p_password_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_account uuid;
  v_user uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_users u WHERE u.email = p_email AND u.disabled_at IS NULL) THEN
    RETURN;
  END IF;
  INSERT INTO tenants (legal_name) VALUES (p_org) RETURNING id INTO v_tenant;
  INSERT INTO ledger_accounts (tenant_id, code, kind) VALUES (v_tenant, 'customer_wallet', 'liability') RETURNING id INTO v_account;
  INSERT INTO wallets (tenant_id, ledger_account_id) VALUES (v_tenant, v_account);
  INSERT INTO tenant_users (tenant_id, email, full_name, role, password_hash, password_changed_at)
    VALUES (v_tenant, p_email, p_full_name, 'owner', p_password_hash, now()) RETURNING id INTO v_user;
  RETURN QUERY SELECT v_tenant, v_user;
EXCEPTION WHEN unique_violation THEN
  RETURN; -- a concurrent sign-up with the same email won the race
END $$;

-- Issues a token (only its hash is stored); earlier pending tokens for the same purpose and
-- subject are revoked, so only the newest link works.
CREATE OR REPLACE FUNCTION auth_issue_token(p_purpose text, p_hash bytea, p_tenant uuid, p_user uuid, p_staff uuid,
                                            p_email citext, p_role text, p_ttl interval, p_created_by uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE auth_tokens t SET revoked_at = now()
   WHERE t.purpose = p_purpose AND t.consumed_at IS NULL AND t.revoked_at IS NULL
     AND ((p_user IS NOT NULL AND t.user_id = p_user)
       OR (p_staff IS NOT NULL AND t.staff_id = p_staff)
       OR (p_purpose = 'invite' AND t.tenant_id = p_tenant AND t.email = p_email));
  INSERT INTO auth_tokens (purpose, token_hash, tenant_id, user_id, staff_id, email, role, created_by, expires_at)
    VALUES (p_purpose, p_hash, p_tenant, p_user, p_staff, p_email, p_role, p_created_by, now() + p_ttl)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Consumes a valid token atomically: of two concurrent uses, exactly one gets the row.
CREATE OR REPLACE FUNCTION auth_consume_token(p_purpose text, p_hash bytea)
RETURNS TABLE (token_id uuid, tenant_id uuid, user_id uuid, staff_id uuid, email citext, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE auth_tokens t SET consumed_at = now()
   WHERE t.purpose = p_purpose AND t.token_hash = p_hash AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
  RETURNING t.id, t.tenant_id, t.user_id, t.staff_id, t.email, t.role;
$$;

-- What an invitation link shows before it is accepted (organisation, email, role).
CREATE OR REPLACE FUNCTION auth_peek_invite(p_hash bytea)
RETURNS TABLE (legal_name text, email citext, role text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tn.legal_name, t.email, t.role, t.expires_at
  FROM auth_tokens t JOIN tenants tn ON tn.id = t.tenant_id
  WHERE t.purpose = 'invite' AND t.token_hash = p_hash AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now();
$$;

-- Accepts an invitation: consumes the token and creates the user (email proven by the token).
CREATE OR REPLACE FUNCTION auth_accept_invite(p_hash bytea, p_full_name text, p_password_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tok record;
  v_user uuid;
BEGIN
  SELECT * INTO v_tok FROM auth_consume_token('invite', p_hash);
  IF v_tok.token_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO tenant_users (tenant_id, email, full_name, role, password_hash, password_changed_at, email_verified_at, invited_by)
    SELECT v_tok.tenant_id, v_tok.email, p_full_name, v_tok.role, p_password_hash, now(), now(), tk.created_by
    FROM auth_tokens tk WHERE tk.id = v_tok.token_id
    RETURNING id INTO v_user;
  RETURN QUERY SELECT v_tok.tenant_id, v_user, v_tok.role;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'email_in_use' USING ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION auth_set_password(p_user_id uuid, p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE tenant_users SET password_hash = p_hash, password_changed_at = now(), failed_logins = 0, locked_until = NULL
   WHERE id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION auth_mark_email_verified(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE tenant_users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION auth_set_mfa(p_user_id uuid, p_secret_enc bytea, p_enrolled boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE tenant_users SET mfa_secret_enc = p_secret_enc, mfa_enrolled = p_enrolled WHERE id = p_user_id;
$$;

-- Recovery codes (users and staff): replace the whole set, or use one.
CREATE OR REPLACE FUNCTION auth_replace_recovery_codes(p_user_id uuid, p_staff_id uuid, p_hashes bytea[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM recovery_codes r WHERE (p_user_id IS NOT NULL AND r.user_id = p_user_id) OR (p_staff_id IS NOT NULL AND r.staff_id = p_staff_id);
  INSERT INTO recovery_codes (user_id, staff_id, code_hash) SELECT p_user_id, p_staff_id, h FROM unnest(p_hashes) AS h;
END $$;

CREATE OR REPLACE FUNCTION auth_use_recovery_code(p_user_id uuid, p_staff_id uuid, p_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE recovery_codes r SET used_at = now()
   WHERE r.id = (SELECT r2.id FROM recovery_codes r2
                  WHERE r2.code_hash = p_hash AND r2.used_at IS NULL
                    AND ((p_user_id IS NOT NULL AND r2.user_id = p_user_id) OR (p_staff_id IS NOT NULL AND r2.staff_id = p_staff_id))
                  LIMIT 1 FOR UPDATE)
  RETURNING r.id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION auth_recovery_codes_left(p_user_id uuid, p_staff_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM recovery_codes r
   WHERE r.used_at IS NULL AND ((p_user_id IS NOT NULL AND r.user_id = p_user_id) OR (p_staff_id IS NOT NULL AND r.staff_id = p_staff_id));
$$;

-- Staff equivalents.
CREATE OR REPLACE FUNCTION staff_find(p_email citext)
RETURNS TABLE (staff_id uuid, email citext, full_name text, role text, password_hash text, mfa_enrolled boolean,
               mfa_secret_enc bytea, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.email, s.full_name, s.role, s.password_hash, s.mfa_enrolled, s.mfa_secret_enc, s.locked_until
  FROM staff_users s WHERE s.email = p_email AND s.disabled_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION staff_by_id(p_staff_id uuid)
RETURNS TABLE (staff_id uuid, email citext, full_name text, role text, mfa_enrolled boolean, mfa_secret_enc bytea,
               password_hash text, password_changed_at timestamptz, disabled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.email, s.full_name, s.role, s.mfa_enrolled, s.mfa_secret_enc, s.password_hash, s.password_changed_at, s.disabled_at
  FROM staff_users s WHERE s.id = p_staff_id;
$$;

CREATE OR REPLACE FUNCTION staff_record_login(p_staff_id uuid, p_success boolean, p_max integer, p_lock interval)
RETURNS TABLE (failed_logins integer, locked_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    RETURN QUERY UPDATE staff_users s SET failed_logins = 0, locked_until = NULL, last_login_at = now()
                 WHERE s.id = p_staff_id RETURNING s.failed_logins, s.locked_until;
  ELSE
    RETURN QUERY UPDATE staff_users s
                 SET failed_logins = CASE WHEN s.failed_logins + 1 >= p_max THEN 0 ELSE s.failed_logins + 1 END,
                     locked_until  = CASE WHEN s.failed_logins + 1 >= p_max THEN now() + p_lock ELSE s.locked_until END
                 WHERE s.id = p_staff_id RETURNING s.failed_logins, s.locked_until;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION staff_set_mfa(p_staff_id uuid, p_secret_enc bytea, p_enrolled boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE staff_users SET mfa_secret_enc = p_secret_enc, mfa_enrolled = p_enrolled WHERE id = p_staff_id;
$$;

CREATE OR REPLACE FUNCTION staff_set_password(p_staff_id uuid, p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE staff_users SET password_hash = p_hash, password_changed_at = now(), failed_logins = 0, locked_until = NULL
   WHERE id = p_staff_id;
$$;

-- Platform audit events (no tenant): staff sign-ins and the like. audit_log's insert policy
-- only admits the current tenant's rows, so the API writes platform events through this
-- function, which accepts nothing but staff and system events.
CREATE OR REPLACE FUNCTION audit_platform_event(p_actor_type text, p_actor_id text, p_action text, p_entity_type text,
                                                p_entity_id text, p_request_id text, p_ip inet, p_details jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_actor_type NOT IN ('tshepovet_staff', 'system') THEN
    RAISE EXCEPTION 'platform audit events are staff or system events';
  END IF;
  INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, request_id, ip, details)
    VALUES (NULL, p_actor_type, p_actor_id, p_action, p_entity_type, p_entity_id, p_request_id, p_ip, coalesce(p_details, '{}'::jsonb));
END $$;

-- Retention for this migration's data (called by the worker's purge, after run_retention_purge()).
CREATE OR REPLACE FUNCTION purge_auth_artifacts() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tokens integer;
  v_mail integer;
BEGIN
  DELETE FROM auth_tokens WHERE coalesce(consumed_at, revoked_at, expires_at) < now() - interval '30 days';
  GET DIAGNOSTICS v_tokens = ROW_COUNT;
  -- Mail bodies can carry links with tokens: keep them only as long as they are useful.
  DELETE FROM email_outbox WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_mail = ROW_COUNT;
  RETURN jsonb_build_object('auth_tokens', v_tokens, 'emails', v_mail);
END $$;

-- Definer functions are callable only by the roles that need them.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_find_user(citext)', 'auth_user_by_id(uuid)', 'auth_record_login(uuid,boolean,integer,interval)',
    'auth_signup(text,text,citext,text)', 'auth_issue_token(text,bytea,uuid,uuid,uuid,citext,text,interval,uuid)',
    'auth_consume_token(text,bytea)', 'auth_peek_invite(bytea)', 'auth_accept_invite(bytea,text,text)',
    'auth_set_password(uuid,text)', 'auth_mark_email_verified(uuid)', 'auth_set_mfa(uuid,bytea,boolean)',
    'auth_replace_recovery_codes(uuid,uuid,bytea[])', 'auth_use_recovery_code(uuid,uuid,bytea)',
    'auth_recovery_codes_left(uuid,uuid)', 'staff_find(citext)', 'staff_by_id(uuid)',
    'staff_record_login(uuid,boolean,integer,interval)', 'staff_set_mfa(uuid,bytea,boolean)', 'staff_set_password(uuid,text)',
    'audit_platform_event(text,text,text,text,text,text,inet,jsonb)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tshepovet_app, tshepovet_worker', f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION purge_auth_artifacts() FROM PUBLIC, tshepovet_app;
GRANT EXECUTE ON FUNCTION purge_auth_artifacts() TO tshepovet_worker;

COMMIT;
