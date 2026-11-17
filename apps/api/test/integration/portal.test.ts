import Redis from 'ioredis';
import { RequestMethod } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Crypto, LocalKeyProvider, logger, verifyWebhook, WebhookDispatcher } from '@tshepovet/core';
import {
  API_ROUTES,
  ApiKeySchema,
  AuditListSchema,
  ChainVerificationSchema,
  CheckPageSchema,
  CheckPricesSchema,
  ConsentPageSchema,
  ConsentSchema,
  CreatedApiKeySchema,
  DeliveryPageSchema,
  DsrPageSchema,
  DsrSchema,
  LedgerPageSchema,
  MetaSchema,
  ModuleChangeSchema,
  ModuleSchema,
  MonitoringOverviewSchema,
  NoticeSchema,
  OverviewSchema,
  PortalVerificationSchema,
  ProcessingActivitySchema,
  SavedViewSchema,
  ScheduleItemSchema,
  AlertSchema,
  ScorecardSchema,
  SettingsSchema,
  SpendLineSchema,
  SupplierDetailSchema,
  SupplierListItemSchema,
  SupplierPageSchema,
  TopupPageSchema,
  TopupResultSchema,
  WalletSchema,
  WebhookEndpointSchema,
  WebhookWithSecretSchema,
} from '@tshepovet/contracts';
import { z } from 'zod';
import { AppModule } from '../../src/app.module';
import { buildTestApp, KEYS, ownerPool, resetDatabase } from './harness';
import { Browser, member, ownerWithMfa } from './portal-helpers';

/**
 * The portal API end to end (docs/PLAN.md M3). Every response is parsed with its contract's
 * strict schema, so a field nobody declared fails the test. Covers each module, the role
 * permissions, tenant isolation (another organisation's ids answer 404), consent, the money
 * paths and the webhook address guard.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
let A: Awaited<ReturnType<typeof ownerWithMfa>>; // the main organisation's owner
let B: Awaited<ReturnType<typeof ownerWithMfa>>; // another organisation
let viewer: Browser;
let clerk: Browser;

const parse = <T extends z.ZodType>(schema: T, res: request.Response, status = 200): z.infer<T> => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const r = schema.safeParse(res.body);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 1)).toBe(true);
  return r.data as z.infer<T>;
};
const consent = { confirmed: true, evidence_reference: 'Signed onboarding form SOF-2026-001' };

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  t = await buildTestApp();
  A = await ownerWithMfa(t.app, owner, 'owner@portal-a.example', 'Portal A (Pty) Ltd');
  B = await ownerWithMfa(t.app, owner, 'owner@portal-b.example', 'Portal B (Pty) Ltd', 'Lerato Nkosi');
  viewer = await member(t.app, owner, A.b, 'viewer@portal-a.example', 'viewer', 'Vusi Viewer');
  clerk = await member(t.app, owner, A.b, 'clerk@portal-a.example', 'ap_clerk', 'Carol Clerk');
}, 120_000);

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('the route table', () => {
  it('matches the routes the controllers register, with the same permissions, both ways', () => {
    const controllers = AppModule.register({} as never).controllers!;
    const actual: Array<{ key: string; permission?: string; mfa: boolean; staffRoles?: string[] }> = [];
    for (const C of controllers) {
      const base = Reflect.getMetadata('path', C) as string;
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        // Read the descriptor, never the property: a getter would run against the prototype.
        const fn = Object.getOwnPropertyDescriptor(C.prototype, name)?.value as unknown;
        if (name === 'constructor' || typeof fn !== 'function') continue;
        const p = Reflect.getMetadata('path', fn) as string | string[] | undefined;
        const m = Reflect.getMetadata('method', fn) as RequestMethod | undefined;
        if (p === undefined || m === undefined) continue;
        for (const sub of Array.isArray(p) ? p : [p]) {
          const full = `/${[base, sub].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/');
          if (!full.startsWith('/api')) continue;
          actual.push({
            key: `${RequestMethod[m]} ${full.replace(/:(\w+)/g, '{$1}')}`,
            permission: Reflect.getMetadata('tv:permission', fn),
            mfa: Boolean(Reflect.getMetadata('tv:allow-mfa-setup', fn)),
            staffRoles: Reflect.getMetadata('tv:staff-roles', fn),
          });
        }
      }
    }
    const declared = API_ROUTES.map((r) => ({ key: `${r.method} ${r.path}`, permission: r.permission, mfa: Boolean(r.mfaSetupAllowed), staffRoles: r.staffRoles }));
    expect(actual.map((a) => a.key).sort()).toEqual(declared.map((d) => d.key).sort());
    for (const d of declared) {
      const a = actual.find((x) => x.key === d.key)!;
      expect({ key: d.key, permission: a.permission, mfa: a.mfa, staffRoles: a.staffRoles }).toEqual({ key: d.key, permission: d.permission, mfa: d.mfa, staffRoles: d.staffRoles });
    }
  });

  it('serves an OpenAPI 3.1 document of every route', async () => {
    const res = await request(t.app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const ops = Object.values(res.body.paths as Record<string, Record<string, { operationId: string }>>).flatMap((p) => Object.values(p));
    expect(ops.length).toBe(API_ROUTES.length);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    expect(res.body.paths['/api/suppliers'].get['x-permission']).toBe('suppliers:read');
  });

  it('publishes the sandbox flag, prices and modules without a session', async () => {
    const m = parse(MetaSchema, await request(t.app).get('/api/meta'));
    expect(m.sandbox).toBe(true);
    expect(m.check_prices.company_cents).toBe(300);
    expect(m.modules.find((x) => x.sku === 'MOD_COI_RADAR')?.available).toBe(false);
  });
});

describe('sessions, roles and CSRF on the portal API', () => {
  it('asks for a session, then for the permission, then for CSRF proof', async () => {
    expect((await request(t.app).get('/api/suppliers')).status).toBe(401);
    const anon = await new Browser(t.app).init();
    expect((await anon.get('/api/wallet')).status).toBe(401);
    expect((await viewer.get('/api/suppliers')).status).toBe(200);
    for (const [method, path] of [
      ['post', '/api/suppliers'],
      ['post', '/api/checks/company'],
      ['post', '/api/wallet/topups'],
      ['get', '/api/developers/keys'],
      ['get', '/api/compliance/consents'],
      ['get', '/api/audit'],
      ['patch', '/api/settings'],
    ] as const) {
      const res = method === 'get' ? await viewer.get(path) : method === 'post' ? await viewer.post(path, {}) : await viewer.patch(path, {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
    expect((await clerk.post('/api/checks/company', { registration_number: '2019/123456/07' })).status).toBe(403);
    const noCsrf = await A.b.agent.post('/api/suppliers').send({ registration_number: '2019/123456/07' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('csrf_failed');
  });
});

let supplierId = '';
let checkId = '';

describe('wallet and checks', () => {
  it('refuses a priced check on an empty wallet, then tops up in the sandbox with a tax invoice', async () => {
    const w = parse(WalletSchema, await A.b.get('/api/wallet'));
    expect(w).toMatchObject({ balance_cents: 0, available_cents: 0, sandbox: true, low_balance: true });
    const poor = await A.b.post('/api/checks/company', { registration_number: '2019/123456/07' });
    expect(poor.status).toBe(402);
    expect(poor.body.code).toBe('insufficient_funds');

    expect((await A.b.post('/api/wallet/topups', { credit_cents: 500 })).status).toBe(400); // below R100
    const top = parse(TopupResultSchema, await clerk.post('/api/wallet/topups', { credit_cents: 100_000 }), 201); // the AP clerk may top up
    expect(top.topup).toMatchObject({ credit_cents: 100_000, vat_cents: 15_000, gross_cents: 115_000, status: 'succeeded', payment_provider: 'sandbox' });
    expect(top.topup.tax_invoice_number).toMatch(/^TV-\d{6}$/);
    expect(top.balance_cents).toBe(100_000);
    const list = parse(TopupPageSchema, await viewer.get('/api/wallet/topups'));
    expect(list.total).toBe(1);
  });

  it('prices checks up front and runs a company check that lands on the supplier list', async () => {
    const p = parse(CheckPricesSchema, await A.b.get('/api/checks/prices'));
    expect(p).toMatchObject({ company: { price_cents: 300 }, company_live: { price_cents: 600 }, available_cents: 100_000, sandbox: true });

    const v = parse(PortalVerificationSchema, await A.b.post('/api/checks/company', { registration_number: '2019/123456/07', external_ref: 'SUP-001' }));
    expect(v).toMatchObject({ status: 'completed', outcome: 'verified', billing: { price_cents: 300, charged: true, wallet_balance_cents: 99_700 } });
    expect(v.requested_by).toEqual({ type: 'user', name: 'Thandi Mokoena' });
    expect(v.supplier_name).toBe('ACME TRADING (PTY) LTD');
    supplierId = v.supplier_id!;
    checkId = v.id;

    const page = parse(SupplierPageSchema, await viewer.get('/api/suppliers?q=acme'));
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: supplierId, status: 'onboarding', last_outcome: 'verified', external_ref: 'SUP-001', monitored: false });

    const d = parse(SupplierDetailSchema, await viewer.get(`/api/suppliers/${supplierId}`));
    expect(d.vendor.legal_name).toBe('ACME TRADING (PTY) LTD');
    expect(d.directors.map((x) => x.status)).toEqual(['active', 'resigned']);
    expect(d.checks).toHaveLength(1);
    expect(d.permissions.can_view_special_pi).toBe(false);

    const one = parse(PortalVerificationSchema, await viewer.get(`/api/checks/${checkId}`));
    expect(one.checks).toHaveProperty('registration');
    const checks = parse(CheckPageSchema, await viewer.get('/api/checks?outcome=verified'));
    expect(checks.items.map((c) => c.id)).toContain(checkId);

    const ledger = parse(LedgerPageSchema, await viewer.get('/api/wallet/ledger'));
    expect(ledger.items.map((l) => [l.kind, l.amount_cents])).toEqual([
      ['usage_capture', -300],
      ['topup', 100_000],
    ]);
  });

  it('needs consent for a tax compliance check, and records it as a web checkbox by the user', async () => {
    const body = { registration_number: '2019/123456/07', tax_reference_number: '9123456789', tcs_pin: 'AB12CD34EF', checks: ['registration', 'tcs'] };
    const no = await A.b.post('/api/checks/company', body);
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('consent_required');
    const v = parse(PortalVerificationSchema, await A.b.post('/api/checks/company', { ...body, consent }));
    expect(v.outcome).toBe('verified');
    const c = parse(ConsentPageSchema, await A.b.get('/api/compliance/consents?purpose=tax_compliance_verification'));
    expect(c.items[0]).toMatchObject({ capture_method: 'web_checkbox', notice: { code: 'company_verification', channel: 'web' }, captured_by: { type: 'user', name: 'Thandi Mokoena' } });
    expect(c.items[0]!.purposes.map((p) => p.purpose)).toEqual(['kyb_company_verification', 'tax_compliance_verification']);
  });

  it('runs a driver check with the driver’s consent', async () => {
    const res = await A.b.post('/api/checks/driver', {
      id_number: '8001015009087',
      licence_number: '400100001234',
      surname: 'Mokoena',
      required_codes: ['EC1'],
      supplier_id: supplierId,
      consent,
    });
    const v = parse(PortalVerificationSchema, res);
    expect(v.type).toBe('driver_licence');
    expect(v.subject).not.toContain('8001015009087');
    expect((await A.b.post('/api/checks/driver', { id_number: '8001015009087' })).status).toBe(400); // consent is required by the schema
  });
});

describe('suppliers', () => {
  it('adds a supplier by registration number once', async () => {
    const s = parse(SupplierListItemSchema, await A.b.post('/api/suppliers', { registration_number: '2020/654321/07', industry_profile: 'construction' }), 201);
    expect(s).toMatchObject({ status: 'onboarding', registration_number: '2020/654321/07' });
    const again = await A.b.post('/api/suppliers', { registration_number: '2020/654321/07' });
    expect(again.status).toBe(409);
    expect(again.body.details.supplier_id).toBe(s.id);
    expect((await A.b.post('/api/suppliers', { registration_number: '2020/654321/0X' })).body.code).toBe('invalid_registration_number');
  });

  it('changes risk and status with reasons in the audit trail', async () => {
    parse(SupplierListItemSchema, await A.b.patch(`/api/suppliers/${supplierId}`, { risk_rating: 'high' }));
    const noReason = await A.b.post(`/api/suppliers/${supplierId}/status`, { status: 'suspended' });
    expect(noReason.status).toBe(400);
    const ok = parse(SupplierListItemSchema, await A.b.post(`/api/suppliers/${supplierId}/status`, { status: 'approved' }));
    expect(ok.status).toBe('approved');
    expect((await A.b.post(`/api/suppliers/${supplierId}/status`, { status: 'approved' })).status).toBe(409);
    const d = parse(SupplierDetailSchema, await A.b.get(`/api/suppliers/${supplierId}`));
    expect(d.relationship.approved_by).toBe('Thandi Mokoena');

    const trail = parse(AuditListSchema, await A.b.get(`/api/suppliers/${supplierId}/audit`));
    const actions = trail.items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['supplier.approved', 'supplier.updated', 'verification.created']));
    expect((await viewer.get(`/api/suppliers/${supplierId}/audit`)).status).toBe(403);
  });

  it('exports CSV with spreadsheet formulas neutralised', async () => {
    await A.b.patch(`/api/suppliers/${supplierId}`, { external_ref: '=HYPERLINK("http://evil.example","x")' });
    const res = await A.b.get('/api/suppliers/export.csv?q=acme');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    await A.b.patch(`/api/suppliers/${supplierId}`, { external_ref: 'SUP-001' });
  });

  it('keeps saved views private to the person who saved them', async () => {
    const v = parse(SavedViewSchema, await viewer.post('/api/saved-views', { scope: 'suppliers', name: 'High risk', query: { risk: 'high' } }), 201);
    expect((await viewer.post('/api/saved-views', { scope: 'suppliers', name: 'High risk', query: {} })).status).toBe(409);
    expect((await A.b.get('/api/saved-views?scope=suppliers')).body).toEqual([]);
    expect((await A.b.del(`/api/saved-views/${v.id}`)).status).toBe(404);
    expect((await viewer.del(`/api/saved-views/${v.id}`)).status).toBe(204);
  });
});

describe('monitoring', () => {
  it('needs consent to enrol, then tracks expiries, alerts and the payment lock', async () => {
    const no = await A.b.post(`/api/monitoring/${supplierId}`, {});
    expect(no.status).toBe(422);
    expect(no.body.details.missing_purposes).toEqual(['continuous_monitoring']);
    parse(MonitoringOverviewSchema.shape.enrolments.element, await A.b.post(`/api/monitoring/${supplierId}`, { erp_lock_enabled: true, consent }), 201);
    expect((await A.b.post(`/api/monitoring/${supplierId}`, { consent })).status).toBe(409);

    await owner.query(
      `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, state)
       VALUES ($1, $2, 'document', gen_random_uuid(), current_date + 5, 'scheduled')`,
      [A.tenantId, supplierId],
    );
    const o = parse(MonitoringOverviewSchema, await viewer.get('/api/monitoring'));
    expect(o.counts.enrolled).toBe(1);
    expect(o.counts.expiring_30d).toBeGreaterThanOrEqual(1);
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const cal = parse(z.array(ScheduleItemSchema), await viewer.get(`/api/monitoring/calendar?from=${today}&to=${later}`));
    expect(cal.some((x) => x.subject_type === 'document')).toBe(true);

    const locked = parse(SupplierListItemSchema, await A.b.post(`/api/monitoring/${supplierId}/payment-lock`, { status: 'locked', reason: 'COIDA letter lapsed' }));
    expect(locked.payment_lock_status).toBe('locked');
    const ev = await owner.query(`SELECT 1 FROM webhook_events WHERE tenant_id = $1 AND event_type = 'vendor.payment_locked'`, [A.tenantId]);
    expect(ev.rowCount).toBe(1);
    const alerts = parse(z.array(AlertSchema), await viewer.get('/api/monitoring/alerts'));
    expect(alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['locked', 'expiring']));
    await A.b.post(`/api/monitoring/${supplierId}/payment-lock`, { status: 'unlocked', reason: 'Letter renewed' });

    expect((await A.b.del(`/api/monitoring/${supplierId}`)).status).toBe(204);
    expect(parse(MonitoringOverviewSchema, await viewer.get('/api/monitoring')).counts.enrolled).toBe(0);
  });
});

describe('modules and the B-BBEE scorecard', () => {
  it('charges the first month from the wallet, and cancels to the period end', async () => {
    const list = parse(z.array(ModuleSchema), await viewer.get('/api/modules'));
    expect(list.map((m) => m.state)).toEqual(['off', 'off', 'off', 'off']);
    expect((await A.b.post('/api/modules/MOD_BBBEE')).body.code).toBe('insufficient_funds');
    expect((await A.b.post('/api/modules/MOD_COI_RADAR')).body.code).toBe('module_unavailable');
    expect((await A.b.post('/api/modules/NOT_A_MODULE')).status).toBe(404);
    await A.b.post('/api/wallet/topups', { credit_cents: 1_000_000 });

    const on = parse(ModuleChangeSchema, await A.b.post('/api/modules/MOD_BBBEE'));
    expect(on).toMatchObject({ charged_cents: 500_000, module: { state: 'on' } });
    expect((await A.b.post('/api/modules/MOD_BBBEE')).body.code).toBe('already_active');
    const ending = parse(ModuleChangeSchema, await A.b.del('/api/modules/MOD_BBBEE'));
    expect(ending.module.state).toBe('ending');
    const resumed = parse(ModuleChangeSchema, await A.b.post('/api/modules/MOD_BBBEE'));
    expect(resumed).toMatchObject({ charged_cents: 0, module: { state: 'on' } });
    const ledger = parse(LedgerPageSchema, await A.b.get('/api/wallet/ledger?kind=subscription_charge'));
    expect(ledger.items.map((l) => l.amount_cents)).toEqual([-500_000]);
  });

  it('records spend and recognises it at the supplier’s verified level', async () => {
    const vendor = await owner.query<{ vendor_id: string }>(`SELECT vendor_id FROM tenant_vendors WHERE id = $1`, [supplierId]);
    await owner.query(
      `INSERT INTO vendor_bbbee_profiles (vendor_id, evidence_type, bbbee_level, procurement_recognition_pct, black_ownership_pct, black_female_ownership_pct,
                                          issued_on, valid_until, status)
       VALUES ($1, 'eme_affidavit', 2, 125, 60, 35, current_date - 30, current_date + 300, 'accepted')`,
      [vendor.rows[0]!.vendor_id],
    );
    const other = (await A.b.get('/api/suppliers?q=654321')).body.items[0].id as string;
    const lines = [
      { supplier_id: supplierId, period_start: '2026-03-01', period_end: '2026-03-31', amount_cents: 1_000_000 },
      { supplier_id: other, period_start: '2026-04-01', period_end: '2026-04-30', amount_cents: 400_000 },
    ];
    expect((await A.b.post('/api/modules/bbbee/spend', { lines: [{ ...lines[0], supplier_id: B.tenantId }] })).body.code).toBe('unknown_supplier');
    parse(z.array(SpendLineSchema), await A.b.post('/api/modules/bbbee/spend', { lines }), 201);
    const s = parse(ScorecardSchema, await A.b.get('/api/modules/bbbee/scorecard?from=2026-03-01&to=2027-02-28'));
    expect(s).toMatchObject({
      total_measured_spend_cents: 1_400_000,
      recognised_spend_cents: 1_250_000,
      unverified_spend_cents: 400_000,
      eme_spend_cents: 1_000_000,
      black_owned_51_spend_cents: 1_000_000,
      black_women_owned_30_spend_cents: 1_000_000,
    });
    expect(s.suppliers.find((x) => x.supplier_id === other)?.flags).toEqual(['no_evidence']);
    expect((await viewer.get('/api/modules/bbbee/scorecard?from=2026-03-01&to=2027-02-28')).status).toBe(403);
    expect((await B.b.get('/api/modules/bbbee/scorecard?from=2026-03-01&to=2027-02-28')).body.code).toBe('module_off');

    // Ownership percentages are special personal information: only for permitted users.
    expect(parse(SupplierDetailSchema, await A.b.get(`/api/suppliers/${supplierId}`)).bbbee?.ownership).toBeNull();
    await owner.query(`UPDATE tenant_users SET can_view_special_pi = true WHERE id = $1`, [A.userId]);
    expect(parse(SupplierDetailSchema, await A.b.get(`/api/suppliers/${supplierId}`)).bbbee?.ownership?.black_ownership_pct).toBe(60);
  });
});

describe('developers', () => {
  it('shows a key once, records its use, refuses live keys in the sandbox, and revokes', async () => {
    const created = parse(CreatedApiKeySchema, await A.b.post('/api/developers/keys', { name: 'ERP sandbox', environment: 'test' }), 201);
    expect(created.secret.startsWith(`${created.api_key.prefix}.`)).toBe(true);
    expect((await A.b.post('/api/developers/keys', { name: 'Live', environment: 'live' })).body.code).toBe('live_keys_unavailable');

    const use = await request(t.app).post('/v1/verify/company').set('authorization', `Bearer ${created.secret}`).send({ registration_number: '2019/123456/07' });
    expect(use.status).toBe(200);
    const keys = parse(z.array(ApiKeySchema), await A.b.get('/api/developers/keys'));
    const k = keys.find((x) => x.id === created.api_key.id)!;
    expect(k.last_used_at).not.toBeNull();
    expect(JSON.stringify(keys)).not.toContain(created.secret.split('.')[1]);

    expect((await A.b.del(`/api/developers/keys/${k.id}`)).status).toBe(204);
    expect((await request(t.app).post('/v1/verify/company').set('authorization', `Bearer ${created.secret}`).send({ registration_number: '2019/123456/07' })).status).toBe(401);
  });

  it('refuses webhook URLs that are not https on the public internet', async () => {
    for (const url of ['http://1.1.1.1/hook', 'https://127.0.0.1/hook', 'https://localhost:9131/x', 'https://10.0.0.5/hook', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://user:pw@1.1.1.1/', 'https://intranet/hook', 'https://box.internal/hook']) {
      const res = await A.b.post('/api/developers/webhooks', { url, events: ['verification.completed'] });
      expect(res.status, url).toBe(400);
      expect(res.body.code, url).toBe('invalid_webhook_url');
    }
  });

  it('signs with both secrets during a rotation, logs deliveries and replays them', async () => {
    const made = parse(WebhookWithSecretSchema, await A.b.post('/api/developers/webhooks', { url: 'https://1.1.1.1/tshepovet', events: ['verification.completed'] }), 201);
    expect(made.secret).toMatch(/^whsec_/);
    const rotated = parse(WebhookWithSecretSchema, await A.b.post(`/api/developers/webhooks/${made.endpoint.id}/rotate-secret`));
    expect(rotated.secret).not.toBe(made.secret);
    expect(rotated.endpoint.previous_secret_valid_until).not.toBeNull();

    await A.b.post('/api/checks/company', { registration_number: '2019/123456/07' }); // enqueues verification.completed
    const sent: Array<{ headers: Record<string, string>; body: string }> = [];
    const c = new Crypto(new LocalKeyProvider(KEYS.KEK_KEYS), Buffer.from(KEYS.BLIND_INDEX_ROOT_KEY, 'base64'));
    const dispatcher = new WebhookDispatcher(owner, c, logger, async (_url, init) => {
      sent.push({ headers: init.headers, body: init.body });
      return { status: 500 };
    });
    await dispatcher.runOnce(100);
    const mine = sent.find((s) => JSON.parse(s.body).type === 'verification.completed')!;
    const sig = mine.headers['tshepovet-signature']!;
    expect(sig.match(/v1=/g)).toHaveLength(2);
    expect(verifyWebhook(sig, mine.body, rotated.secret)).toBe(true);
    expect(verifyWebhook(sig, mine.body, made.secret)).toBe(true);

    const log = parse(DeliveryPageSchema, await A.b.get(`/api/developers/webhooks/${made.endpoint.id}/deliveries`));
    expect(log.items[0]).toMatchObject({ status: 'failed', attempts: 1, last_http_status: 500 });
    const d = log.items[0]!.id;
    expect((await A.b.post(`/api/developers/webhooks/${made.endpoint.id}/deliveries/${d}/replay`)).status).toBe(202);
    expect((await A.b.post(`/api/developers/webhooks/${made.endpoint.id}/deliveries/${d}/replay`)).body.code).toBe('delivery_in_progress');

    const paused = parse(WebhookEndpointSchema, await A.b.patch(`/api/developers/webhooks/${made.endpoint.id}`, { status: 'disabled' }));
    expect(paused.status).toBe('disabled');
  });
});

describe('compliance', () => {
  it('withdraws consent and stops monitoring that rested on it', async () => {
    parse(MonitoringOverviewSchema.shape.enrolments.element, await A.b.post(`/api/monitoring/${supplierId}`, {}), 201); // consent on file now
    const c = parse(ConsentPageSchema, await A.b.get('/api/compliance/consents?purpose=continuous_monitoring'));
    const w = parse(ConsentSchema, await A.b.post(`/api/compliance/consents/${c.items[0]!.id}/withdraw`, { purposes: ['continuous_monitoring'], channel: 'email' }));
    expect(w.purposes.find((p) => p.purpose === 'continuous_monitoring')?.withdrawn_at).not.toBeNull();
    expect((await A.b.post(`/api/compliance/consents/${c.items[0]!.id}/withdraw`, { purposes: ['continuous_monitoring'] })).body.code).toBe('already_withdrawn');
    expect(parse(MonitoringOverviewSchema, await A.b.get('/api/monitoring')).counts.enrolled).toBe(0);
  });

  it('lists notices and the processing record', async () => {
    const n = parse(z.array(NoticeSchema), await A.b.get('/api/compliance/notices'));
    expect(n.some((x) => x.code === 'company_verification' && x.channel === 'web')).toBe(true);
    parse(z.array(ProcessingActivitySchema), await A.b.get('/api/compliance/processing'));
  });

  it('runs data-subject requests on the 30-day clock', async () => {
    const d = parse(DsrSchema, await A.b.post('/api/compliance/requests', { request_type: 'access', requester_display: 'ACME director', supplier_id: supplierId }), 201);
    expect(d).toMatchObject({ status: 'received', days_left: 30, supplier_name: 'ACME TRADING (PTY) LTD' });
    expect((await A.b.patch(`/api/compliance/requests/${d.id}`, { status: 'completed' })).status).toBe(400);
    const done = parse(DsrSchema, await A.b.patch(`/api/compliance/requests/${d.id}`, { status: 'completed', identity_verified: true, outcome_notes: 'Record sent by email.' }));
    expect(done.completed_at).not.toBeNull();
    expect(done.days_left).toBeNull();
    expect(parse(DsrPageSchema, await A.b.get('/api/compliance/requests?open=false')).total).toBe(1);
  });

  it('pages through the audit log and verifies the hash chain', async () => {
    const first = parse(AuditListSchema, await A.b.get('/api/audit?limit=5'));
    expect(first.items).toHaveLength(5);
    const next = parse(AuditListSchema, await A.b.get(`/api/audit?limit=5&before_id=${first.next_before_id}`));
    expect(next.items[0]!.id).toBeLessThan(first.items[4]!.id);
    const sup = parse(AuditListSchema, await A.b.get('/api/audit?action=supplier.'));
    expect(sup.items.every((i) => i.action.startsWith('supplier.'))).toBe(true);
    const v = parse(ChainVerificationSchema, await A.b.post('/api/audit/verify'));
    expect(v.intact).toBe(true);
    expect(v.entries_checked).toBeGreaterThan(20);
  });
});

describe('settings and the overview', () => {
  it('changes preferences that the check flow then honours', async () => {
    const s = parse(SettingsSchema, await A.b.get('/api/settings'));
    expect(s.preferences.require_consent_for_all_checks).toBe(false);
    expect((await A.b.patch('/api/settings', { organisation: { vat_number: '123' } })).status).toBe(400);
    expect((await A.b.patch('/api/settings', { organisation: { status: 'closed' } })).status).toBe(400);
    parse(SettingsSchema, await A.b.patch('/api/settings', { preferences: { require_consent_for_all_checks: true }, organisation: { information_officer_email: 'io@portal-a.example' } }));
    const no = await A.b.post('/api/checks/company', { registration_number: '2019/123456/07' });
    expect(no.body.code).toBe('consent_required');
    expect(no.body.details.missing_purposes).toEqual(['kyb_company_verification']);
    await A.b.patch('/api/settings', { preferences: { require_consent_for_all_checks: false } });
  });

  it('summarises the month, and shows activity only to roles with the audit log', async () => {
    const o = parse(OverviewSchema, await A.b.get('/api/overview'));
    expect(o.checks_this_month.total).toBeGreaterThanOrEqual(4);
    expect(o.verified_rate).toBeGreaterThan(0);
    expect(o.recent_activity.length).toBeGreaterThan(0);
    expect(parse(OverviewSchema, await viewer.get('/api/overview')).recent_activity).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('answers 404 for every id that belongs to another organisation', async () => {
    const endpoint = (await A.b.get('/api/developers/webhooks')).body[0].id as string;
    const consentId = (await A.b.get('/api/compliance/consents')).body.items[0].id as string;
    const dsr = (await A.b.get('/api/compliance/requests')).body.items[0].id as string;
    const view = (await A.b.post('/api/saved-views', { scope: 'checks', name: 'Mine', query: {} })).body.id as string;
    const probes: Array<[string, () => Promise<request.Response>]> = [
      ['supplier', () => B.b.get(`/api/suppliers/${supplierId}`)],
      ['supplier patch', () => B.b.patch(`/api/suppliers/${supplierId}`, { risk_rating: 'low' })],
      ['supplier status', () => B.b.post(`/api/suppliers/${supplierId}/status`, { status: 'approved' })],
      ['check', () => B.b.get(`/api/checks/${checkId}`)],
      ['monitoring', () => B.b.post(`/api/monitoring/${supplierId}`, { consent })],
      ['payment lock', () => B.b.post(`/api/monitoring/${supplierId}/payment-lock`, { status: 'locked', reason: 'x' })],
      ['webhook', () => B.b.patch(`/api/developers/webhooks/${endpoint}`, { status: 'active' })],
      ['webhook log', () => B.b.get(`/api/developers/webhooks/${endpoint}/deliveries`)],
      ['consent', () => B.b.post(`/api/compliance/consents/${consentId}/withdraw`, {})],
      ['dsr', () => B.b.patch(`/api/compliance/requests/${dsr}`, { identity_verified: true })],
      ['saved view', () => B.b.del(`/api/saved-views/${view}`)],
      ['driver supplier', () => B.b.post('/api/checks/driver', { id_number: '8001015009087', supplier_id: supplierId, consent })],
    ];
    for (const [name, probe] of probes) expect((await probe()).status, name).toBe(404);
    expect(parse(SupplierPageSchema, await B.b.get('/api/suppliers')).total).toBe(0);
    expect(parse(CheckPageSchema, await B.b.get('/api/checks')).total).toBe(0);
  });

  it('detects a tampered audit entry', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_immutable');
      await c.query(`UPDATE audit_log SET details = '{"tampered":true}' WHERE tenant_id = $1 AND chain_seq = 3`, [B.tenantId]);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_immutable');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const v = parse(ChainVerificationSchema, await B.b.post('/api/audit/verify'));
    expect(v).toMatchObject({ intact: false, broken_at_sequence: 3 });
  });
});
