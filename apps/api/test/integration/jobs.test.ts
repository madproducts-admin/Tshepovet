import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';
import { Client, type Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompanyVerificationService,
  enqueueMail,
  failVerification,
  jobsConnection,
  type JobsRuntime,
  loadConfig,
  logger,
  SandboxGraphClient,
  SandboxMailer,
  startJobs,
  VerificationBusyError,
  VerificationQueue,
  WA_STREAM,
  type WebhookFetch,
} from '@tshepovet/core';
import { buildContainer, type Container } from '../../src/container';
import { buildTestApp, createTenant, KEYS, ownerPool, resetDatabase } from './harness';
import { ownerWithMfa } from './portal-helpers';

/**
 * The background jobs (docs/PLAN.md M7) against the real database and Redis: the API hands
 * verifications to the queue and a worker runs them; one abandoned by a crash is resumed by
 * the watchdog; finalising happens once whoever gets there; webhooks and email are woken by
 * the commit itself; the monitoring sweep reminds, expires, locks payments, re-checks and
 * charges; the WhatsApp worker answers through the sandbox Graph client.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
let worker: Container;
let workerRedis: Redis;
let queue: VerificationQueue;
let jobs: JobsRuntime;
let docsDir: string;
const sent: Array<{ url: string; type: string; body: Record<string, unknown> }> = [];
let failNext = 0;

const fetchStub: WebhookFetch = async (url, init) => {
  const body = JSON.parse(init.body) as { type: string };
  sent.push({ url, type: body.type, body });
  if (failNext > 0) {
    failNext--;
    return { status: 503 };
  }
  return { status: 200 };
};

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const prefix = `tvtest${Date.now()}`;

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  const connection = jobsConnection(process.env.TEST_REDIS_URL!);
  queue = new VerificationQueue(connection, prefix);
  t = await buildTestApp({ jobs: queue });

  // The worker: its own container on a BYPASSRLS pool, as the service runs it.
  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.TEST_OWNER_DATABASE_URL, REDIS_URL: process.env.TEST_REDIS_URL, SYNC_DEADLINE_MS: '5000', SANDBOX: 'true', ...KEYS });
  workerRedis = new Redis(process.env.TEST_REDIS_URL!);
  worker = buildContainer(config, owner, workerRedis, logger, { jobs: queue });
  docsDir = mkdtempSync(path.join(tmpdir(), 'tv-docs-'));
  jobs = await startJobs({
    pool: owner,
    redis: workerRedis,
    crypto: worker.crypto,
    log: logger,
    connection,
    listen: async () => {
      const c = new Client({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
      await c.connect();
      return c;
    },
    company: worker.company,
    driver: worker.driver,
    resolvers: worker.resolvers,
    consent: worker.consent,
    verificationQueue: queue,
    appUrl: 'https://tshepovet.test',
    sandbox: true,
    webhookFetch: fetchStub,
    mailer: new SandboxMailer(owner),
    whatsapp: { graph: new SandboxGraphClient(owner, worker.crypto), documentsDir: docsDir },
    prefix,
    schedules: false,
  });
}, 120_000);

afterAll(async () => {
  await jobs?.stop();
  await queue?.close();
  await t?.close();
  await workerRedis?.quit();
  await owner?.end();
  if (docsDir) rmSync(docsDir, { recursive: true, force: true });
});

async function addWebhook(tenantId: string, events: string[]) {
  const enc = await t.container.crypto.encrypt('whsec_test_secret_value', `webhook_secret:${tenantId}`);
  await owner.query(`INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events) VALUES ($1, 'https://hooks.example.com/tv', $2, $3)`, [tenantId, enc, events]);
}

describe('verifications in the worker', () => {
  let tenantId = '';
  let key = '';
  beforeAll(async () => {
    const tn = await createTenant(owner, 'Jobs Buyers (Pty) Ltd', 100_000);
    tenantId = tn.tenantId;
    key = tn.keys.test;
    await addWebhook(tenantId, ['verification.completed', 'verification.failed']);
  });

  it('runs an async check in the worker and delivers its webhook on commit', async () => {
    const res = await request(t.app).post('/v1/verify/company').set('authorization', `Bearer ${key}`).send({ registration_number: '2019/123456/07', mode: 'async' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const id = res.body.id as string;
    const done = await waitFor('the async verification', async () => {
      const r = await owner.query<{ status: string; run_attempts: number; resume_enc: Buffer | null }>(`SELECT status, run_attempts, resume_enc FROM verifications WHERE id = $1`, [id]);
      return r.rows[0]?.status === 'completed' ? r.rows[0] : null;
    });
    expect(done.run_attempts).toBe(1); // the worker ran it, not the API
    expect(done.resume_enc).toBeNull(); // the stored input (and any PIN) is gone once final
    // Woken by NOTIFY on commit: well inside the 60-second backstop.
    await waitFor('the webhook', async () => sent.find((s) => s.type === 'verification.completed' && (s.body.data as { verification_id: string }).verification_id === id));
  });

  it('resumes a verification whose runner stopped, from its stored input', async () => {
    // A service that "crashes" after creating: it stores the input and never runs it.
    const lost = new CompanyVerificationService({
      pool: t.container.pool,
      crypto: t.container.crypto,
      resolvers: t.container.resolvers,
      consent: t.container.consent,
      log: logger,
      syncDeadlineMs: 5000,
      costCeilingCents: 240,
      jobs: { schedule: async () => undefined },
    });
    const auth = { tenantId, apiKeyId: null, userId: null, environment: 'test' as const, chargeTestChecks: true, scopes: [] };
    const input = {
      registrationNumber: '2019/123456/07',
      vatNumber: null,
      taxReferenceNumber: null,
      tcsPin: null,
      checks: ['registration' as const],
      externalRef: 'JOBS-1',
      consentId: null,
      consentAttestation: null,
      freshness: 'cached_ok' as const,
      maxAgeSeconds: null,
      mode: 'async' as const,
      monitor: false,
    };
    const { verificationId } = await lost.start(auth, input, 'req_jobs_lost');
    const held = await owner.query<{ held_cents: number }>(`SELECT held_cents FROM wallets WHERE tenant_id = $1`, [tenantId]);
    expect(held.rows[0]!.held_cents).toBe(300);

    // Not stale yet: the watchdog leaves it alone.
    expect((await jobs.watchdog()).resumed).toBe(0);
    await owner.query(`UPDATE verifications SET requested_at = now() - interval '3 minutes' WHERE id = $1`, [verificationId]);
    expect((await jobs.watchdog()).resumed).toBe(1);
    await waitFor('the resumed verification', async () => {
      const r = await owner.query<{ status: string; charged: boolean }>(`SELECT status, charged FROM verifications WHERE id = $1`, [verificationId]);
      return r.rows[0]?.status === 'completed' ? r.rows[0] : null;
    });
    const w = await owner.query<{ held_cents: number; balance_cents: number }>(`SELECT held_cents, balance_cents FROM wallets WHERE tenant_id = $1`, [tenantId]);
    expect(w.rows[0]).toMatchObject({ held_cents: 0, balance_cents: 100_000 - 300 }); // captured once

    // Finalising again (a late runner) changes nothing.
    expect(await failVerification(owner, worker.crypto, verificationId, 'late')).toBe(false);
    expect((await owner.query(`SELECT 1 FROM verification_checks WHERE verification_id = $1`, [verificationId])).rowCount).toBe(1);
  });

  it('leaves one the API is still running, and ends one it cannot run with nothing charged', async () => {
    const auth = { tenantId, apiKeyId: null, userId: null, environment: 'test' as const, chargeTestChecks: true, scopes: [] };
    const base = {
      registrationNumber: '2019/123456/07',
      vatNumber: null,
      taxReferenceNumber: null,
      tcsPin: null,
      checks: ['registration' as const],
      externalRef: null,
      consentId: null,
      consentAttestation: null,
      freshness: 'cached_ok' as const,
      maxAgeSeconds: null,
      monitor: false,
    };
    const lost = new CompanyVerificationService({
      pool: t.container.pool,
      crypto: t.container.crypto,
      resolvers: t.container.resolvers,
      consent: t.container.consent,
      log: logger,
      syncDeadlineMs: 5000,
      costCeilingCents: 240,
      jobs: { schedule: async () => undefined },
    });
    // Claimed by its runner: a worker must wait.
    const a = await lost.start(auth, { ...base, mode: 'async' }, 'req_jobs_busy');
    await owner.query(`UPDATE verifications SET claimed_until = now() + interval '1 minute' WHERE id = $1`, [a.verificationId]);
    await expect(jobs.runner.run(a.verificationId)).rejects.toBeInstanceOf(VerificationBusyError);
    await owner.query(`UPDATE verifications SET claimed_until = NULL WHERE id = $1`, [a.verificationId]);
    expect(await jobs.runner.run(a.verificationId)).toBe('completed');

    // No stored input (made before M7, say): failed, the hold released, the buyer told.
    const before = (await owner.query<{ balance_cents: number }>(`SELECT balance_cents FROM wallets WHERE tenant_id = $1`, [tenantId])).rows[0]!.balance_cents;
    const b = await lost.start(auth, { ...base, mode: 'async' }, 'req_jobs_unresumable');
    await owner.query(`UPDATE verifications SET resume_enc = NULL WHERE id = $1`, [b.verificationId]);
    expect(await jobs.runner.run(b.verificationId)).toBe('failed');
    const v = await owner.query<{ status: string; outcome: string; charged: boolean; risk_flags: string[] }>(`SELECT status, outcome, charged, risk_flags FROM verifications WHERE id = $1`, [b.verificationId]);
    expect(v.rows[0]).toMatchObject({ status: 'failed', outcome: 'unable_to_verify', charged: false, risk_flags: ['internal_error', 'not_resumable'] });
    const w = await owner.query<{ held_cents: number; balance_cents: number }>(`SELECT held_cents, balance_cents FROM wallets WHERE tenant_id = $1`, [tenantId]);
    expect(w.rows[0]).toMatchObject({ held_cents: 0, balance_cents: before }); // nothing charged for it
    await waitFor('the failure webhook', async () => sent.find((s) => s.type === 'verification.failed'));
  });
});

describe('delivery woken on commit', () => {
  it('retries a delivery as soon as it is made due again', async () => {
    const tn = await createTenant(owner, 'Retry Buyers (Pty) Ltd', 10_000);
    await addWebhook(tn.tenantId, ['verification.completed']);
    failNext = 1;
    const res = await request(t.app).post('/v1/verify/company').set('authorization', `Bearer ${tn.keys.test}`).send({ registration_number: '2019/123456/07' });
    expect(res.status).toBe(200);
    const d = await waitFor('the failed first attempt', async () => {
      const r = await owner.query<{ id: string; status: string; next_attempt_at: Date }>(`SELECT id, status, next_attempt_at FROM webhook_deliveries WHERE tenant_id = $1`, [tn.tenantId]);
      return r.rows[0]?.status === 'failed' ? r.rows[0] : null;
    });
    expect(d.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 15_000); // backoff: about 30 seconds
    // A replay (the dashboard does this) makes it due now: the trigger wakes the worker.
    await owner.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1`, [d.id]);
    await waitFor('the redelivery', async () => {
      const r = await owner.query<{ status: string }>(`SELECT status FROM webhook_deliveries WHERE id = $1`, [d.id]);
      return r.rows[0]?.status === 'succeeded';
    });
  });

  it('holds email in the sandbox outbox', async () => {
    await enqueueMail(owner, { tenantId: null, to: 'someone@jobs.example', template: 'password_changed', vars: { appUrl: 'https://tshepovet.test' } });
    await waitFor('the sandbox mailer', async () => {
      const r = await owner.query<{ status: string }>(`SELECT status FROM email_outbox WHERE to_email = 'someone@jobs.example'`);
      return r.rows[0]?.status === 'sandbox';
    });
  });
});

describe('the monitoring sweep', () => {
  let buyer: Awaited<ReturnType<typeof ownerWithMfa>>;
  let supplierId = '';
  const consent = { confirmed: true, evidence_reference: 'Signed onboarding form SOF-JOBS-1' };
  const balance = async (tenantId: string) => (await owner.query<{ b: number }>(`SELECT balance_cents AS b FROM wallets WHERE tenant_id = $1`, [tenantId])).rows[0]!.b;

  beforeAll(async () => {
    buyer = await ownerWithMfa(t.app, owner, 'owner@monitoring-jobs.example', 'Monitoring Jobs (Pty) Ltd');
    expect((await buyer.b.post('/api/wallet/topups', { credit_cents: 10_000 })).status).toBe(201);
    supplierId = (await buyer.b.post('/api/suppliers', { registration_number: '2019/123456/07' })).body.id;
    expect((await buyer.b.post(`/api/monitoring/${supplierId}`, { erp_lock_enabled: true, consent })).status).toBe(201);
    await addWebhook(buyer.tenantId, ['document.expiring', 'document.expired', 'vendor.payment_locked']);
  }, 60_000);

  it('charges the month, queues the weekly re-check, and does neither twice', async () => {
    const before = await balance(buyer.tenantId);
    const r1 = await jobs.monitoring.sweep();
    expect(r1).toMatchObject({ charged: 1, rechecksQueued: 1 });
    expect(await balance(buyer.tenantId)).toBe(before - 1500);
    // The re-check runs in the monitoring queue: a company check at no charge.
    const v = await waitFor('the re-check', async () => {
      const r = await owner.query<{ sku: string; price_cents: number; status: string }>(
        `SELECT sku, price_cents, status FROM verifications WHERE tenant_vendor_id = $1 AND status = 'completed'`,
        [supplierId],
      );
      return r.rows[0];
    });
    expect(v).toMatchObject({ sku: 'MONITORING_RECHECK', price_cents: 0 });
    const r2 = await jobs.monitoring.sweep();
    expect(r2).toMatchObject({ charged: 0, rechecksQueued: 0 });
    expect(await balance(buyer.tenantId)).toBe(before - 1500);
  });

  it('reminds before something expires, once per threshold', async () => {
    await owner.query(
      `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, next_action_at, next_action)
       VALUES ($1, $2, 'tcs_pin', gen_random_uuid(), current_date + 10, now(), 'remind')`,
      [buyer.tenantId, supplierId],
    );
    expect((await jobs.monitoring.sweep()).reminded).toBe(1);
    const s = await owner.query<{ reminders_sent: number[]; next_action: string; days: number }>(
      `SELECT reminders_sent, next_action, (next_action_at AT TIME ZONE 'Africa/Johannesburg')::date - current_date AS days FROM expiry_schedules WHERE tenant_vendor_id = $1 AND subject_type = 'tcs_pin'`,
      [supplierId],
    );
    expect(s.rows[0]).toMatchObject({ reminders_sent: [30, 14], next_action: 'remind', days: 3 }); // the 7-day reminder next
    expect((await jobs.monitoring.sweep()).reminded).toBe(0);
    const mail = await owner.query<{ subject: string }>(`SELECT subject FROM email_outbox WHERE to_email = 'owner@monitoring-jobs.example' AND template = 'expiry_reminder'`);
    expect(mail.rows).toHaveLength(1);
    expect(mail.rows[0]!.subject).toMatch(/^ACME TRADING \(PTY\) LTD: The tax compliance PIN expires on \d{1,2} \w+ \d{4}$/);
    await waitFor('the expiring webhook', async () => sent.find((x) => x.type === 'document.expiring'));
  });

  it('on the day it expires, locks payments when the buyer asked for it', async () => {
    await owner.query(`UPDATE expiry_schedules SET expires_on = current_date, next_action_at = now() WHERE tenant_vendor_id = $1 AND subject_type = 'tcs_pin'`, [supplierId]);
    expect(await jobs.monitoring.sweep()).toMatchObject({ expired: 1, locked: 1 });
    const tv = await owner.query<{ payment_lock_status: string; payment_lock_reason: string }>(`SELECT payment_lock_status, payment_lock_reason FROM tenant_vendors WHERE id = $1`, [supplierId]);
    expect(tv.rows[0]!.payment_lock_status).toBe('locked');
    expect(tv.rows[0]!.payment_lock_reason).toMatch(/^The tax compliance PIN expired on /);
    const lock = await waitFor('the payment-lock webhook', async () => sent.find((x) => x.type === 'vendor.payment_locked'));
    expect(lock.body.data).toMatchObject({ supplier_id: supplierId, source: 'monitoring' });
    expect((await owner.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'payments.locked'`, [buyer.tenantId])).rowCount).toBe(1);
  });

  it('keeps monitoring a week when the month cannot be paid, then stops', async () => {
    const poor = await ownerWithMfa(t.app, owner, 'owner@unpaid-jobs.example', 'Unpaid Jobs (Pty) Ltd');
    const sid = (await poor.b.post('/api/suppliers', { registration_number: '2019/123456/07' })).body.id;
    expect((await poor.b.post(`/api/monitoring/${sid}`, { consent })).status).toBe(201);
    expect((await jobs.monitoring.sweep()).unpaid).toBeGreaterThanOrEqual(1);
    const e = await owner.query<{ unpaid_since: string | null }>(`SELECT unpaid_since::text FROM monitoring_enrolments WHERE tenant_vendor_id = $1`, [sid]);
    expect(e.rows[0]!.unpaid_since).not.toBeNull();
    expect((await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = 'owner@unpaid-jobs.example' AND template = 'monitoring_unpaid'`)).rowCount).toBe(1);
    await jobs.monitoring.sweep(); // still within the week: no second email
    expect((await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = 'owner@unpaid-jobs.example' AND template = 'monitoring_unpaid'`)).rowCount).toBe(1);
    await owner.query(`UPDATE monitoring_enrolments SET unpaid_since = current_date - 8 WHERE tenant_vendor_id = $1`, [sid]);
    expect((await jobs.monitoring.sweep()).endedUnpaid).toBeGreaterThanOrEqual(1);
    expect((await owner.query(`SELECT 1 FROM monitoring_enrolments WHERE tenant_vendor_id = $1 AND period @> now()`, [sid])).rowCount).toBe(0);
  });

  it('renews modules at the end of the month, pauses unpaid ones and ends cancelled ones', async () => {
    const insert = (tenantId: string, sku: string, extra = '') =>
      owner.query<{ id: string }>(
        `INSERT INTO subscriptions (tenant_id, sku, status, unit_price_cents, current_period_start, current_period_end${extra ? ', cancel_at' : ''})
         VALUES ($1, $2, 'active', 1, current_date - interval '1 month', current_date${extra ? ', current_date' : ''}) RETURNING id`,
        [tenantId, sku],
      );
    const renew = (await insert(buyer.tenantId, 'MOD_LOGISTICS')).rows[0]!.id;
    const cancel = (await insert(buyer.tenantId, 'MOD_CONSTRUCTION', 'cancel')).rows[0]!.id;
    const unpaid = (await insert(buyer.tenantId, 'MOD_BBBEE')).rows[0]!.id; // R5 000: more than is left after the first
    // R3 000 in the wallet: logistics (R2 500) renews, B-BBEE (R5 000) cannot.
    await owner.query(`UPDATE wallets SET balance_cents = $2 WHERE tenant_id = $1`, [buyer.tenantId, 300_000]);
    await jobs.monitoring.sweep();
    const subs = await owner.query<{ id: string; status: string; ends: number }>(
      `SELECT id, status, current_period_end - current_date AS ends FROM subscriptions WHERE id = ANY($1)`,
      [[renew, cancel, unpaid]],
    );
    const by = Object.fromEntries(subs.rows.map((s) => [s.id, s]));
    expect(by[renew]).toMatchObject({ status: 'active' });
    expect(by[renew]!.ends).toBeGreaterThanOrEqual(28);
    expect(by[cancel]!.status).toBe('cancelled');
    expect(by[unpaid]!.status).toBe('past_due');
    expect(await balance(buyer.tenantId)).toBe(300_000 - 250_000);
    expect((await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = 'owner@monitoring-jobs.example' AND template = 'module_unpaid'`)).rowCount).toBe(1);
  });
});

describe('WhatsApp in the sandbox', () => {
  it('answers an invited supplier through the sandbox Graph client', async () => {
    const tn = await createTenant(owner, 'WhatsApp Buyers (Pty) Ltd', 10_000);
    const msisdn = '27820000001';
    const bidx = worker.crypto.blindIndex('msisdn', msisdn);
    await owner.query(`INSERT INTO wa_conversations (tenant_id, msisdn_enc, msisdn_bidx) VALUES ($1, $2, $3)`, [
      tn.tenantId,
      await worker.crypto.encrypt(msisdn, 'wa_msisdn'),
      bidx,
    ]);
    await workerRedis.xadd(
      WA_STREAM,
      '*',
      'kind',
      'message',
      'phone_number_id',
      'sandbox',
      'payload',
      JSON.stringify({ from: msisdn, id: 'wamid.jobs.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi' } }),
    );
    const out = await waitFor('the bot reply', async () => {
      const r = await owner.query<{ kind: string; body: { text: string } }>(`SELECT kind, body FROM wa_sandbox_messages WHERE msisdn_bidx = $1 AND direction = 'out' ORDER BY id`, [bidx]);
      return r.rows.length ? r.rows : null;
    });
    expect(out[0]!.body.text).toContain('WhatsApp Buyers (Pty) Ltd');
    const conv = await owner.query<{ state: string }>(`SELECT state FROM wa_conversations WHERE msisdn_bidx = $1`, [bidx]);
    expect(conv.rows[0]!.state).toBe('AWAITING_CONSENT');
  });

  it('tells an unknown number how onboarding works, and nothing more', async () => {
    const bidx = worker.crypto.blindIndex('msisdn', '27820000999');
    await workerRedis.xadd(WA_STREAM, '*', 'kind', 'message', 'phone_number_id', 'sandbox', 'payload', JSON.stringify({ from: '27820000999', id: 'wamid.jobs.2', timestamp: '0', type: 'text', text: { body: 'Hello?' } }));
    const out = await waitFor('the reply to a stranger', async () => {
      const r = await owner.query<{ body: { text: string } }>(`SELECT body FROM wa_sandbox_messages WHERE msisdn_bidx = $1`, [bidx]);
      return r.rows.length ? r.rows : null;
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.body.text).toContain('by invitation');
  });
});
