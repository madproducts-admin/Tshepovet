import Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OnboardingStateSchema,
  PassportVerifyResultSchema,
  PublicPassportSchema,
  SupplierDetailSchema,
  SupplierInviteSchema,
  VendorPortalSchema,
} from '@tshepovet/contracts';
import { buildTestApp, ownerPool, resetDatabase } from './harness';
import { Browser, ownerWithMfa } from './portal-helpers';

/**
 * The supplier's side end to end (docs/PLAN.md M6): a buyer's invitation, onboarding with the
 * sandbox's sample documents, the checks it charges to the buyer, the published passport and
 * its printed code, and the supplier's own sign-in to control the passport, consents and
 * requests. Every response is parsed with its strict contract.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
let buyer: Awaited<ReturnType<typeof ownerWithMfa>>;
let supplierId = '';
let inviteToken = '';
const SUPPLIER_EMAIL = 'director@acme-supplier.example';
const BUYER = 'Supplier Side Buyers (Pty) Ltd';

const parse = <T extends z.ZodType>(schema: T, res: request.Response, status = 200): z.infer<T> => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const r = schema.safeParse(res.body);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 1)).toBe(true);
  return r.data as z.infer<T>;
};

async function token(to: string, template: string, path: string) {
  const r = await owner.query<{ body_text: string }>(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`, [to, template]);
  const m = r.rows[0]?.body_text.match(new RegExp(`${path}#token=([A-Za-z0-9_-]{43})`));
  expect(m, `${template} link`).toBeTruthy();
  return m![1]!;
}

/** The supplier's browser during onboarding: the CSRF pair, plus the invitation token header. */
class Onboarder {
  b: Browser;
  constructor(private readonly tok: string) {
    this.b = new Browser(t.app);
  }
  async init() {
    await this.b.init();
    return this;
  }
  get() {
    return this.b.agent.get('/api/onboarding').set('x-onboarding-token', this.tok);
  }
  post(path: string, body: unknown) {
    return this.b.agent.post(`/api/onboarding/${path}`).set('x-csrf-token', this.b.csrf).set('x-onboarding-token', this.tok).send(body as object);
  }
}

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  t = await buildTestApp();
  buyer = await ownerWithMfa(t.app, owner, 'buyer@supplier-side.example', 'Supplier Side Buyers (Pty) Ltd');
  expect((await buyer.b.post('/api/wallet/topups', { credit_cents: 100_000 })).status).toBe(201);
  const s = await buyer.b.post('/api/suppliers', { registration_number: '2019/123456/07' });
  supplierId = s.body.id;
}, 120_000);

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('onboarding from a buyer’s invitation', () => {
  it('invites the supplier by email, with only the newest link working', async () => {
    parse(SupplierInviteSchema, await buyer.b.post(`/api/suppliers/${supplierId}/invitations`, { email: 'old@acme-supplier.example' }), 201);
    const old = await token('old@acme-supplier.example', 'vendor_invite', '/onboard');
    const inv = parse(SupplierInviteSchema, await buyer.b.post(`/api/suppliers/${supplierId}/invitations`, { email: SUPPLIER_EMAIL, contact_name: 'Thandi Mokoena' }), 201);
    expect(inv.email).toBe(SUPPLIER_EMAIL);
    inviteToken = await token(SUPPLIER_EMAIL, 'vendor_invite', '/onboard');
    const stale = await new Onboarder(old).init();
    expect((await stale.get()).status).toBe(404);
    const list = await buyer.b.get(`/api/suppliers/${supplierId}/invitations`);
    expect(list.body.map((i: { revoked_at: string | null }) => i.revoked_at !== null)).toEqual([false, true]);
    expect((await buyer.b.get(`/api/suppliers/${supplierId}`)).body.relationship.status).toBe('invited');
  });

  it('refuses a request without the token, or with a wrong one', async () => {
    const o = await new Onboarder('x'.repeat(43)).init();
    expect((await o.get()).status).toBe(404);
    expect((await o.b.agent.get('/api/onboarding')).status).toBe(404);
  });

  it('walks through consent, the register, documents, bank, tax and submit', async () => {
    const o = await new Onboarder(inviteToken).init();
    const s0 = parse(OnboardingStateSchema, await o.get());
    expect(s0).toMatchObject({ buyer: 'Supplier Side Buyers (Pty) Ltd', consent_given: false, sandbox: true, invited_email: SUPPLIER_EMAIL });
    expect(s0.samples.length).toBeGreaterThan(3);
    expect((await o.post('documents', { kind: 'identity', sample: 'id_director' })).body.code).toBe('consent_first');

    const s1 = parse(OnboardingStateSchema, await o.post('start', { agree: true, full_name: 'Thandi Mokoena', role: 'Director' }));
    expect(s1.consent_given).toBe(true);
    expect(s1.company).toMatchObject({ state: 'found', legal_name: 'ACME TRADING (PTY) LTD', directors: ['THANDI MOKOENA'] });
    parse(OnboardingStateSchema, await o.post('company', { correct: true }));

    expect(parse(OnboardingStateSchema, await o.post('documents', { kind: 'identity', sample: 'id_blurry' })).identity.state).toBe('retake');
    expect(parse(OnboardingStateSchema, await o.post('documents', { kind: 'identity', sample: 'id_director' })).identity).toEqual({ state: 'accepted', is_director: true });
    expect((await o.post('documents', { kind: 'bbbee', sample: 'id_director' })).body.code).toBe('unknown_sample');

    const expired = parse(OnboardingStateSchema, await o.post('documents', { kind: 'bbbee', sample: 'bbbee_expired' })).bbbee;
    expect(expired.state).toBe('refused');
    expect(expired.reasons).toContain('The affidavit is more than 12 months old.');
    expect(parse(OnboardingStateSchema, await o.post('documents', { kind: 'bbbee', sample: 'bbbee_eme' })).bbbee).toMatchObject({ state: 'accepted', level: 1 });

    expect((await o.post('bank', { bank_name: 'FNB', account_number: '12', account_type: 'current' })).status).toBe(400);
    expect(parse(OnboardingStateSchema, await o.post('bank', { bank_name: 'FNB', account_number: '62012345678', account_type: 'current' })).bank).toEqual({ state: 'added', last4: '5678' });
    expect(parse(OnboardingStateSchema, await o.post('tax', { tax_reference_number: '9123456789', tcs_pin: 'AB12CD34EF' })).tax.state).toBe('compliant');

    const done = parse(OnboardingStateSchema, await o.post('submit', { publish_passport: true }));
    expect(done.submitted_at).not.toBeNull();
    expect((await o.post('submit', { publish_passport: true })).body.code).toBe('already_submitted');
  });

  it('lands in the buyer’s portal: status, documents, B-BBEE, bank, charges and the audit trail', async () => {
    const d = parse(SupplierDetailSchema, await buyer.b.get(`/api/suppliers/${supplierId}`));
    expect(d.relationship.status).toBe('pending_review');
    expect(d.bbbee).toMatchObject({ level: 1, status: 'accepted' });
    expect(d.bank_accounts).toEqual([expect.objectContaining({ bank_name: 'FNB', account_last4: '5678', avs_status: 'not_checked' })]);
    expect(d.documents.map((x) => x.document_type).sort()).toEqual(['bbbee_eme_affidavit', 'bbbee_eme_affidavit', 'sa_smart_id_card']);
    expect(JSON.stringify(d)).not.toContain('62012345678');
    const w = await buyer.b.get('/api/wallet');
    expect(w.body.balance_cents).toBe(100_000 - 600); // the register lookup and the tax check
    const trail = await buyer.b.get(`/api/suppliers/${supplierId}/audit`);
    const steps = trail.body.items.filter((i: { action: string }) => i.action.startsWith('onboarding.'));
    expect(steps.map((i: { actor: { type: string } }) => i.actor.type)).toEqual(steps.map(() => 'vendor_contact'));
    const mail = await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = 'buyer@supplier-side.example' AND template = 'supplier_onboarded'`);
    expect(mail.rowCount).toBe(1);
  });
});

let publicId = '';
let code = '';

describe('the public passport', () => {
  it('shows the verified facts, directors as initials, and a code for paper copies', async () => {
    publicId = (await owner.query<{ id: string }>(`SELECT passport_public_id AS id FROM vendors WHERE cipc_enterprise_number = '2019/123456/07'`)).rows[0]!.id;
    const p = parse(PublicPassportSchema, await request(t.app).get(`/api/passport/${publicId}`));
    expect(p).toMatchObject({ legal_name: 'ACME TRADING (PTY) LTD', registration_number: '2019/123456/07', directors: ['T.M.'], bbbee: { level: 1 } });
    expect(p.tcs?.status).toBe('compliant');
    code = p.verification_code;
    const v = parse(PassportVerifyResultSchema, await request(t.app).get('/api/passport/verify').query({ code }));
    expect(v).toMatchObject({ genuine: true, current: true, status: 'active', legal_name: 'ACME TRADING (PTY) LTD' });
    const forged = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    expect(parse(PassportVerifyResultSchema, await request(t.app).get('/api/passport/verify').query({ code: forged })).genuine).toBe(false);
    expect((await request(t.app).get('/api/passport/not-a-passport')).status).toBe(404);
  });
});

describe('another buyer onboarding the same supplier', () => {
  // Anyone can sign up as a buyer, add any company and invite an address they control. What
  // that onboarding enters stays theirs: it must not reach the first buyer, the passport or
  // the supplier's own sign-in unless the identity matched an active director.
  const ATTACKER = 'someone@not-acme.example';
  let other: Awaited<ReturnType<typeof ownerWithMfa>>;

  it('keeps an onboarding by someone who is not a director with the buyer that invited them', async () => {
    other = await ownerWithMfa(t.app, owner, 'buyer@other-buyer.example', 'Other Buyers (Pty) Ltd');
    expect((await other.b.post('/api/wallet/topups', { credit_cents: 100_000 })).status).toBe(201);
    const s = await other.b.post('/api/suppliers', { registration_number: '2019/123456/07' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const otherSupplierId = s.body.id;
    parse(SupplierInviteSchema, await other.b.post(`/api/suppliers/${otherSupplierId}/invitations`, { email: ATTACKER }), 201);
    const o = await new Onboarder(await token(ATTACKER, 'vendor_invite', '/onboard')).init();

    parse(OnboardingStateSchema, await o.post('start', { agree: true, full_name: 'Pieter van der Merwe', role: 'Director' }));
    parse(OnboardingStateSchema, await o.post('company', { correct: true }));
    expect(parse(OnboardingStateSchema, await o.post('documents', { kind: 'identity', sample: 'id_other_person' })).identity).toEqual({ state: 'review', is_director: false });
    parse(OnboardingStateSchema, await o.post('documents', { kind: 'bbbee', sample: 'bbbee_eme' }));
    parse(OnboardingStateSchema, await o.post('bank', { bank_name: 'Capitec', account_number: '1400999999', account_type: 'savings' }));
    expect((await o.post('bank', { bank_name: 'Capitec', account_number: '1400888888', account_type: 'savings' })).body.code).toBe('bank_already_added');
    parse(OnboardingStateSchema, await o.post('submit', { publish_passport: true }));
    expect((await o.post('skip', { step: 'tax' })).body.code).toBe('already_submitted');

    // The buyer that invited them sees what was entered, as its own.
    const mine = parse(SupplierDetailSchema, await other.b.get(`/api/suppliers/${otherSupplierId}`));
    expect(mine.bank_accounts.map((a) => a.account_last4).sort()).toEqual(['5678', '9999']);

    // The first buyer does not, and its record is as it was.
    const first = parse(SupplierDetailSchema, await buyer.b.get(`/api/suppliers/${supplierId}`));
    expect(first.bank_accounts.map((a) => a.account_last4)).toEqual(['5678']);
    expect(first.documents).toHaveLength(3);

    // Nothing became the supplier's shared record.
    const shared = await owner.query(
      `SELECT 'contact' FROM vendor_contacts WHERE email = $1 AND tenant_id IS NULL
       UNION ALL SELECT 'bank' FROM vendor_bank_accounts WHERE account_last4 = '9999' AND tenant_id IS NULL
       UNION ALL SELECT 'bbbee' FROM vendor_bbbee_profiles WHERE tenant_id = $2`,
      [ATTACKER, other.tenantId],
    );
    expect(shared.rows).toEqual([{ '?column?': 'bbbee' }]); // the profile exists, as the other buyer's own
    const submitted = await owner.query<{ details: { shared_record_updated: boolean; passport_published: boolean } }>(
      `SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'onboarding.submitted'`,
      [other.tenantId],
    );
    expect(submitted.rows[0]!.details).toMatchObject({ shared_record_updated: false, passport_published: false });

    // The passport still shows only what the director confirmed.
    const p = parse(PublicPassportSchema, await request(t.app).get(`/api/passport/${publicId}`));
    expect(p).toMatchObject({ legal_name: 'ACME TRADING (PTY) LTD', directors: ['T.M.'], bbbee: { level: 1 } });
  });

  it('gives that address no sign-in to the supplier’s self-service', async () => {
    const anon = await new Browser(t.app).init();
    const vcsrf = (await anon.agent.get('/api/vendor/auth/csrf')).body.csrf_token;
    expect((await anon.agent.post('/api/vendor/auth/magic-link').set('x-csrf-token', vcsrf).send({ email: ATTACKER })).body).toEqual({ status: 'check_email' });
    expect((await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = $1 AND template = 'vendor_login'`, [ATTACKER])).rowCount).toBe(0);
  });
});

describe('supplier self-service', () => {
  let s: Browser;
  it('signs in with a link sent to the onboarded address, and answers the same for anyone else', async () => {
    const anon = await new Browser(t.app).init();
    const vcsrf = (await anon.agent.get('/api/vendor/auth/csrf')).body.csrf_token;
    const send = (email: string) => anon.agent.post('/api/vendor/auth/magic-link').set('x-csrf-token', vcsrf).send({ email });
    expect((await send('nobody@nowhere.example')).body).toEqual({ status: 'check_email' });
    expect((await send(SUPPLIER_EMAIL)).body).toEqual({ status: 'check_email' });
    expect((await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = 'nobody@nowhere.example'`)).rowCount).toBe(0);

    s = new Browser(t.app);
    const csrf = (await s.agent.get('/api/vendor/auth/csrf')).body.csrf_token;
    const tok = await token(SUPPLIER_EMAIL, 'vendor_login', '/supplier/sign-in');
    const ex = await s.agent.post('/api/vendor/auth/exchange').set('x-csrf-token', csrf).send({ token: tok });
    expect(ex.status).toBe(200);
    s.csrf = ex.body.csrf_token;
    expect((await s.agent.post('/api/vendor/auth/exchange').set('x-csrf-token', s.csrf).send({ token: tok })).body.code).toBe('invalid_link');

    const me = parse(VendorPortalSchema, await s.agent.get('/api/vendor/me'));
    expect(me.contact).toEqual({ full_name: 'Thandi Mokoena', email: SUPPLIER_EMAIL });
    expect(me.vendor.passport_status).toBe('active');
    // Every buyer that holds the supplier is listed, including one whose onboarding was not promoted.
    expect(me.buyers.map((b) => b.buyer).sort()).toEqual(['Other Buyers (Pty) Ltd', 'Supplier Side Buyers (Pty) Ltd']);
    expect(me.consents.find((c) => c.buyer === BUYER)!.purposes.map((p) => p.purpose)).toContain('passport_sharing');
    // A supplier session opens nothing in the buyer portal.
    expect((await s.agent.get('/api/suppliers')).status).toBe(401);
  });

  it('withdraws and republishes the passport, choosing what it shows', async () => {
    const post = (path: string, body: unknown) => s.agent.post(path).set('x-csrf-token', s.csrf).send(body as object);
    expect((await post('/api/vendor/passport', { status: 'revoked', fields: ['legal_name'] })).status).toBe(204);
    expect((await request(t.app).get(`/api/passport/${publicId}`)).status).toBe(410);
    expect(parse(PassportVerifyResultSchema, await request(t.app).get('/api/passport/verify').query({ code })).status).toBe('withdrawn');
    expect((await post('/api/vendor/passport', { status: 'active', fields: ['legal_name', 'bbbee_level'] })).status).toBe(204);
    const p = parse(PublicPassportSchema, await request(t.app).get(`/api/passport/${publicId}`));
    expect(p).toMatchObject({ legal_name: 'ACME TRADING (PTY) LTD', registration_number: null, tcs: null, directors: null, bbbee: { level: 1 } });
  });

  it('withdraws consent to monitoring, which ends the buyer’s monitoring', async () => {
    expect((await buyer.b.post(`/api/monitoring/${supplierId}`, {})).status).toBe(201);
    const me = await s.agent.get('/api/vendor/me');
    const consent = me.body.consents.find((c: { buyer: string }) => c.buyer === BUYER).id;
    const r = await s.agent.post(`/api/vendor/consents/${consent}/withdraw`).set('x-csrf-token', s.csrf).send({ purposes: ['continuous_monitoring'] });
    expect(r.status).toBe(200);
    expect((await buyer.b.get('/api/monitoring')).body.counts.enrolled).toBe(0);
    const other = await s.agent.post(`/api/vendor/consents/00000000-0000-7000-8000-000000000000/withdraw`).set('x-csrf-token', s.csrf).send({});
    expect(other.status).toBe(404);
  });

  it('sends an access request to the buyer’s 30-day queue', async () => {
    const me = await s.agent.get('/api/vendor/me');
    const r = await s.agent.post('/api/vendor/requests').set('x-csrf-token', s.csrf).send({ relationship_id: me.body.buyers.find((b: { buyer: string }) => b.buyer === BUYER).relationship_id, request_type: 'access' });
    expect(r.status).toBe(201);
    const q = await buyer.b.get('/api/compliance/requests');
    expect(q.body.items[0]).toMatchObject({ request_type: 'access', status: 'received', days_left: 30, supplier_name: 'ACME TRADING (PTY) LTD' });
    const bad = await s.agent.post('/api/vendor/requests').set('x-csrf-token', s.csrf).send({ relationship_id: supplierId.replace(/.$/, '0'), request_type: 'access' });
    expect(bad.status).toBe(404);
  });
});

describe('a withdrawn invitation', () => {
  it('stops working at once', async () => {
    const inv = parse(SupplierInviteSchema, await buyer.b.post(`/api/suppliers/${supplierId}/invitations`, { email: 'second@acme-supplier.example' }), 201);
    const tok = await token('second@acme-supplier.example', 'vendor_invite', '/onboard');
    const o = await new Onboarder(tok).init();
    expect((await o.get()).status).toBe(200);
    expect((await buyer.b.del(`/api/suppliers/${supplierId}/invitations/${inv.id}`)).status).toBe(204);
    expect((await o.get()).status).toBe(404);
  });
});
