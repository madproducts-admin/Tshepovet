/**
 * Smoke suite for the TshepoVet API (sandbox) at https://tshepovet.madproducts.ai, through
 * Cloudflare, IIS and the tshepovet-api service. The web app's pages: web.smoke.ts.
 *
 *   npm run app:smoke                         anonymous checks only
 *   deploy/app/deploy-app.ps1                 runs it after a deploy, with the sandbox key
 *
 * TSV_SANDBOX_API_KEY (the tv_test_ key of the sandbox tenant, from
 * C:\ProgramData\MADProducts\tshepovet\sandbox-tenant.json) enables the end-to-end check;
 * the deploy script passes it in the environment and never prints it.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const KEY = process.env.TSV_SANDBOX_API_KEY;

test('/healthz answers, with the security headers and no server banner', async ({ request, baseURL }) => {
  const res = await request.get(`/healthz?cb=${Date.now()}`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const h = res.headers();
  if (baseURL?.startsWith('https:')) expect(h['strict-transport-security']).toContain('max-age=31536000');
  // Each header once: the API sends its own, IIS adds only HSTS and X-Robots-Tag.
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(h['x-robots-tag']).toBe('noindex, nofollow');
  if (process.env.TSV_EXPECT_RELEASE) expect(h['x-tshepovet-release']).toBe(process.env.TSV_EXPECT_RELEASE);
  // Express sends none; IIS ARR adds "ARR/3.0", which web.config blanks (ARR cannot be
  // made to drop the header itself). Absent or empty both reveal nothing.
  expect(h['x-powered-by'] ?? '').toBe('');
});

test('/readyz answers: the live API reaches PostgreSQL and Redis', async ({ request }) => {
  const res = await request.get(`/readyz?cb=${Date.now()}`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('the API refuses a call without a key', async ({ request }) => {
  const res = await request.get(`/v1/verifications/${randomUUID()}`);
  expect(res.status()).toBe(401);
  expect(res.headers()['content-type']).toContain('json');
});

test('an unknown API path is a JSON 404, not an IIS page', async ({ request }) => {
  const res = await request.get('/v1/no-such-endpoint');
  expect(res.status()).toBe(404);
});

test('a sandbox company check runs end to end', async ({ request }) => {
  test.skip(!KEY, 'TSV_SANDBOX_API_KEY is not set');
  const auth = { Authorization: `Bearer ${KEY}` };
  // The README's example request; tv_test_ keys always reach the deterministic mock bureau.
  const res = await request.post('/v1/verify/company', {
    headers: { ...auth, 'Idempotency-Key': `smoke-${randomUUID()}` },
    data: { registration_number: 'CK2001/012345/23', vat_number: '4123456789', checks: ['registration', 'directors', 'vat'] },
  });
  expect([200, 202], await res.text()).toContain(res.status());
  const body = await res.json();
  expect(body.id).toBeTruthy();

  const again = await request.get(`/v1/verifications/${body.id}`, { headers: auth });
  expect(again.status(), await again.text()).toBe(200);
  expect((await again.json()).id).toBe(body.id);
});
