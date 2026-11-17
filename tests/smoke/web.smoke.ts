/**
 * Smoke suite for the TshepoVet web app (sandbox) at https://tshepovet.madproducts.ai, through
 * Cloudflare, IIS and the tshepovet-web service. The API: api.smoke.ts; the docs: site.smoke.ts.
 *
 *   npx playwright test tests/smoke/web.smoke.ts
 *   deploy/app/deploy-app.ps1 runs it after a switch, with TSV_EXPECT_BUILD set to the release
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BUILD = process.env.TSV_EXPECT_BUILD;
const cb = () => `cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('the landing page is the web app, with its own nonce CSP and each header once', async ({ request, baseURL }) => {
  const res = await request.get(`/?${cb()}`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['content-type']).toContain('text/html');
  expect(await res.text()).toContain('TshepoVet');
  // The page's own policy, never IIS's API policy (default-src 'none' would block the page).
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  expect(h['content-security-policy']).not.toContain("default-src 'none'");
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['x-robots-tag']).toBe('noindex, nofollow');
  if (baseURL?.startsWith('https:')) expect(h['strict-transport-security']).toContain('max-age=31536000');
  expect(h['x-powered-by'] ?? '').toBe('');
  if (BUILD) expect(h['x-tshepovet-build']).toBe(BUILD);
});

for (const path of ['/pricing', '/glossary', '/verify-passport', '/sign-in', '/sign-up', '/supplier/sign-in', '/staff/sign-in', '/legal/privacy']) {
  test(`${path} renders`, async ({ request }) => {
    const res = await request.get(`${path}?${cb()}`, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });
}

test('the pricing page reads its prices from the API', async ({ request }) => {
  const html = await (await request.get(`/pricing?${cb()}`)).text();
  expect(html).toMatch(/R\s?\d/);
});

test('portal, supplier and staff pages send a visitor without a session to sign in', async ({ request }) => {
  for (const [path, to] of [
    ['/app', '/sign-in'],
    ['/app/checks', '/sign-in'],
    ['/supplier', '/supplier/sign-in'],
    ['/staff', '/staff/sign-in'],
  ]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect([302, 303, 307, 308], path).toContain(res.status());
    expect(new URL(res.headers()['location'] ?? '', 'https://x.invalid').pathname, path).toBe(to);
  }
});

test('an unknown passport is a 404 page, not an error', async ({ request }) => {
  const res = await request.get(`/passport/${randomUUID()}?${cb()}`);
  expect(res.status()).toBe(404);
  expect(res.headers()['content-type']).toContain('text/html');
});

test('the build assets load and are cached for good', async ({ request }) => {
  const html = await (await request.get(`/?${cb()}`)).text();
  const asset = /\/_next\/static\/[^"'\s]+\.js/.exec(html)?.[0];
  expect(asset, 'a script under /_next/static').toBeTruthy();
  const res = await request.get(asset!);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('immutable');
});

test('the API documentation is still at /docs', async ({ request }) => {
  const res = await request.get(`/docs/?${cb()}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
});
