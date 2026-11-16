import Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, totpCode, totpStep } from '@tshepovet/core';
import { buildTestApp, ownerPool, resetDatabase } from './harness';

/**
 * Portal accounts end to end (docs/PLAN.md M2): sign-up, email verification, sign-in with
 * enforced two-step verification, recovery codes, lockout, enumeration-safe answers, password
 * reset, CSRF, invitations and roles, sessions, staff sign-in, and the database rules that
 * keep secrets away from the API role.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;

const PW = 'correct horse battery 42';
let visitor = 0;

/** A browser: keeps cookies, sends the CSRF header. */
class Browser {
  agent: ReturnType<typeof request.agent>;
  csrf = '';
  constructor(private readonly staff = false) {
    // Each browser is its own visitor (the per-IP sign-up and sign-in limits apply per client).
    this.agent = request.agent(t.app).set('cf-connecting-ip', `10.${++visitor >> 8 & 255}.${visitor & 255}.1`);
  }
  private base() {
    return this.staff ? '/api/staff/auth' : '/api/auth';
  }
  async init() {
    const r = await this.agent.get(`${this.base()}/csrf`);
    this.csrf = r.body.csrf_token;
    return this;
  }
  post(path: string, body: unknown = {}) {
    return this.agent.post(path).set('x-csrf-token', this.csrf).send(body as object);
  }
  patch(path: string, body: unknown = {}) {
    return this.agent.patch(path).set('x-csrf-token', this.csrf).send(body as object);
  }
  del(path: string) {
    return this.agent.delete(path).set('x-csrf-token', this.csrf);
  }
  get(path: string) {
    return this.agent.get(path);
  }
  adopt(res: request.Response) {
    const token = res.body?.session?.csrf_token ?? res.body?.csrf_token;
    if (token) this.csrf = token;
    return res;
  }
}

async function lastMail(to: string, template?: string) {
  const r = await owner.query<{ template: string; body_text: string }>(
    `SELECT template, body_text FROM email_outbox WHERE to_email = $1 ${template ? 'AND template = $2' : ''} ORDER BY created_at DESC LIMIT 1`,
    template ? [to, template] : [to],
  );
  return r.rows[0];
}

async function tokenFrom(to: string, template: string) {
  const m = await lastMail(to, template);
  const token = m?.body_text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  expect(token, `${template} link for ${to}`).toBeTruthy();
  return token!;
}

/** A TOTP code for the next step (the current one may already be spent by enrolment). */
const nextCode = (secret: string) => totpCode(secret, totpStep() + 1);

async function signUpVerified(email: string, org: string, name = 'Thandi Mokoena') {
  const b = await new Browser().init();
  const r = await b.post('/api/auth/signup', { organisation_name: org, full_name: name, email, password: PW, accept_terms: true });
  expect(r.status).toBe(202);
  const v = await b.post('/api/auth/verify-email', { token: await tokenFrom(email, 'verify_email') });
  expect(v.status).toBe(200);
  return b;
}

/** Signs an owner in and completes the enforced MFA enrolment; returns the browser and secret. */
async function ownerWithMfa(email: string, org: string) {
  const b = await signUpVerified(email, org);
  b.adopt(await b.post('/api/auth/login', { email, password: PW }));
  const setup = await b.post('/api/auth/mfa/setup');
  const secret = setup.body.secret as string;
  const en = await b.post('/api/auth/mfa/enable', { code: totpCode(secret, totpStep()) });
  expect(en.status).toBe(200);
  return { b, secret, recovery: en.body.recovery_codes as string[] };
}

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('sign-up and email verification', () => {
  it('signs up, refuses sign-in until the email is confirmed, and spends the link once', async () => {
    const b = await new Browser().init();
    const r = await b.post('/api/auth/signup', { organisation_name: 'Acme Trading (Pty) Ltd', full_name: 'Sipho Dlamini', email: 'sipho@acme.example', password: PW, accept_terms: true });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'check_email' });

    const early = await b.post('/api/auth/login', { email: 'sipho@acme.example', password: PW });
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('email_unverified');

    const token = await tokenFrom('sipho@acme.example', 'verify_email');
    expect((await b.post('/api/auth/verify-email', { token })).status).toBe(200);
    const again = await b.post('/api/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('invalid_link');

    // The tenant got a wallet with the sign-up.
    const w = await owner.query(`SELECT w.balance_cents FROM wallets w JOIN tenant_users u ON u.tenant_id = w.tenant_id WHERE u.email = 'sipho@acme.example'`);
    expect(w.rowCount).toBe(1);
  });

  it('rejects a weak password with plain-language reasons', async () => {
    const b = await new Browser().init();
    const r = await b.post('/api/auth/signup', { organisation_name: 'Weak Ltd', full_name: 'Lerato Nkosi', email: 'lerato@weak.example', password: 'lerato12345!', accept_terms: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('weak_password');
    expect(r.body.details.problems.length).toBeGreaterThan(0);
  });

  it('answers a sign-up with an existing email exactly like a new one, and tells the owner', async () => {
    await signUpVerified('dup@exists.example', 'Exists (Pty) Ltd');
    const b = await new Browser().init();
    const r = await b.post('/api/auth/signup', { organisation_name: 'Copycat Ltd', full_name: 'Someone Else', email: 'dup@exists.example', password: PW, accept_terms: true });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'check_email' });
    expect((await lastMail('dup@exists.example'))?.template).toBe('signup_exists');
    const tenants = await owner.query(`SELECT count(*)::int AS n FROM tenants WHERE legal_name = 'Copycat Ltd'`);
    expect(tenants.rows[0].n).toBe(0);
  });
});

describe('sign-in and two-step verification', () => {
  it('makes an owner enrol in MFA before anything else, then signs in with TOTP and recovery codes', async () => {
    const email = 'owner@mfa.example';
    const b = await signUpVerified(email, 'MFA Co (Pty) Ltd');
    const login = b.adopt(await b.post('/api/auth/login', { email, password: PW }));
    expect(login.status).toBe(200);
    expect(login.body.mfa_required).toBe(false);
    expect(login.body.session.stage).toBe('mfa_setup');
    expect(login.body.session.permissions).toEqual([]);

    const blocked = await b.get('/api/team');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('mfa_setup_required');

    const setup = await b.post('/api/auth/mfa/setup');
    // Label "Issuer:account" with the colon percent-encoded, as the otpauth format allows.
    expect(setup.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/TshepoVet%3Aowner%40mfa\.example\?secret=[A-Z2-7]{32}&issuer=TshepoVet/);
    const bad = await b.post('/api/auth/mfa/enable', { code: '000000' });
    expect(bad.status).toBe(400);
    const en = await b.post('/api/auth/mfa/enable', { code: totpCode(setup.body.secret, totpStep()) });
    expect(en.status).toBe(200);
    expect(en.body.recovery_codes).toHaveLength(10);

    const s = await b.get('/api/auth/session');
    expect(s.body.stage).toBe('full');
    expect(s.body.permissions).toContain('team:manage');
    expect((await b.get('/api/team')).status).toBe(200);

    // A fresh sign-in now needs the second factor.
    const b2 = await new Browser().init();
    const step1 = await b2.post('/api/auth/login', { email, password: PW });
    expect(step1.body).toEqual({ mfa_required: true, challenge: expect.any(String) });
    expect(String(step1.headers['set-cookie'] ?? '')).not.toContain('tv_session=');
    const wrong = await b2.post('/api/auth/mfa', { challenge: step1.body.challenge, code: '123456' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_code');
    const ok = b2.adopt(await b2.post('/api/auth/mfa', { challenge: step1.body.challenge, code: nextCode(setup.body.secret) }));
    expect(ok.status).toBe(200);
    expect(ok.body.session.user.email).toBe(email);
    // The same challenge cannot be used twice.
    expect((await b2.post('/api/auth/mfa', { challenge: step1.body.challenge, code: nextCode(setup.body.secret) })).status).toBe(401);

    // A recovery code works once.
    const code = en.body.recovery_codes[0];
    const b3 = await new Browser().init();
    const c1 = await b3.post('/api/auth/login', { email, password: PW });
    expect((await b3.post('/api/auth/mfa', { challenge: c1.body.challenge, recovery_code: code })).status).toBe(200);
    const b4 = await new Browser().init();
    const c2 = await b4.post('/api/auth/login', { email, password: PW });
    expect((await b4.post('/api/auth/mfa', { challenge: c2.body.challenge, recovery_code: code })).status).toBe(401);

    // Owners cannot turn MFA off.
    const off = await b.post('/api/auth/mfa/disable', { password: PW, code: nextCode(setup.body.secret) });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('mfa_required_for_role');
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await signUpVerified('real@same.example', 'Same (Pty) Ltd');
    const b = await new Browser().init();
    const unknown = await b.post('/api/auth/login', { email: 'nobody@same.example', password: PW });
    const wrong = await b.post('/api/auth/login', { email: 'real@same.example', password: 'not the password at all' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.code).toBe('invalid_credentials');
    expect(unknown.body.title).toBe(wrong.body.title);
  });

  it('locks an account after five wrong passwords, refuses even the right one, and says so by email', async () => {
    const email = 'locked@lock.example';
    await signUpVerified(email, 'Lock (Pty) Ltd');
    const b = await new Browser().init();
    for (let i = 0; i < 5; i++) expect((await b.post('/api/auth/login', { email, password: `wrong password ${i}` })).status).toBe(401);
    const right = await b.post('/api/auth/login', { email, password: PW });
    expect(right.status).toBe(401);
    expect(right.body.code).toBe('invalid_credentials');
    expect((await lastMail(email))?.template).toBe('account_locked');
    const a = await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'account.locked'`);
    expect(a.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('passwords', () => {
  it('resets a password: weak choices keep the link, a good one ends every session', async () => {
    const email = 'reset@reset.example';
    const signedIn = await signUpVerified(email, 'Reset (Pty) Ltd');
    // A non-owner role is simpler here: make this user a viewer directly.
    await owner.query(`UPDATE tenant_users SET role = 'procurement' WHERE email = $1`, [email]);
    signedIn.adopt(await signedIn.post('/api/auth/login', { email, password: PW }));
    expect((await signedIn.get('/api/auth/session')).status).toBe(200);

    const b = await new Browser().init();
    expect((await b.post('/api/auth/password/forgot', { email })).status).toBe(202);
    const token = await tokenFrom(email, 'reset_password');
    const weak = await b.post('/api/auth/password/reset', { token, password: 'short' });
    expect(weak.status).toBe(400);
    const ok = await b.post('/api/auth/password/reset', { token, password: 'a brand new long passphrase 7' });
    expect(ok.status).toBe(200);
    expect((await signedIn.get('/api/auth/session')).status).toBe(401);
    expect((await b.post('/api/auth/login', { email, password: PW })).status).toBe(401);
    expect((await b.post('/api/auth/login', { email, password: 'a brand new long passphrase 7' })).status).toBe(200);
    expect((await lastMail(email))?.template).toBe('password_changed');
  });

  it('answers forgot-password for an unknown email exactly as for a known one', async () => {
    const b = await new Browser().init();
    const r = await b.post('/api/auth/password/forgot', { email: 'ghost@nowhere.example' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'check_email' });
    expect((await lastMail('ghost@nowhere.example'))?.template).toBe('reset_unknown');
  });
});

describe('CSRF', () => {
  it('refuses a state-changing request without the matching token', async () => {
    const b = await new Browser().init();
    const none = await b.agent.post('/api/auth/login').send({ email: 'x@y.example', password: PW });
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('csrf_failed');
    const wrong = await b.agent.post('/api/auth/login').set('x-csrf-token', 'x'.repeat(43)).send({ email: 'x@y.example', password: PW });
    expect(wrong.status).toBe(403);
  });
});

describe('team: invitations and roles', () => {
  it('invites a member, enforces roles, and applies a role change at once', async () => {
    const { b: own } = await ownerWithMfa('boss@team.example', 'Team (Pty) Ltd');
    const inv = await own.post('/api/team/invitations', { email: 'buyer@team.example', role: 'procurement' });
    expect(inv.status).toBe(202);

    const token = await tokenFrom('buyer@team.example', 'invite');
    const anon = await new Browser().init();
    const peek = await anon.get(`/api/auth/invitations/${token}`);
    expect(peek.body).toMatchObject({ organisation: 'Team (Pty) Ltd', email: 'buyer@team.example', role: 'procurement' });

    const member = await new Browser().init();
    const acc = member.adopt(await member.post('/api/auth/invitations/accept', { token, full_name: 'Bongani Zulu', password: PW }));
    expect(acc.status).toBe(201);
    expect(acc.body.session.stage).toBe('full');
    expect(acc.body.session.permissions).toContain('checks:run');
    expect(acc.body.session.permissions).not.toContain('team:manage');

    // A procurement user cannot manage the team.
    const deny = await member.post('/api/team/invitations', { email: 'x@team.example', role: 'viewer' });
    expect(deny.status).toBe(403);
    expect(deny.body.code).toBe('forbidden');

    const list = await own.get('/api/team');
    const m = list.body.members.find((x: { email: string }) => x.email === 'buyer@team.example');
    expect(m.role).toBe('procurement');
    expect(Object.keys(m)).not.toContain('password_hash');

    // Role change takes effect in the member's live session.
    expect((await own.patch(`/api/team/members/${m.id}`, { role: 'viewer' })).status).toBe(200);
    const after = await member.get('/api/auth/session');
    expect(after.body.user.role).toBe('viewer');
    expect(after.body.permissions).not.toContain('checks:run');

    // Nobody changes themselves; the last owner stays an owner.
    const me = list.body.members.find((x: { email: string }) => x.email === 'boss@team.example');
    expect((await own.patch(`/api/team/members/${me.id}`, { role: 'admin' })).status).toBe(409);

    // Removing a member ends their sessions.
    expect((await own.post(`/api/team/members/${m.id}/disable`)).status).toBe(204);
    expect((await member.get('/api/auth/session')).status).toBe(401);
  });

  it('keeps each organisation\'s team private', async () => {
    const { b: a } = await ownerWithMfa('a@iso.example', 'Iso A (Pty) Ltd');
    await ownerWithMfa('b@iso.example', 'Iso B (Pty) Ltd');
    const list = await a.get('/api/team');
    expect(list.body.members.map((x: { email: string }) => x.email)).toEqual(['a@iso.example']);
  });
});

describe('sessions', () => {
  it('lists sessions and ends the others', async () => {
    const { b, secret } = await ownerWithMfa('multi@sess.example', 'Sessions (Pty) Ltd');
    const other = await new Browser().init();
    const c = await other.post('/api/auth/login', { email: 'multi@sess.example', password: PW });
    other.adopt(await other.post('/api/auth/mfa', { challenge: c.body.challenge, code: nextCode(secret) }));
    const list = await b.get('/api/auth/sessions');
    expect(list.body.sessions.length).toBe(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const r = await b.post('/api/auth/sessions/revoke-others');
    expect(r.body.ended).toBe(1);
    expect((await other.get('/api/auth/session')).status).toBe(401);
    expect((await b.get('/api/auth/session')).status).toBe(200);
  });
});

describe('staff sign-in', () => {
  it('requires MFA enrolment, then signs in with TOTP; staff and buyer sessions do not mix', async () => {
    await owner.query(`INSERT INTO staff_users (email, full_name, role, password_hash) VALUES ('ops@tshepovet.example', 'Ops Person', 'admin', $1)`, [await hashPassword(PW)]);
    const s = await new Browser(true).init();
    const login = s.adopt(await s.post('/api/staff/auth/login', { email: 'ops@tshepovet.example', password: PW }));
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.session.stage).toBe('mfa_setup');
    const setup = await s.post('/api/staff/auth/mfa/setup');
    const en = await s.post('/api/staff/auth/mfa/enable', { code: totpCode(setup.body.secret, totpStep()) });
    expect(en.status).toBe(200);
    expect((await s.get('/api/staff/auth/session')).body.stage).toBe('full');
    // A staff session is not a portal session.
    expect((await s.get('/api/auth/session')).status).toBe(401);

    const s2 = await new Browser(true).init();
    const c = await s2.post('/api/staff/auth/login', { email: 'ops@tshepovet.example', password: PW });
    expect(c.body.mfa_required).toBe(true);
    const ok = await s2.post('/api/staff/auth/mfa', { challenge: c.body.challenge, code: nextCode(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.session.staff.role).toBe('admin');
  });
});

describe('sessions follow the account (security review fixes)', () => {
  it('holds a member promoted to admin at MFA setup until they enrol', async () => {
    const { b: own } = await ownerWithMfa('boss@promote.example', 'Promote (Pty) Ltd');
    await own.post('/api/team/invitations', { email: 'clerk@promote.example', role: 'ap_clerk' });
    const member = await new Browser().init();
    member.adopt(await member.post('/api/auth/invitations/accept', { token: await tokenFrom('clerk@promote.example', 'invite'), full_name: 'Naledi Khumalo', password: PW }));
    expect((await member.get('/api/team')).status).toBe(200);

    const list = await own.get('/api/team');
    const m = list.body.members.find((x: { email: string }) => x.email === 'clerk@promote.example');
    expect((await own.patch(`/api/team/members/${m.id}`, { role: 'admin' })).status).toBe(200);

    const held = await member.get('/api/team');
    expect(held.status).toBe(403);
    expect(held.body.code).toBe('mfa_setup_required');
    expect((await member.get('/api/auth/session')).body.stage).toBe('mfa_setup');
  });

  it('caps concurrent second-factor guesses and counts them toward the lockout', async () => {
    const email = 'guess@mfa-cap.example';
    const { secret } = await ownerWithMfa(email, 'Guess (Pty) Ltd');
    const b = await new Browser().init();
    const c = await b.post('/api/auth/login', { email, password: PW });
    const results = await Promise.all(Array.from({ length: 8 }, () => b.post('/api/auth/mfa', { challenge: c.body.challenge, code: '000000' })));
    const codes = results.map((r) => r.body.code);
    expect(codes.filter((x) => x === 'invalid_code').length).toBeLessThanOrEqual(5);
    expect(results.every((r) => r.status === 401)).toBe(true);
    // Five wrong codes locked the account: even the right password and a fresh code fail now.
    const again = await b.post('/api/auth/login', { email, password: PW });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('invalid_credentials');
    expect(secret).toBeTruthy();
  });

  it('ends the sessions of a suspended organisation on their next request', async () => {
    const email = 'member@suspend.example';
    const b = await signUpVerified(email, 'Suspend (Pty) Ltd');
    await owner.query(`UPDATE tenant_users SET role = 'viewer' WHERE email = $1`, [email]);
    b.adopt(await b.post('/api/auth/login', { email, password: PW }));
    expect((await b.get('/api/auth/session')).status).toBe(200);
    await owner.query(`UPDATE tenants SET status = 'suspended' WHERE id = (SELECT tenant_id FROM tenant_users WHERE email = $1)`, [email]);
    expect((await b.get('/api/auth/session')).status).toBe(401);
    expect((await b.get('/api/team')).status).toBe(401);
  });
});

describe('audit trail', () => {
  it('records staff events on the platform chain and keeps every chain intact', async () => {
    const staff = await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id IS NULL AND actor_type = 'tshepovet_staff'`);
    expect(staff.rows[0].n).toBeGreaterThan(0);
    // verify_audit_chain() returns NULL for an intact chain, else the first broken position.
    const chains = await owner.query<{ tenant_id: string | null; broken: string | null }>(
      `SELECT k.tenant_id, verify_audit_chain(k.tenant_id) AS broken FROM (SELECT DISTINCT tenant_id FROM audit_log) k`,
    );
    expect(chains.rows.length).toBeGreaterThan(3);
    expect(chains.rows.filter((r) => r.broken !== null)).toEqual([]);
  });

  it('refuses a platform event that claims to be a user', async () => {
    const app = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 1 });
    try {
      await expect(app.query(`SELECT audit_platform_event('user', 'x', 'forged', 'user', 'x', NULL, NULL, '{}')`)).rejects.toThrow(/staff or system/);
    } finally {
      await app.end();
    }
  });
});

describe('database rules', () => {
  it('keeps password hashes and MFA secrets away from the API role', async () => {
    const app = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 1 });
    try {
      await expect(app.query(`SELECT password_hash FROM tenant_users LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`SELECT mfa_secret_enc FROM tenant_users LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`SELECT * FROM staff_users LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`SELECT token_hash FROM auth_tokens LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`SELECT * FROM recovery_codes LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`SELECT * FROM email_outbox LIMIT 1`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});
