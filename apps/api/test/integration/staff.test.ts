import Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hashPassword, totpCode, totpStep, WA_STREAM } from '@tshepovet/core';
import {
  PriceSchema,
  ReviewQueueSchema,
  StaffMailPageSchema,
  StaffMailSchema,
  StaffOverviewSchema,
  StaffProviderSchema,
  StaffRequestSchema,
  StaffTenantPageSchema,
  StaffTenantSchema,
  WaConversationSchema,
  WaMessageSchema,
} from '@tshepovet/contracts';
import { buildTestApp, ownerPool, resetDatabase } from './harness';
import { ownerWithMfa, PW } from './portal-helpers';

/**
 * The staff console's API (docs/PLAN.md M8): each staff role reaches only its routes; every
 * staff change and every look at a tenant lands in that tenant's audit chain; the review queue,
 * tenants, prices, bureaus, the mail outbox and the WhatsApp simulator, with strict contracts.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
let visitor = 300;

class Staff {
  agent: ReturnType<typeof request.agent>;
  csrf = '';
  constructor() {
    this.agent = request.agent(t.app).set('cf-connecting-ip', `10.9.${++visitor & 255}.1`);
  }
  async signIn(email: string, role: 'support' | 'reviewer' | 'admin') {
    await owner.query(`INSERT INTO staff_users (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4)`, [email, `${role} person`, role, await hashPassword(PW)]);
    this.csrf = (await this.agent.get('/api/staff/auth/csrf')).body.csrf_token;
    const login = await this.post('/api/staff/auth/login', { email, password: PW });
    this.csrf = login.body.session?.csrf_token ?? this.csrf;
    const setup = await this.post('/api/staff/auth/mfa/setup');
    expect((await this.post('/api/staff/auth/mfa/enable', { code: totpCode(setup.body.secret, totpStep()) })).status).toBe(200);
    return this;
  }
  get(path: string) {
    return this.agent.get(path);
  }
  post(path: string, body: unknown = {}) {
    return this.agent.post(path).set('x-csrf-token', this.csrf).send(body as object);
  }
  patch(path: string, body: unknown = {}) {
    return this.agent.patch(path).set('x-csrf-token', this.csrf).send(body as object);
  }
}

const parse = <T extends z.ZodType>(schema: T, res: request.Response, status = 200): z.infer<T> => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const r = schema.safeParse(res.body);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 1)).toBe(true);
  return r.data as z.infer<T>;
};

let admin: Staff;
let reviewer: Staff;
let support: Staff;
let buyer: Awaited<ReturnType<typeof ownerWithMfa>>;
let documentId = '';

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  t = await buildTestApp();
  admin = await new Staff().signIn('admin@tshepovet.example', 'admin');
  reviewer = await new Staff().signIn('reviewer@tshepovet.example', 'reviewer');
  support = await new Staff().signIn('support@tshepovet.example', 'support');
  buyer = await ownerWithMfa(t.app, owner, 'owner@staff-console.example', 'Staff Console Buyers (Pty) Ltd');
  const supplierId = (await buyer.b.post('/api/suppliers', { registration_number: '2019/123456/07' })).body.id;
  const vendorId = (await owner.query<{ vendor_id: string }>(`SELECT vendor_id FROM tenant_vendors WHERE id = $1`, [supplierId])).rows[0]!.vendor_id;
  documentId = (
    await owner.query<{ id: string }>(
      `INSERT INTO vendor_documents (vendor_id, tenant_id, document_type, sha256, mime_type, size_bytes, source_channel, review_status, review_flags,
                                     image_purge_after, record_purge_after)
       VALUES ($1, $2, 'sa_smart_id_card', '\\x00', 'image/jpeg', 10, 'portal', 'needs_review', '{not_listed_director}', now() + interval '30 days', now() + interval '5 years')
       RETURNING id`,
      [vendorId, buyer.tenantId],
    )
  ).rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('who may do what', () => {
  it('keeps each role to its routes, and buyers out altogether', async () => {
    expect((await support.get('/api/staff/review')).status).toBe(403);
    expect((await reviewer.get('/api/staff/tenants')).status).toBe(403);
    expect((await support.post(`/api/staff/tenants/${buyer.tenantId}/status`, { status: 'suspended', reason: 'x' })).status).toBe(403);
    expect((await support.get('/api/staff/providers')).status).toBe(403);
    expect((await buyer.b.get('/api/staff/overview')).status).toBe(401);
    expect((await request(t.app).get('/api/staff/overview')).status).toBe(401);
    const o = parse(StaffOverviewSchema, await support.get('/api/staff/overview'));
    expect(o).toMatchObject({ sandbox: true, review: { documents: 1 }, tenants: { active: 1 } });
  });
});

describe('the review queue', () => {
  it('shows why a document waits, and records who decided it', async () => {
    const q = parse(ReviewQueueSchema, await reviewer.get('/api/staff/review'));
    expect(q.documents).toEqual([expect.objectContaining({ id: documentId, supplier: 'PENDING VERIFICATION', flags: ['not_listed_director'], tenant: 'Staff Console Buyers (Pty) Ltd' })]);
    expect((await reviewer.post(`/api/staff/review/documents/${documentId}`, { decision: 'accepted' })).status).toBe(400);
    expect((await reviewer.post(`/api/staff/review/documents/${documentId}`, { decision: 'rejected', note: 'The photo is of a different card.' })).status).toBe(204);
    expect((await admin.post(`/api/staff/review/documents/${documentId}`, { decision: 'accepted', note: 'Second look.' })).body.code).toBe('already_decided');
    const d = await owner.query(`SELECT review_status, review_note, reviewed_by_staff IS NOT NULL AS by_staff FROM vendor_documents WHERE id = $1`, [documentId]);
    expect(d.rows[0]).toEqual({ review_status: 'rejected', review_note: 'The photo is of a different card.', by_staff: true });
    const a = await owner.query(`SELECT actor_type, details FROM audit_log WHERE tenant_id = $1 AND action = 'document.reviewed'`, [buyer.tenantId]);
    expect(a.rows[0]).toMatchObject({ actor_type: 'tshepovet_staff', details: { decision: 'rejected' } });
  });
});

describe('tenants and users', () => {
  it('finds a tenant, and a look at it is on the tenant’s record', async () => {
    const page = parse(StaffTenantPageSchema, await support.get('/api/staff/tenants').query({ q: 'console' }));
    expect(page.items.map((x) => x.legal_name)).toEqual(['Staff Console Buyers (Pty) Ltd']);
    const tn = parse(StaffTenantSchema, await support.get(`/api/staff/tenants/${buyer.tenantId}`));
    expect(tn.users).toEqual([expect.objectContaining({ email: 'owner@staff-console.example', role: 'owner', mfa_enrolled: true, disabled: false })]);
    const seen = await owner.query(`SELECT actor_type FROM audit_log WHERE tenant_id = $1 AND action = 'staff.support_view'`, [buyer.tenantId]);
    expect(seen.rows).toEqual([{ actor_type: 'tshepovet_staff' }]);
    // The buyer sees who looked, by name, in its own audit trail.
    const trail = await buyer.b.get('/api/audit');
    expect(JSON.stringify(trail.body)).toContain('TshepoVet support');
  });

  it('unlocks a user and verifies a tenant’s audit chain', async () => {
    await owner.query(`UPDATE tenant_users SET failed_logins = 5, locked_until = now() + interval '10 minutes' WHERE email = 'owner@staff-console.example'`);
    expect(parse(StaffTenantSchema, await support.get(`/api/staff/tenants/${buyer.tenantId}`)).users[0]!.locked_until).not.toBeNull();
    expect((await support.post(`/api/staff/users/${buyer.userId}/unlock`)).status).toBe(204);
    expect(parse(StaffTenantSchema, await support.get(`/api/staff/tenants/${buyer.tenantId}`)).users[0]!.locked_until).toBeNull();
    const v = await support.post(`/api/staff/tenants/${buyer.tenantId}/verify-chain`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ intact: true });
    expect(v.body.entries_checked).toBeGreaterThan(5);
  });

  it('suspends a tenant, which ends its sessions and keys at once, and reinstates it', async () => {
    expect((await admin.post(`/api/staff/tenants/${buyer.tenantId}/status`, { status: 'suspended' })).status).toBe(400);
    expect((await admin.post(`/api/staff/tenants/${buyer.tenantId}/status`, { status: 'suspended', reason: 'Card chargeback under investigation.' })).status).toBe(204);
    expect((await buyer.b.get('/api/suppliers')).status).toBe(401);
    expect((await admin.post(`/api/staff/tenants/${buyer.tenantId}/status`, { status: 'suspended', reason: 'again' })).body.code).toBe('no_change');
    expect((await admin.post(`/api/staff/tenants/${buyer.tenantId}/status`, { status: 'active', reason: 'Resolved with the bank.' })).status).toBe(204);
    const a = await owner.query(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'tenant.%' ORDER BY occurred_at`, [buyer.tenantId]);
    expect(a.rows.map((x) => x.action)).toEqual(['tenant.suspended', 'tenant.reinstated']);
  });
});

describe('requests, purges, bureaus and prices', () => {
  it('lists open data-subject requests with their clock', async () => {
    await owner.query(`INSERT INTO data_subject_requests (tenant_id, request_type, requester_display, due_at) VALUES ($1, 'access', 'A supplier', now() + interval '3 days')`, [buyer.tenantId]);
    const rows = parse(z.array(StaffRequestSchema), await support.get('/api/staff/requests'));
    expect(rows).toEqual([expect.objectContaining({ request_type: 'access', status: 'received', days_left: 3, tenant: 'Staff Console Buyers (Pty) Ltd' })]);
    expect((await admin.get('/api/staff/purge-runs')).status).toBe(200);
  });

  it('shows bureau health and turns a capability off and on', async () => {
    const p = parse(z.array(StaffProviderSchema), await admin.get('/api/staff/providers'));
    const mock = p.find((x) => x.code === 'mock');
    expect(mock?.capabilities.length).toBeGreaterThan(0);
    const cap = mock!.capabilities[0]!.capability;
    expect((await admin.patch(`/api/staff/providers/mock/${cap}`, { enabled: false })).status).toBe(204);
    expect((await owner.query(`SELECT enabled FROM provider_capabilities WHERE provider_code = 'mock' AND capability = $1`, [cap])).rows[0].enabled).toBe(false);
    expect((await admin.patch(`/api/staff/providers/mock/${cap}`, { enabled: true })).status).toBe(204);
    expect((await admin.patch('/api/staff/providers/nobody/company_registration', { enabled: true })).status).toBe(404);
  });

  it('sets a new price from a date, keeping the old one', async () => {
    const tomorrow = (await owner.query<{ d: string }>(`SELECT (current_date + 1)::text AS d`)).rows[0]!.d;
    const yesterday = (await owner.query<{ d: string }>(`SELECT (current_date - 1)::text AS d`)).rows[0]!.d;
    expect((await admin.post('/api/staff/prices', { sku: 'COMPANY_CHECK', unit_price_cents: 350, effective_from: yesterday })).body.code).toBe('past_date');
    expect((await admin.post('/api/staff/prices', { sku: 'NO_SUCH_SKU', unit_price_cents: 350, effective_from: tomorrow })).status).toBe(404);
    expect((await admin.post('/api/staff/prices', { sku: 'COMPANY_CHECK', unit_price_cents: 350, effective_from: tomorrow })).status).toBe(201);
    const prices = parse(z.array(PriceSchema), await admin.get('/api/staff/prices')).filter((x) => x.sku === 'COMPANY_CHECK');
    expect(prices.map((x) => [x.unit_price_cents, x.effective_to === null])).toEqual([
      [350, true],
      [300, false],
    ]);
    // Today's checks still cost today's price.
    const meta = await request(t.app).get('/api/meta');
    expect(meta.body.check_prices.company_cents).toBe(300);
  });
});

describe('the mail outbox', () => {
  it('lists sandbox mail, and reading a message is on the record', async () => {
    const page = parse(StaffMailPageSchema, await support.get('/api/staff/mail').query({ q: 'owner@staff-console' }));
    const verify = page.items.find((m) => m.template === 'verify_email');
    expect(verify).toBeTruthy();
    const m = parse(StaffMailSchema, await support.get(`/api/staff/mail/${verify!.id}`));
    expect(m.body_text).toContain('#token=');
    expect((await reviewer.get(`/api/staff/mail/${verify!.id}`)).status).toBe(403);
    // Outside the sandbox mail is delivered: its text (and any link in it) is never shown.
    const was = t.container.config.SANDBOX;
    (t.container.config as { SANDBOX: string }).SANDBOX = 'false';
    try {
      expect((await support.get(`/api/staff/mail/${verify!.id}`)).status).toBe(404);
    } finally {
      (t.container.config as { SANDBOX: string }).SANDBOX = was;
    }
    const a = await owner.query(`SELECT actor_type FROM audit_log WHERE action = 'staff.mail_viewed' AND entity_id = $1`, [verify!.id]);
    expect(a.rowCount).toBe(1);
  });
});

describe('the WhatsApp simulator', () => {
  it('starts a sandbox onboarding and sends the supplier’s messages onto the real stream', async () => {
    expect((await reviewer.post('/api/staff/whatsapp', { tenant_id: buyer.tenantId, number: '0821234567' })).status).toBe(400);
    const c = parse(WaConversationSchema, await reviewer.post('/api/staff/whatsapp', { tenant_id: buyer.tenantId, number: '27821234567' }), 201);
    expect(c).toMatchObject({ state: 'INVITED', number: '27821234567', tenant: 'Staff Console Buyers (Pty) Ltd' });
    expect((await reviewer.post('/api/staff/whatsapp', { tenant_id: buyer.tenantId, number: '27821234567' })).body.code).toBe('conversation_open');

    const before = await t.container.redis.xlen(WA_STREAM);
    expect((await reviewer.post(`/api/staff/whatsapp/${c.id}/messages`, { text: 'Hi', sample: 'id_director' })).status).toBe(400);
    expect((await reviewer.post(`/api/staff/whatsapp/${c.id}/messages`, { sample: 'not_a_sample' })).status).toBe(422);
    expect((await reviewer.post(`/api/staff/whatsapp/${c.id}/messages`, { text: 'Hi' })).status).toBe(202);
    expect(await t.container.redis.xlen(WA_STREAM)).toBe(before + 1);
    const last = (await t.container.redis.xrevrange(WA_STREAM, '+', '-', 'COUNT', 1))[0]![1];
    const payload = JSON.parse(last[last.indexOf('payload') + 1]!);
    expect(payload).toMatchObject({ from: '27821234567', type: 'text', text: { body: 'Hi' } });

    const msgs = parse(z.array(WaMessageSchema), await reviewer.get(`/api/staff/whatsapp/${c.id}/messages`));
    expect(msgs.map((m) => [m.direction, m.kind])).toEqual([
      ['out', 'template'],
      ['in', 'text'],
    ]);
    expect(msgs[0]!.body.text).toContain('Staff Console Buyers (Pty) Ltd');
    expect((await reviewer.get('/api/staff/whatsapp/tenants')).body).toEqual([{ id: buyer.tenantId, legal_name: 'Staff Console Buyers (Pty) Ltd' }]);
    const list = parse(z.array(WaConversationSchema), await support.get('/api/staff/whatsapp'));
    expect(list.map((x) => x.id)).toContain(c.id);
  });
});
