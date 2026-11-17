import crypto from 'node:crypto';
import net from 'node:net';
import type { Request, Response } from 'express';
import {
  ApiError,
  audit,
  type AuditEvent,
  EmailInUseError,
  enqueueMail,
  generateTotpSecret,
  hashPassword,
  type MailTemplate,
  type MailVars,
  newOpaqueToken,
  newRecoveryCodes,
  otpauthUri,
  passwordProblems,
  recoveryCodeHash,
  type SessionData,
  type SessionKind,
  spendPasswordCheck,
  tokenHash,
  verifyPassword,
  verifyTotp,
  withTenantTx,
} from '@tshepovet/core';
import { MFA_REQUIRED_ROLES, type Role, ROLE_PERMISSIONS, type SessionView, type StaffSessionView } from '@tshepovet/contracts';
import type { Container } from '../container';
import { clearCookie, type CookieNames, cookieNames, setCookie } from './cookies';

const VERIFY_TTL = 24 * 3600;
const RESET_TTL = 3600;
export const INVITE_TTL = 7 * 24 * 3600;

/**
 * The client's address: Cloudflare's header when present (the box sits behind it), else the
 * socket; null when neither is a valid IP (audit_log.ip is inet). Until Authenticated Origin
 * Pulls is on (docs/PLAN.md M9) a client that reaches the origin directly could set the
 * header, so it feeds rate limits and audit context, never an access decision.
 */
export function clientIp(req: Request): string | null {
  const isIp = (v: string | undefined): v is string => !!v && net.isIP(v) !== 0;
  const cf = req.header('cf-connecting-ip');
  if (isIp(cf)) return cf;
  return isIp(req.ip) ? req.ip : null;
}

const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'The email address or password is not right.');
const tooMany = () => new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait a few minutes and try again.');

/**
 * Accounts and sessions for the buyer portal and the staff console. Framework-free apart from
 * Express's Request/Response for cookies; the controllers only parse bodies and call in.
 * Every security event lands in the audit chain (tenant chain for users, platform chain for
 * staff). Responses never reveal whether an email has an account.
 */
export class AuthService {
  readonly names: CookieNames;

  constructor(readonly c: Container) {
    this.names = cookieNames(c.cookieSecure);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────
  private async limited(key: string, max: number, windowSeconds: number): Promise<boolean> {
    const k = `tv:rl:auth:${key}`;
    const n = await this.c.redis.incr(k);
    if (n === 1) await this.c.redis.expire(k, windowSeconds);
    return n > max;
  }

  private async limit(req: Request, action: string, perIp: number, email?: string, perEmail = 10) {
    const ip = clientIp(req) ?? 'unknown';
    if (await this.limited(`${action}:ip:${ip}`, perIp, 900)) throw tooMany();
    if (email && (await this.limited(`${action}:email:${email}`, perEmail, 900))) throw tooMany();
  }

  private mail(tenantId: string | null, to: string, template: MailTemplate, vars: Omit<MailVars, 'appUrl'>) {
    return enqueueMail(this.c.pool, { tenantId, to, template, vars: { appUrl: this.c.config.APP_URL, ...vars } });
  }

  private async audit(e: Omit<AuditEvent, 'ip' | 'requestId'>, req: Request) {
    const event: AuditEvent = { ...e, requestId: req.requestId, ip: clientIp(req) };
    if (e.tenantId) {
      await withTenantTx(this.c.pool, e.tenantId, (client) => audit(client, event));
    } else {
      // Platform chain (staff): audit_log's insert policy admits only tenant rows for the API role.
      await this.c.pool.query(`SELECT audit_platform_event($1, $2, $3, $4, $5, $6, $7, $8)`, [
        event.actorType,
        event.actorId,
        event.action,
        event.entityType,
        event.entityId,
        event.requestId ?? null,
        event.ip ?? null,
        JSON.stringify(event.details ?? {}),
      ]);
    }
  }

  private weakPassword(problems: string[]) {
    return new ApiError(400, 'weak_password', problems.join(' '), { problems });
  }

  private link(path: string, token: string) {
    return `${this.c.config.APP_URL}${path}#token=${token}`; // fragment: never sent to a server or logged
  }

  /** The session and csrf cookie names for a kind of session. */
  cookiesFor(kind: SessionKind) {
    return kind === 'staff'
      ? { session: this.names.staffSession, csrf: this.names.staffCsrf }
      : kind === 'vendor'
        ? { session: this.names.vendorSession, csrf: this.names.vendorCsrf }
        : { session: this.names.userSession, csrf: this.names.userCsrf };
  }

  /** A fresh csrf cookie for a visitor without a session (sign-in, sign-up forms). */
  issueCsrf(res: Response, kind: SessionKind): string {
    const csrf = crypto.randomBytes(32).toString('base64url');
    setCookie(res, this.cookiesFor(kind).csrf, csrf, { secure: this.c.cookieSecure, httpOnly: false });
    return csrf;
  }

  async startSession(req: Request, res: Response, kind: SessionKind, subjectId: string, tenantId: string | null, role: string, stage: 'full' | 'mfa_setup') {
    const { token, data } = await this.c.sessions.create({
      kind,
      subjectId,
      tenantId,
      role,
      stage,
      ip: clientIp(req),
      userAgent: req.header('user-agent')?.slice(0, 200) ?? null,
    });
    const secure = this.c.cookieSecure;
    setCookie(res, this.cookiesFor(kind).session, token, { secure, httpOnly: true });
    setCookie(res, this.cookiesFor(kind).csrf, data.csrf, { secure, httpOnly: false });
    return { token, data };
  }

  private mfaRequired(role: string) {
    return (MFA_REQUIRED_ROLES as readonly string[]).includes(role);
  }

  // ── sign-up and email verification ──────────────────────────────────────────────────
  async signup(req: Request, b: { organisation_name: string; full_name: string; email: string; password: string }) {
    await this.limit(req, 'signup', 10, b.email, 3);
    const problems = passwordProblems(b.password, { email: b.email, name: b.full_name });
    if (problems.length) throw this.weakPassword(problems);
    const created = await this.c.accounts.signup(b.organisation_name, b.full_name, b.email, await hashPassword(b.password));
    if (!created) {
      // Same answer as a new sign-up; the account holder hears about the attempt.
      const existing = await this.c.accounts.findUser(b.email);
      await this.mail(existing?.tenant_id ?? null, b.email, 'signup_exists', { name: existing?.full_name ?? null });
      return;
    }
    const { token, hash } = newOpaqueToken();
    await this.c.accounts.issueToken('verify_email', hash, { tenantId: created.tenant_id, userId: created.user_id, email: b.email, ttlSeconds: VERIFY_TTL });
    await this.mail(created.tenant_id, b.email, 'verify_email', { name: b.full_name, org: b.organisation_name, link: this.link('/verify-email', token) });
    await this.audit({ tenantId: created.tenant_id, actorType: 'user', actorId: created.user_id, action: 'account.signed_up', entityType: 'tenant', entityId: created.tenant_id }, req);
  }

  async verifyEmail(req: Request, token: string) {
    const t = await this.c.accounts.consumeToken('verify_email', tokenHash(token));
    if (!t?.user_id) throw new ApiError(400, 'invalid_link', 'This link has expired or was already used. Sign in to get a new one.');
    await this.c.accounts.markEmailVerified(t.user_id);
    await this.audit({ tenantId: t.tenant_id, actorType: 'user', actorId: t.user_id, action: 'account.email_verified', entityType: 'user', entityId: t.user_id }, req);
  }

  async resendVerification(req: Request, email: string) {
    await this.limit(req, 'resend', 10, email, 3);
    const u = await this.c.accounts.findUser(email);
    if (!u || u.email_verified_at) return;
    const { token, hash } = newOpaqueToken();
    await this.c.accounts.issueToken('verify_email', hash, { tenantId: u.tenant_id, userId: u.user_id, email: u.email, ttlSeconds: VERIFY_TTL });
    await this.mail(u.tenant_id, u.email, 'verify_email', { name: u.full_name, org: u.legal_name, link: this.link('/verify-email', token) });
  }

  // ── sign-in ─────────────────────────────────────────────────────────────────────────
  /** Returns either a session (no MFA enrolled) or a challenge for the second factor. */
  async login(req: Request, res: Response, email: string, password: string): Promise<{ mfa_required: true; challenge: string } | { mfa_required: false; session: SessionView }> {
    await this.limit(req, 'login', 50, email, 10);
    const { AUTH_MAX_FAILURES: max, AUTH_LOCK_MINUTES: lockMin } = this.c.config;
    const u = await this.c.accounts.findUser(email);
    if (!u) {
      await spendPasswordCheck(password);
      throw invalidCredentials();
    }
    if (u.locked_until && u.locked_until > new Date()) {
      await spendPasswordCheck(password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(u.password_hash, password))) {
      const r = await this.c.accounts.recordLogin(u.user_id, false, max, lockMin);
      await this.audit({ tenantId: u.tenant_id, actorType: 'user', actorId: u.user_id, action: 'account.sign_in_failed', entityType: 'user', entityId: u.user_id }, req);
      if (r?.locked_until) {
        await this.mail(u.tenant_id, u.email, 'account_locked', { name: u.full_name, minutes: lockMin });
        await this.audit({ tenantId: u.tenant_id, actorType: 'system', actorId: null, action: 'account.locked', entityType: 'user', entityId: u.user_id }, req);
      }
      throw invalidCredentials();
    }
    if (u.tenant_status !== 'active') throw new ApiError(403, 'account_suspended', 'This organisation’s account is suspended. Contact TshepoVet support.');
    if (!u.email_verified_at) throw new ApiError(403, 'email_unverified', 'Confirm your email address first. We can send the link again.');
    // The failure count is cleared only by a complete sign-in. With two-step verification the
    // password alone is half of one: clearing it here would let anyone who has the password
    // guess codes for ever, four at a time between sign-ins (security review, M9).
    if (u.mfa_enrolled) {
      return { mfa_required: true, challenge: await this.c.mfa.create('user', u.user_id) };
    }
    await this.c.accounts.recordLogin(u.user_id, true, max, lockMin);
    const stage = this.mfaRequired(u.role) ? 'mfa_setup' : 'full';
    const s = await this.startSession(req, res, 'user', u.user_id, u.tenant_id, u.role, stage);
    await this.audit({ tenantId: u.tenant_id, actorType: 'user', actorId: u.user_id, action: 'account.signed_in', entityType: 'user', entityId: u.user_id, details: { mfa: false } }, req);
    return { mfa_required: false, session: (await this.view(s.data))! };
  }

  /** Checks a TOTP code (no replay) or spends a recovery code. */
  private async secondFactor(kind: SessionKind, subjectId: string, secretEnc: Buffer | null, b: { code?: string; recovery_code?: string }): Promise<boolean> {
    if (b.recovery_code) {
      const subject = kind === 'staff' ? { staffId: subjectId } : { userId: subjectId };
      return this.c.accounts.useRecoveryCode(subject, recoveryCodeHash(b.recovery_code));
    }
    if (!b.code || !secretEnc) return false;
    const secret = (await this.c.crypto.decrypt(secretEnc, `mfa_secret:${subjectId}`)).toString('utf8');
    const step = verifyTotp(secret, b.code, { notAfterStep: await this.c.mfa.lastStep(kind, subjectId) });
    if (step === null) return false;
    await this.c.mfa.recordStep(kind, subjectId, step);
    return true;
  }

  async completeMfa(req: Request, res: Response, b: { challenge: string; code?: string; recovery_code?: string }): Promise<SessionView> {
    await this.limit(req, 'mfa', 30);
    const expired = () => new ApiError(401, 'challenge_expired', 'This sign-in has expired. Start again.');
    const ch = await this.c.mfa.get(b.challenge);
    if (!ch || ch.kind !== 'user') throw expired();
    // Counted before the check: concurrent guesses cannot exceed the limit.
    if (!(await this.c.mfa.attempt(b.challenge))) throw expired();
    const u = await this.c.accounts.userById(ch.subjectId);
    if (!u || u.disabled_at) throw expired();
    if (!(await this.secondFactor('user', u.user_id, u.mfa_secret_enc, b))) {
      // A wrong second factor also counts toward the account lockout.
      const { AUTH_MAX_FAILURES: max, AUTH_LOCK_MINUTES: lockMin } = this.c.config;
      const r = await this.c.accounts.recordLogin(u.user_id, false, max, lockMin);
      await this.audit({ tenantId: u.tenant_id, actorType: 'user', actorId: u.user_id, action: 'account.mfa_failed', entityType: 'user', entityId: u.user_id }, req);
      if (r?.locked_until) {
        await this.c.mfa.consume(b.challenge);
        await this.mail(u.tenant_id, u.email, 'account_locked', { name: u.full_name, minutes: lockMin });
        await this.audit({ tenantId: u.tenant_id, actorType: 'system', actorId: null, action: 'account.locked', entityType: 'user', entityId: u.user_id }, req);
      }
      throw new ApiError(401, 'invalid_code', 'That code is not right. Check your authenticator app and try again.');
    }
    await this.c.accounts.recordLogin(u.user_id, true, this.c.config.AUTH_MAX_FAILURES, this.c.config.AUTH_LOCK_MINUTES);
    await this.c.mfa.consume(b.challenge);
    const s = await this.startSession(req, res, 'user', u.user_id, u.tenant_id, u.role, 'full');
    await this.audit(
      { tenantId: u.tenant_id, actorType: 'user', actorId: u.user_id, action: 'account.signed_in', entityType: 'user', entityId: u.user_id, details: { mfa: b.recovery_code ? 'recovery_code' : 'totp' } },
      req,
    );
    return (await this.view(s.data))!;
  }

  async logout(req: Request, res: Response) {
    if (req.portal) {
      await this.c.sessions.destroy(req.portal.token);
      await this.audit({ tenantId: req.portal.session.tenantId, actorType: 'user', actorId: req.portal.session.subjectId, action: 'account.signed_out', entityType: 'user', entityId: req.portal.session.subjectId }, req);
    }
    clearCookie(res, this.names.userSession, this.c.cookieSecure);
  }

  /** The current session as the web app sees it; null (and the session ended) if the user or organisation is gone. */
  async view(s: SessionData, token?: string): Promise<SessionView | null> {
    const u = await this.c.accounts.userById(s.subjectId);
    if (!u || u.disabled_at || u.tenant_status !== 'active') {
      if (token) await this.c.sessions.destroy(token);
      return null;
    }
    if (u.role !== s.role && token) await this.c.sessions.update(token, { role: u.role });
    return {
      user: { id: u.user_id, email: u.email, full_name: u.full_name, role: u.role, mfa_enrolled: u.mfa_enrolled },
      organisation: { id: u.tenant_id, legal_name: u.legal_name },
      stage: s.stage,
      permissions: s.stage === 'full' ? [...(ROLE_PERMISSIONS[u.role as Role] ?? [])] : [],
      csrf_token: s.csrf,
    };
  }

  // ── passwords ───────────────────────────────────────────────────────────────────────
  async forgotPassword(req: Request, email: string) {
    await this.limit(req, 'forgot', 10, email, 3);
    const u = await this.c.accounts.findUser(email);
    if (!u) {
      await this.mail(null, email, 'reset_unknown', {});
      return;
    }
    const { token, hash } = newOpaqueToken();
    await this.c.accounts.issueToken('reset_password', hash, { tenantId: u.tenant_id, userId: u.user_id, email: u.email, ttlSeconds: RESET_TTL });
    await this.mail(u.tenant_id, u.email, 'reset_password', { name: u.full_name, link: this.link('/reset-password', token) });
    await this.audit({ tenantId: u.tenant_id, actorType: 'user', actorId: u.user_id, action: 'account.password_reset_requested', entityType: 'user', entityId: u.user_id }, req);
  }

  async resetPassword(req: Request, token: string, password: string) {
    // Context-free rules first, so a weak choice does not spend the link.
    const early = passwordProblems(password);
    if (early.length) throw this.weakPassword(early);
    const t = await this.c.accounts.consumeToken('reset_password', tokenHash(token));
    if (!t?.user_id) throw new ApiError(400, 'invalid_link', 'This link has expired or was already used. Ask for a new one.');
    await this.c.accounts.setPassword(t.user_id, await hashPassword(password));
    await this.c.accounts.markEmailVerified(t.user_id); // the link proved the address
    await this.c.sessions.destroyAll('user', t.user_id);
    const u = await this.c.accounts.userById(t.user_id);
    if (u) await this.mail(u.tenant_id, u.email, 'password_changed', { name: u.full_name });
    await this.audit({ tenantId: t.tenant_id, actorType: 'user', actorId: t.user_id, action: 'account.password_reset', entityType: 'user', entityId: t.user_id }, req);
  }

  async changePassword(req: Request, current: string, next: string) {
    const s = req.portal!.session;
    const u = await this.c.accounts.userById(s.subjectId);
    if (!u || !(await verifyPassword(u.password_hash, current))) throw new ApiError(400, 'wrong_password', 'Your current password is not right.');
    const problems = passwordProblems(next, { email: u.email, name: u.full_name });
    if (problems.length) throw this.weakPassword(problems);
    await this.c.accounts.setPassword(u.user_id, await hashPassword(next));
    await this.c.sessions.destroyAll('user', u.user_id, req.portal!.token);
    await this.mail(u.tenant_id, u.email, 'password_changed', { name: u.full_name });
    await this.audit({ tenantId: u.tenant_id, actorType: 'user', actorId: u.user_id, action: 'account.password_changed', entityType: 'user', entityId: u.user_id }, req);
  }

  // ── two-step verification ───────────────────────────────────────────────────────────
  async mfaSetup(kind: SessionKind, s: SessionData, accountEmail: string) {
    const secret = generateTotpSecret();
    await this.c.mfa.setPendingSecret(kind, s.subjectId, secret);
    return { secret, otpauth_uri: otpauthUri(kind === 'staff' ? 'TshepoVet Staff' : 'TshepoVet', accountEmail, secret) };
  }

  async mfaEnable(req: Request, kind: SessionKind, token: string, s: SessionData, code: string): Promise<{ recovery_codes: string[] }> {
    const secret = await this.c.mfa.takePendingSecret(kind, s.subjectId);
    if (!secret) throw new ApiError(409, 'mfa_setup_expired', 'Start setting up two-step verification again.');
    const step = verifyTotp(secret, code);
    if (step === null) throw new ApiError(400, 'invalid_code', 'That code is not right. Check the time on your phone and try again.');
    await this.c.mfa.recordStep(kind, s.subjectId, step);
    const enc = await this.c.crypto.encrypt(secret, `mfa_secret:${s.subjectId}`);
    const codes = newRecoveryCodes();
    const subject = kind === 'staff' ? { staffId: s.subjectId } : { userId: s.subjectId };
    if (kind === 'staff') await this.c.accounts.staffSetMfa(s.subjectId, enc, true);
    else await this.c.accounts.setMfa(s.subjectId, enc, true);
    await this.c.accounts.replaceRecoveryCodes(subject, codes.map(recoveryCodeHash));
    await this.c.mfa.clearPendingSecret(kind, s.subjectId);
    // Only the session that completed enrolment is promoted; every other session of the
    // account (signed in with a password alone) ends.
    if (s.stage === 'mfa_setup') await this.c.sessions.update(token, { stage: 'full' });
    await this.c.sessions.destroyAll(kind, s.subjectId, token);
    await this.mfaChanged(req, kind, s, 'Two-step verification was turned on');
    return { recovery_codes: codes };
  }

  async mfaDisable(req: Request, s: SessionData, password: string, code: string) {
    if (this.mfaRequired(s.role)) throw new ApiError(409, 'mfa_required_for_role', 'Owners and administrators must keep two-step verification on.');
    const u = await this.c.accounts.userById(s.subjectId);
    if (!u || !(await verifyPassword(u.password_hash, password))) throw new ApiError(400, 'wrong_password', 'Your password is not right.');
    if (!(await this.secondFactor('user', u.user_id, u.mfa_secret_enc, { code }))) throw new ApiError(400, 'invalid_code', 'That code is not right.');
    await this.c.accounts.setMfa(u.user_id, null, false);
    await this.c.accounts.replaceRecoveryCodes({ userId: u.user_id }, []);
    await this.mfaChanged(req, 'user', s, 'Two-step verification was turned off');
  }

  async regenerateRecoveryCodes(req: Request, kind: SessionKind, s: SessionData, password: string): Promise<{ recovery_codes: string[] }> {
    const rec = kind === 'staff' ? await this.c.accounts.staffById(s.subjectId) : await this.c.accounts.userById(s.subjectId);
    if (!rec || !rec.mfa_enrolled) throw new ApiError(409, 'mfa_not_enabled', 'Turn on two-step verification first.');
    if (!(await verifyPassword(rec.password_hash, password))) throw new ApiError(400, 'wrong_password', 'Your password is not right.');
    const codes = newRecoveryCodes();
    await this.c.accounts.replaceRecoveryCodes(kind === 'staff' ? { staffId: s.subjectId } : { userId: s.subjectId }, codes.map(recoveryCodeHash));
    await this.mfaChanged(req, kind, s, 'New recovery codes were created; the old ones no longer work');
    return { recovery_codes: codes };
  }

  private async mfaChanged(req: Request, kind: SessionKind, s: SessionData, change: string) {
    const rec = kind === 'staff' ? await this.c.accounts.staffById(s.subjectId) : await this.c.accounts.userById(s.subjectId);
    if (rec) await this.mail(s.tenantId, rec.email, 'mfa_changed', { name: rec.full_name, change });
    await this.audit(
      { tenantId: s.tenantId, actorType: kind === 'staff' ? 'tshepovet_staff' : 'user', actorId: s.subjectId, action: 'account.mfa_changed', entityType: kind, entityId: s.subjectId, details: { change } },
      req,
    );
  }

  // ── sessions ────────────────────────────────────────────────────────────────────────
  async listSessions(kind: SessionKind, current: SessionData) {
    const all = await this.c.sessions.list(kind, current.subjectId);
    return all.map((s) => ({
      id: s.sid,
      current: s.sid === current.sid,
      created_at: new Date(s.createdAt).toISOString(),
      last_seen_at: new Date(s.lastSeenAt).toISOString(),
      ip: s.ip,
      user_agent: s.userAgent,
    }));
  }

  // ── invitations ─────────────────────────────────────────────────────────────────────
  async invite(req: Request, s: SessionData, email: string, role: Role) {
    const inviter = await this.c.accounts.userById(s.subjectId);
    if (!inviter) throw new ApiError(401, 'unauthorized', 'Sign in again.');
    const { token, hash } = newOpaqueToken();
    const id = await this.c.accounts.issueToken('invite', hash, { tenantId: s.tenantId, email, role, ttlSeconds: INVITE_TTL, createdBy: s.subjectId });
    await this.mail(s.tenantId, email, 'invite', { inviter: inviter.full_name, org: inviter.legal_name, role: ROLE_LABEL(role), link: this.link('/accept-invite', token) });
    await this.audit({ tenantId: s.tenantId, actorType: 'user', actorId: s.subjectId, action: 'team.invited', entityType: 'invitation', entityId: id, details: { role } }, req);
    return id;
  }

  async acceptInvite(req: Request, res: Response, token: string, fullName: string, password: string): Promise<SessionView> {
    const peek = await this.c.accounts.peekInvite(tokenHash(token));
    if (!peek) throw new ApiError(400, 'invalid_link', 'This invitation has expired or was already used. Ask for a new one.');
    const problems = passwordProblems(password, { email: peek.email, name: fullName });
    if (problems.length) throw this.weakPassword(problems);
    let r;
    try {
      r = await this.c.accounts.acceptInvite(tokenHash(token), fullName, await hashPassword(password));
    } catch (err) {
      if (err instanceof EmailInUseError) throw new ApiError(409, 'email_in_use', 'This email address already has a TshepoVet account. Sign in with it, or ask for an invitation to another address.');
      throw err;
    }
    if (!r) throw new ApiError(400, 'invalid_link', 'This invitation has expired or was already used. Ask for a new one.');
    await this.audit({ tenantId: r.tenant_id, actorType: 'user', actorId: r.user_id, action: 'team.invitation_accepted', entityType: 'user', entityId: r.user_id, details: { role: r.role } }, req);
    const s = await this.startSession(req, res, 'user', r.user_id, r.tenant_id, r.role, this.mfaRequired(r.role) ? 'mfa_setup' : 'full');
    return (await this.view(s.data))!;
  }

  // ── staff ───────────────────────────────────────────────────────────────────────────
  /** Staff always use MFA: a staff member without it gets an mfa_setup session. */
  async staffLogin(req: Request, res: Response, email: string, password: string): Promise<{ mfa_required: true; challenge: string } | { mfa_required: false; session: StaffSessionView }> {
    await this.limit(req, 'staff_login', 20, email, 5);
    const { AUTH_MAX_FAILURES: max, AUTH_LOCK_MINUTES: lockMin } = this.c.config;
    const st = await this.c.accounts.staffFind(email);
    if (!st || (st.locked_until && st.locked_until > new Date())) {
      await spendPasswordCheck(password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(st.password_hash, password))) {
      await this.c.accounts.staffRecordLogin(st.staff_id, false, max, lockMin);
      await this.audit({ tenantId: null, actorType: 'tshepovet_staff', actorId: st.staff_id, action: 'staff.sign_in_failed', entityType: 'staff', entityId: st.staff_id }, req);
      throw invalidCredentials();
    }
    // As for buyers: only a complete sign-in clears the failure count.
    if (st.mfa_enrolled) return { mfa_required: true, challenge: await this.c.mfa.create('staff', st.staff_id) };
    await this.c.accounts.staffRecordLogin(st.staff_id, true, max, lockMin);
    const s = await this.startSession(req, res, 'staff', st.staff_id, null, st.role, 'mfa_setup');
    await this.audit({ tenantId: null, actorType: 'tshepovet_staff', actorId: st.staff_id, action: 'staff.signed_in', entityType: 'staff', entityId: st.staff_id, details: { mfa: false } }, req);
    return { mfa_required: false, session: (await this.staffView(s.data))! };
  }

  async staffCompleteMfa(req: Request, res: Response, b: { challenge: string; code?: string; recovery_code?: string }): Promise<StaffSessionView> {
    await this.limit(req, 'staff_mfa', 20);
    const expired = () => new ApiError(401, 'challenge_expired', 'This sign-in has expired. Start again.');
    const ch = await this.c.mfa.get(b.challenge);
    if (!ch || ch.kind !== 'staff') throw expired();
    if (!(await this.c.mfa.attempt(b.challenge))) throw expired();
    const st = await this.c.accounts.staffById(ch.subjectId);
    if (!st || st.disabled_at) throw expired();
    if (!(await this.secondFactor('staff', st.staff_id, st.mfa_secret_enc, b))) {
      const { AUTH_MAX_FAILURES: max, AUTH_LOCK_MINUTES: lockMin } = this.c.config;
      const r = await this.c.accounts.staffRecordLogin(st.staff_id, false, max, lockMin);
      if (r?.locked_until) await this.c.mfa.consume(b.challenge);
      await this.audit({ tenantId: null, actorType: 'tshepovet_staff', actorId: st.staff_id, action: 'staff.mfa_failed', entityType: 'staff', entityId: st.staff_id }, req);
      throw new ApiError(401, 'invalid_code', 'That code is not right.');
    }
    await this.c.accounts.staffRecordLogin(st.staff_id, true, this.c.config.AUTH_MAX_FAILURES, this.c.config.AUTH_LOCK_MINUTES);
    await this.c.mfa.consume(b.challenge);
    const s = await this.startSession(req, res, 'staff', st.staff_id, null, st.role, 'full');
    await this.audit({ tenantId: null, actorType: 'tshepovet_staff', actorId: st.staff_id, action: 'staff.signed_in', entityType: 'staff', entityId: st.staff_id, details: { mfa: true } }, req);
    return (await this.staffView(s.data))!;
  }

  async staffView(s: SessionData, token?: string): Promise<StaffSessionView | null> {
    const st = await this.c.accounts.staffById(s.subjectId);
    if (!st || st.disabled_at) {
      if (token) await this.c.sessions.destroy(token);
      return null;
    }
    return { staff: { id: st.staff_id, email: st.email, full_name: st.full_name, role: st.role, mfa_enrolled: st.mfa_enrolled }, stage: s.stage, csrf_token: s.csrf };
  }

  async staffLogout(req: Request, res: Response) {
    if (req.staff) await this.c.sessions.destroy(req.staff.token);
    clearCookie(res, this.names.staffSession, this.c.cookieSecure);
  }
}

function ROLE_LABEL(role: Role): string {
  return { owner: 'an owner', admin: 'an administrator', compliance_officer: 'a compliance officer', procurement: 'procurement', ap_clerk: 'accounts payable', viewer: 'a viewer' }[role];
}
