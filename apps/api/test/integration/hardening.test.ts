import Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyVerificationService, logger, VerificationCache } from '@tshepovet/core';
import { buildTestApp, createTenant, ownerPool, resetDatabase } from './harness';
import { Browser, ownerWithMfa, PW } from './portal-helpers';

/**
 * Regression tests for the M9 security review: test keys cannot touch what live checks and
 * buyers see; a correct password does not reset the count of wrong second factors; a live
 * request never replays a test request's answer; invitations are capped per day.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  owner = ownerPool();
  t = await buildTestApp();
}, 120_000);

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('test keys and live data', () => {
  it('keeps the mock bureau’s answers out of the live cache', async () => {
    const live = new VerificationCache(t.container.pool, t.container.redis, t.container.crypto);
    const test = new VerificationCache(t.container.pool, t.container.redis, t.container.crypto, undefined, 'test');
    const tn = await createTenant(owner, 'Cache Buyers (Pty) Ltd', 0);
    const data = { enterpriseNumber: '2015/000001/07', legalName: 'MOCK', statusRaw: 'In Business', incorporationDate: null, entityTypeDescription: null, registeredAddress: null, directors: [] };
    await test.put('company_registration', '2015/000001/07', tn.tenantId, { kind: 'found', data: data as never, provider: 'mock', authoritative: true });
    expect(await test.get('company_registration', '2015/000001/07', tn.tenantId)).not.toBeNull();
    expect(await live.get('company_registration', '2015/000001/07', tn.tenantId)).toBeNull();
  });

  it('outside the sandbox, a test-key check leaves the shared supplier record alone', async () => {
    const tn = await createTenant(owner, 'Test Key Buyers (Pty) Ltd', 0);
    const c = t.container;
    const liveDeployment = new CompanyVerificationService({
      pool: c.pool,
      crypto: c.crypto,
      resolvers: c.resolvers,
      consent: c.consent,
      log: logger,
      syncDeadlineMs: 5000,
      costCeilingCents: 240,
      sharedRecordsFromTest: false,
    });
    const input = {
      registrationNumber: '2016/000002/07',
      vatNumber: null,
      taxReferenceNumber: null,
      tcsPin: null,
      checks: ['registration' as const, 'directors' as const],
      externalRef: null,
      consentId: null,
      consentAttestation: null,
      freshness: 'live' as const,
      maxAgeSeconds: null,
      mode: 'sync' as const,
      monitor: false,
    };
    const r = await liveDeployment.start({ tenantId: tn.tenantId, apiKeyId: null, userId: null, environment: 'test', scopes: [] }, input, 'req_hardening_1');
    expect(r.done).toBe(true);
    const v = await owner.query<{ legal_name: string; cipc_status: string | null; verified: Date | null; directors: number }>(
      `SELECT legal_name, cipc_status, passport_last_verified_at AS verified, (SELECT count(*)::int FROM vendor_directors d WHERE d.vendor_id = v.id) AS directors
         FROM vendors v WHERE cipc_enterprise_number = '2016/000002/07'`,
    );
    // The buyer got its (mock) answer; the shared record did not move.
    expect(v.rows[0]).toMatchObject({ cipc_status: null, verified: null, directors: 0 });
    const check = await owner.query<{ status: string; outcome: string }>(`SELECT status, outcome FROM verifications WHERE id = $1`, [r.verificationId]);
    expect(check.rows[0]).toMatchObject({ status: 'completed', outcome: 'verified' });
  });

  it('never replays a test request’s answer to a live request with the same key', async () => {
    const tn = await createTenant(owner, 'Idempotency Buyers (Pty) Ltd', 10_000);
    const send = (key: string) =>
      request(t.app).post('/v1/verify/company').set('authorization', `Bearer ${key}`).set('idempotency-key', 'same-key-for-both').send({ registration_number: '2019/123456/07' });
    expect((await send(tn.keys.test)).status).toBe(200);
    const live = await send(tn.keys.live);
    expect(live.status).toBe(422);
    expect(live.body.code).toBe('idempotency_key_reused');
  });
});

describe('two-step sign-in', () => {
  it('counts wrong codes across sign-ins: a correct password does not clear them', async () => {
    const u = await ownerWithMfa(t.app, owner, 'owner@mfa-guessing.example', 'MFA Guessing (Pty) Ltd');
    const signIn = async () => {
      const b = await new Browser(t.app).init();
      const r = await b.post('/api/auth/login', { email: 'owner@mfa-guessing.example', password: PW });
      return { b, r };
    };
    const first = await signIn();
    expect(first.r.body.mfa_required).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect((await first.b.post('/api/auth/mfa', { challenge: first.r.body.challenge, code: '000000' })).body.code).toBe('invalid_code');
    }
    // Before the fix, this sign-in reset the count to zero and allowed four more guesses.
    const second = await signIn();
    expect(second.r.body.mfa_required).toBe(true);
    await second.b.post('/api/auth/mfa', { challenge: second.r.body.challenge, code: '000000' });
    const row = await owner.query<{ locked: boolean }>(`SELECT locked_until > now() AS locked FROM tenant_users WHERE id = $1`, [u.userId]);
    expect(row.rows[0]!.locked).toBe(true);
    expect((await signIn()).r.body.code).toBe('invalid_credentials');
  });
});

describe('invitations', () => {
  it('caps how many a buyer sends in a day', async () => {
    const u = await ownerWithMfa(t.app, owner, 'owner@invite-cap.example', 'Invite Cap (Pty) Ltd');
    const sid = (await u.b.post('/api/suppliers', { registration_number: '2019/123456/07' })).body.id;
    await owner.query(
      `INSERT INTO vendor_invites (tenant_id, tenant_vendor_id, email, token_hash, created_by, expires_at, revoked_at)
       SELECT $1, $2, 'x' || g || '@cap.example', sha256(('cap-' || g)::bytea), $3, now() + interval '14 days', now()
         FROM generate_series(1, 100) g`,
      [u.tenantId, sid, u.userId],
    );
    const r = await u.b.post(`/api/suppliers/${sid}/invitations`, { email: 'one-more@cap.example' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('too_many_invitations');
  });
});
