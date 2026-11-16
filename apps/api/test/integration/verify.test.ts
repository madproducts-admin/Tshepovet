import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Crypto, LocalKeyProvider, logger, MockProvider, ProviderAdapter, ProviderError, purgeOnce, StaticCapabilityConfig, verifyWebhook, WebhookDispatcher } from '@tshepovet/core';
import { buildTestApp, createTenant, KEYS, ownerPool, resetDatabase } from './harness';

let owner: Pool;
let t: Awaited<ReturnType<typeof buildTestApp>>;
let tenantA: Awaited<ReturnType<typeof createTenant>>;
let tenantB: Awaited<ReturnType<typeof createTenant>>;
let webhookSecret: string;

const consent = {
  notice_code: 'company_verification',
  subject_display: 'ACME TRADING (PTY) LTD',
  subject_role: 'authorised_representative',
  purposes: ['tax_compliance_verification', 'continuous_monitoring'],
  captured_at: '2026-11-14T08:00:00+02:00',
  evidence_reference: 'onboarding-form-8812',
  attested_by: 'procurement@buyer.example',
};

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  tenantA = await createTenant(owner, 'Buyer A (Pty) Ltd', 100_000);
  tenantB = await createTenant(owner, 'Buyer B (Pty) Ltd', 0);
  t = await buildTestApp();

  // Webhook endpoint for tenant A (secret encrypted exactly as the app would).
  webhookSecret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
  const c = new Crypto(new LocalKeyProvider(KEYS.KEK_KEYS), Buffer.from(KEYS.BLIND_INDEX_ROOT_KEY, 'base64'));
  await owner.query(`INSERT INTO webhook_endpoints (tenant_id, url, secret_enc) VALUES ($1, 'https://placeholder.invalid/hook', $2)`, [
    tenantA.tenantId,
    await c.encrypt(webhookSecret, `webhook_secret:${tenantA.tenantId}`),
  ]);
});

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('POST /v1/verify/company', () => {
  let firstId: string;

  it('verifies a company end-to-end and charges R3.00 from the wallet', async () => {
    const res = await request(t.app)
      .post('/v1/verify/company')
      .set(auth(tenantA.keys.live))
      .set('Idempotency-Key', 'idem-company-0001')
      .send({
        registration_number: '2019/123456/07',
        vat_number: '4123456789',
        tax_reference_number: '9123456789',
        tcs_pin: 'AB12CD34EF',
        checks: ['registration', 'directors', 'vat', 'tcs'],
        external_ref: 'SUP-0001',
        consent,
        monitor: true,
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'verification',
      type: 'company',
      status: 'completed',
      outcome: 'verified',
      external_ref: 'SUP-0001',
      billing: { sku: 'COMPANY_CHECK', price_cents: 300, charged: true, wallet_balance_cents: 99_700 },
    });
    expect(res.body.checks.registration.result.legal_name).toBe('ACME TRADING (PTY) LTD');
    expect(res.body.checks.registration.source).toBe('provider:mock');
    expect(res.body.checks.directors.result.active).toEqual([expect.objectContaining({ full_name: 'THANDI MOKOENA', id_number_last4: '9087' })]);
    expect(res.body.checks.vat.result.name_matches_cipc).toBe(true);
    expect(res.body.checks.tcs.result).toMatchObject({ tcs_status: 'compliant', pin_status: 'active' });
    expect(JSON.stringify(res.body)).not.toContain('AB12CD34EF');
    expect(JSON.stringify(res.body)).not.toContain('8001015009087');
    firstId = res.body.id;

    const ledger = await owner.query(`SELECT sum(amount_cents)::int AS s, count(*)::int AS n FROM ledger_entries WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(ledger.rows[0]).toEqual({ s: 0, n: 2 });
    const pin = await owner.query(`SELECT pin_enc IS NOT NULL AS stored, status FROM tax_compliance_pins WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(pin.rows[0]).toEqual({ stored: true, status: 'active' });
    const dirs = await owner.query(`SELECT id_number_enc IS NOT NULL AS enc, id_number_bidx IS NOT NULL AS bidx FROM vendor_directors`);
    expect(dirs.rows.every((d) => d.enc && d.bidx)).toBe(true);
    const sched = await owner.query(`SELECT subject_type FROM expiry_schedules WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(sched.rows.map((r) => r.subject_type)).toContain('tcs_pin');
    const mon = await owner.query(`SELECT count(*)::int AS n FROM monitoring_enrolments WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(mon.rows[0].n).toBe(1);
  });

  it('replays the stored response for the same Idempotency-Key (no double charge)', async () => {
    const res = await request(t.app)
      .post('/v1/verify/company')
      .set(auth(tenantA.keys.live))
      .set('Idempotency-Key', 'idem-company-0001')
      .send({
        registration_number: '2019/123456/07',
        vat_number: '4123456789',
        tax_reference_number: '9123456789',
        tcs_pin: 'AB12CD34EF',
        checks: ['registration', 'directors', 'vat', 'tcs'],
        external_ref: 'SUP-0001',
        consent,
        monitor: true,
      });
    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body.id).toBe(firstId);
    const w = await owner.query(`SELECT balance_cents::int AS b FROM wallets WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(w.rows[0].b).toBe(99_700);
  });

  it('rejects a reused Idempotency-Key with a different body', async () => {
    const res = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).set('Idempotency-Key', 'idem-company-0001').send({ registration_number: '2019/999999/07' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('idempotency_key_reused');
  });

  it('serves repeat lookups from cache at zero bureau cost (still R3.00 to the buyer)', async () => {
    const res = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2019/123456/07' });
    expect(res.status).toBe(200);
    expect(res.body.checks.registration.source).toBe('cache:redis');
    expect(res.body.billing.charged).toBe(true);
    const calls = await owner.query(`SELECT count(*)::int AS n FROM provider_calls WHERE verification_id = $1`, [res.body.id]);
    expect(calls.rows[0].n).toBe(0);
  });

  it('shares public-register cache across tenants but never tenant-scoped TCS results', async () => {
    await owner.query(`UPDATE wallets SET balance_cents = 1000 WHERE tenant_id = $1`, [tenantB.tenantId]);
    const res = await request(t.app)
      .post('/v1/verify/company')
      .set(auth(tenantB.keys.live))
      .send({
        registration_number: '2019/123456/07',
        tax_reference_number: '9123456789',
        tcs_pin: 'AB12CD34EF',
        checks: ['registration', 'tcs'],
        consent: { ...consent, purposes: ['tax_compliance_verification'] },
      });
    expect(res.status).toBe(200);
    expect(res.body.checks.registration.source).toMatch(/^cache:/);
    expect(res.body.checks.tcs.source).toBe('provider:mock');
    await owner.query(`UPDATE wallets SET balance_cents = 0 WHERE tenant_id = $1`, [tenantB.tenantId]);
  });

  it('requires consent for TCS checks', async () => {
    const res = await request(t.app)
      .post('/v1/verify/company')
      .set(auth(tenantA.keys.live))
      .send({ registration_number: '2019/123456/07', tax_reference_number: '9123456789', tcs_pin: 'AB12CD34EF', checks: ['tcs'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('consent_required');
  });

  it('returns 402 when the wallet cannot cover the check, and creates nothing', async () => {
    const before = await owner.query(`SELECT count(*)::int AS n FROM verifications`);
    const res = await request(t.app).post('/v1/verify/company').set(auth(tenantB.keys.live)).send({ registration_number: '2020/555555/07' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'insufficient_funds', details: { required_cents: 300, available_cents: 0 } });
    const after = await owner.query(`SELECT count(*)::int AS n FROM verifications`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('bills a definitive "not found" and flags deregistration risk', async () => {
    const nf = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2020/000404/07' });
    expect(nf.body).toMatchObject({ outcome: 'not_found', billing: { charged: true } });
    const dereg = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2018/000777/07' });
    expect(dereg.body.outcome).toBe('verified_with_warnings');
    expect(dereg.body.risk_flags).toContain('cipc_status_deregistration_process');
    const newDir = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2018/000888/07' });
    expect(newDir.body.risk_flags).toContain('director_appointed_within_30_days');
  });

  it('validates input with SA-specific messages', async () => {
    const bad = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: 'ABCDEFGHIJ' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_registration_number');
    const vat = await request(t.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2019/123456/07', vat_number: '1234567890', checks: ['vat'] });
    expect(vat.body.code).toBe('validation_error');
    const unauth = await request(t.app).post('/v1/verify/company').send({ registration_number: '2019/123456/07' });
    expect(unauth.status).toBe(401);
  });

  it('isolates tenants: B cannot read A\'s verification', async () => {
    const res = await request(t.app).get(`/v1/verifications/${firstId}`).set(auth(tenantB.keys.live));
    expect(res.status).toBe(404);
    const own = await request(t.app).get(`/v1/verifications/${firstId}`).set(auth(tenantA.keys.live));
    expect(own.status).toBe(200);
    expect(own.body.outcome).toBe('verified');
  });
});

describe('waterfall failover through the API', () => {
  class DownProvider implements ProviderAdapter {
    readonly code = 'down';
    supports() {
      return true;
    }
    async call(): Promise<never> {
      throw new ProviderError('error_5xx', 'bureau down', 503);
    }
  }
  const caps = (codes: Array<[string, number]>) =>
    new StaticCapabilityConfig(
      codes.flatMap(([providerCode, unitCostCents]) =>
        (['company_registration', 'vat_status'] as const).map((capability) => ({ providerCode, capability, unitCostCents, volumeTiers: [], prepaidRemaining: null, isLiveSource: true, timeoutMs: 1000, enabled: true })),
      ),
    );

  beforeAll(async () => {
    // provider_calls.provider_code is a FK: every bureau must be registered (and have a POPIA s21 operator agreement).
    await owner.query(`INSERT INTO providers (code, name) VALUES ('down', 'Always-down test bureau') ON CONFLICT DO NOTHING`);
  });

  it('fails over from a down bureau and records both attempts', async () => {
    const alt = await buildTestApp({ liveAdapters: [new DownProvider(), new MockProvider('mock')], liveCapabilityConfig: caps([['down', 10], ['mock', 150]]) });
    try {
      const res = await request(alt.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2021/314159/07' });
      expect(res.body.outcome).toBe('verified');
      const calls = await owner.query(`SELECT provider_code, outcome, cost_cents FROM provider_calls WHERE verification_id = $1 ORDER BY attempt_no`, [res.body.id]);
      expect(calls.rows).toEqual([
        { provider_code: 'down', outcome: 'error_5xx', cost_cents: 0 },
        { provider_code: 'mock', outcome: 'success', cost_cents: 0 },
      ]);
    } finally {
      await alt.close();
    }
  });

  it('does not charge when every provider is down (hold released)', async () => {
    const alt = await buildTestApp({ liveAdapters: [new DownProvider()], liveCapabilityConfig: caps([['down', 10]]) });
    try {
      const before = await owner.query(`SELECT balance_cents::int AS b, held_cents::int AS h FROM wallets WHERE tenant_id = $1`, [tenantA.tenantId]);
      const res = await request(alt.app).post('/v1/verify/company').set(auth(tenantA.keys.live)).send({ registration_number: '2022/271828/07' });
      expect(res.body).toMatchObject({ outcome: 'unable_to_verify', billing: { charged: false } });
      const after = await owner.query(`SELECT balance_cents::int AS b, held_cents::int AS h FROM wallets WHERE tenant_id = $1`, [tenantA.tenantId]);
      expect(after.rows[0]).toEqual(before.rows[0]);
      const hold = await owner.query(`SELECT status FROM wallet_holds WHERE reference_id = $1`, [res.body.id]);
      expect(hold.rows[0].status).toBe('released');
    } finally {
      await alt.close();
    }
  });
});

describe('POST /v1/verify/driver-license', () => {
  const driverConsent = {
    notice_code: 'driver_verification',
    subject_display: 'T. Mokoena',
    subject_role: 'driver',
    on_behalf_of_subject: true,
    purposes: ['driver_licence_verification'],
    captured_at: '2026-11-14T08:00:00+02:00',
    evidence_reference: 'driver-consent-form-77',
    attested_by: 'fleet@logistics.example',
  };

  it('sandbox key: verifies licence codes and PrDP for free', async () => {
    const res = await request(t.app)
      .post('/v1/verify/driver-license')
      .set(auth(tenantA.keys.test))
      .send({ id_number: '8001015009087', licence_number: '400100001234', surname: 'Mokoena', required_codes: ['C1'], required_prdp: ['G'], consent: driverConsent });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'driver_licence', outcome: 'verified', billing: { sku: 'DRIVER_LICENCE_CHECK', price_cents: 0, charged: false } });
    expect(res.body.checks.licence.result).toMatchObject({ codes: ['EC1'], missing_codes: [] });
    expect(res.body.checks.prdp.result).toMatchObject({ categories: ['G', 'P'], missing_categories: [] });
  });

  it('live key: charges R2.50 and fails expired licences / insufficient codes', async () => {
    const expired = await request(t.app)
      .post('/v1/verify/driver-license')
      .set(auth(tenantA.keys.live))
      .send({ id_number: '8001015009087', licence_number: '400100000410', required_codes: ['C1'], consent: driverConsent });
    expect(expired.body).toMatchObject({ outcome: 'failed_checks', billing: { price_cents: 250, charged: true } });
    expect(expired.body.risk_flags).toContain('licence_expired');

    const codes = await request(t.app)
      .post('/v1/verify/driver-license')
      .set(auth(tenantA.keys.live))
      .send({ id_number: '8001015009087', licence_number: '400100005555', required_codes: ['EC'], consent: driverConsent });
    expect(codes.body.risk_flags).toContain('licence_code_insufficient');
  });

  it('requires driver consent', async () => {
    const res = await request(t.app).post('/v1/verify/driver-license').set(auth(tenantA.keys.live)).send({ id_number: '8001015009087' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('consent_required');
  });

  it('rejects invalid SA ID numbers', async () => {
    const res = await request(t.app).post('/v1/verify/driver-license').set(auth(tenantA.keys.live)).send({ id_number: '8001015009088', consent: driverConsent });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_id_number');
  });
});

describe('webhooks, audit and retention', () => {
  it('delivers signed webhooks from the outbox', async () => {
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    await owner.query(`UPDATE webhook_endpoints SET url = $1 WHERE tenant_id = $2`, [`https://hooks.example.test:${port}/hook`, tenantA.tenantId]);

    const c = new Crypto(new LocalKeyProvider(KEYS.KEK_KEYS), Buffer.from(KEYS.BLIND_INDEX_ROOT_KEY, 'base64'));
    // Route the https URL to the local plain-HTTP listener for the test.
    const fetchToLocal: typeof fetch = (url, init) => fetch(String(url).replace(`https://hooks.example.test:${port}`, `http://127.0.0.1:${port}`), init);
    const dispatcher = new WebhookDispatcher(owner, c, logger, fetchToLocal);
    let total = 0;
    for (let i = 0; i < 5; i++) total += await dispatcher.runOnce(100);
    server.close();

    expect(total).toBeGreaterThan(0);
    const first = received[0]!;
    expect(verifyWebhook(String(first.headers['tshepovet-signature']), first.body, webhookSecret)).toBe(true);
    const evt = JSON.parse(first.body);
    expect(evt).toMatchObject({ type: 'verification.completed', data: { status: 'completed' } });
    expect(first.body).not.toContain('AB12CD34EF');
    const pending = await owner.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status <> 'succeeded'`);
    expect(pending.rows[0].n).toBe(0);
  });

  it('keeps every tenant audit chain intact', async () => {
    for (const tenant of [tenantA, tenantB]) {
      const r = await owner.query(`SELECT verify_audit_chain($1) AS broken`, [tenant.tenantId]);
      expect(r.rows[0].broken).toBeNull();
    }
    const n = await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(n.rows[0].n).toBeGreaterThan(10);
  });

  it('wallet projection equals the ledger', async () => {
    const r = await owner.query(
      `SELECT w.balance_cents::int AS wallet, (100000 + coalesce(sum(-e.amount_cents) FILTER (WHERE e.account_id = w.ledger_account_id), 0))::int AS ledger
         FROM wallets w LEFT JOIN ledger_entries e ON e.tenant_id = w.tenant_id WHERE w.tenant_id = $1 GROUP BY w.balance_cents, w.ledger_account_id`,
      [tenantA.tenantId],
    );
    expect(r.rows[0].wallet).toBe(r.rows[0].ledger);
  });

  it('retention purge crypto-shreds expired TCS PINs and raw bureau payloads', async () => {
    await owner.query(`UPDATE tax_compliance_pins SET purge_after = now() - interval '1 minute'`);
    await owner.query(`UPDATE provider_calls SET purge_after = now() - interval '1 minute'`);
    const out = await purgeOnce(owner, async () => undefined);
    expect(out.tcs_pins).toBeGreaterThan(0);
    const pins = await owner.query(`SELECT count(*)::int AS n FROM tax_compliance_pins WHERE pin_enc IS NOT NULL`);
    expect(pins.rows[0].n).toBe(0);
    const raw = await owner.query(`SELECT count(*)::int AS n FROM provider_calls WHERE response_enc IS NOT NULL`);
    expect(raw.rows[0].n).toBe(0);
  });
});
