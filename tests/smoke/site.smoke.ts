/**
 * Smoke suite for the docs site (Playwright, Chromium).
 *
 *   npx playwright test                 against https://tshepovet.madproducts.ai
 *   npm run site:smoke:local            against `wrangler dev` on deploy/dist
 *
 * TSV_E2E_BASE_URL picks the target. TSV_EXPECTED_BUILD_ID, which
 * tools/deploy.mjs sets, must then match the build-id meta on every page.
 *
 * Named *.smoke.ts, not *.spec.ts, so vitest's default include never picks
 * these up.
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tls from 'node:tls';

type SitePage = { source: string; out: string; path: string; artifact: string };
type Site = {
  pages: SitePage[];
  buildIdMeta: string;
  fonts: string[];
  csp: { scriptOrigins: string[]; connectOrigins: string[] };
};

const ROOT = join(__dirname, '..', '..');
const SITE = JSON.parse(readFileSync(join(ROOT, 'tools/lib/site.json'), 'utf8')) as Site;
const EXPECTED_BUILD = process.env.TSV_EXPECTED_BUILD_ID;

const sourceDiagrams = (p: SitePage) =>
  (readFileSync(join(ROOT, p.source), 'utf8').match(/<pre class="mermaid">/g) ?? []).length;

/** The CSP the assemble step wrote, when deploy/dist is present. */
function assembledCsp(): string | null {
  const file = join(ROOT, 'deploy/dist/_headers');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').match(/^\s+Content-Security-Policy: (.+)$/m)?.[1]?.trim() ?? null;
}

/**
 * The madproducts.ai zone runs Cloudflare's bot "JavaScript detections", which
 * inject an inline <script> into HTML responses. It carries a per-request ray
 * id, so no hash can allow it, and script-src 'self' blocks it: the zone loses
 * a bot signal on this static, noindex site and nothing else. It is the only
 * violation tolerated here, recognised by the first 40 characters that
 * 'report-sample' puts into the violation (as served on 2026-11-16).
 */
const CF_JSD_SAMPLE = '(function(){function c(){var b=a.content';

type Violation = { directive: string; blocked: string; sample: string };

/**
 * Collects page errors, console errors and CSP violations across navigations.
 * `expected404` is a path whose own 404 is the point of the test: Chrome logs
 * that document's status as a console error, and only that one is ignored.
 */
async function watch(page: Page, { expected404 }: { expected404?: string } = {}) {
  const errors: string[] = [];
  const tolerated: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // CSP refusals are judged from the violation events, which carry the sample.
    if (/Content Security Policy/i.test(m.text())) return;
    const from = m.location().url ? new URL(m.location().url).pathname : '';
    if (expected404 && from === expected404 && /status of 404/.test(m.text())) return;
    errors.push(`console: ${m.text()} (${m.location().url})`);
  });
  await page.exposeFunction('__tsvViolation', (v: Violation) => {
    if (v.directive.startsWith('script-src') && v.blocked === 'inline' && v.sample.startsWith(CF_JSD_SAMPLE)) {
      tolerated.push('Cloudflare bot-detection inline script blocked by the CSP');
    } else {
      errors.push(`csp: ${v.directive} blocked ${v.blocked || '(none)'} ${v.sample}`);
    }
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __tsvViolation: (v: Violation) => void }).__tsvViolation({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        sample: e.sample,
      });
    });
  });
  return async () => {
    await page.evaluate(() => document.fonts.ready.then(() => 0)); // let pending reports land
    if (tolerated.length) {
      test.info().annotations.push({ type: 'tolerated', description: [...new Set(tolerated)].join('; ') });
    }
    return errors;
  };
}

for (const p of SITE.pages) {
  test(`${p.path} loads with no errors, diagrams and fonts in place`, async ({ page }) => {
    const finish = await watch(page);
    const res = await page.goto(p.path, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    expect(res?.headers()['content-type']).toContain('text/html');
    await expect(page).toHaveTitle(/TshepoVet/);

    const build = await page.locator(`meta[name="${SITE.buildIdMeta}"]`).getAttribute('content');
    expect(build, 'build-id meta').toBeTruthy();
    if (EXPECTED_BUILD) expect(build).toBe(EXPECTED_BUILD);
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');

    await expect(page.locator('pre.mermaid')).toHaveCount(0);
    const svgs = page.locator('.diagram-canvas > svg');
    await expect(svgs).toHaveCount(sourceDiagrams(p));
    for (const svg of await svgs.all()) {
      const box = await svg.boundingBox();
      expect(box && box.width > 100 && box.height > 50, 'diagram has a real size').toBeTruthy();
    }
    expect(await page.content()).not.toContain('claude.ai');

    const fonts = await page.evaluate(async (families) => {
      await document.fonts.ready;
      const loaded = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')));
      return families.filter((f) => !loaded.has(f));
    }, SITE.fonts);
    expect(fonts, 'web fonts that did not load').toEqual([]);

    expect(await finish()).toEqual([]);
  });
}

test('page scripts run under the CSP', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const finish = await watch(page);

  await page.goto('/docs/');
  const copy = page.locator('.code-block .copy').first();
  await copy.click();
  await expect(copy).toHaveText(/Copied|Selected/);

  await page.goto('/docs/database-schema');
  await page.locator('#table-filter').fill('ledger');
  await expect(page.locator('#filter-count')).toHaveText(/^Showing \d+ of \d+ groups$/);

  await page.goto('/docs/architecture-compliance');
  const cost = page.locator('#r-cost');
  const before = await cost.textContent();
  await page.locator('#c-bureau').fill('9.00');
  await expect(cost).not.toHaveText(before ?? '');

  expect(await finish()).toEqual([]);
});

test('security, robots and caching headers', async ({ request, baseURL }) => {
  const res = await request.get('/docs/');
  expect(res.status()).toBe(200);
  const h = res.headers();

  const csp = h['content-security-policy'] ?? '';
  const expected = assembledCsp();
  if (expected) expect(csp).toBe(expected);
  const directives = new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  // 'self' plus Cloudflare Web Analytics only: never 'unsafe-inline'.
  expect(directives.get('script-src')).toEqual(["'self'", "'report-sample'", ...SITE.csp.scriptOrigins]);
  expect(directives.get('connect-src')).toEqual(["'self'", ...SITE.csp.connectOrigins]);
  expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
  expect(directives.get('object-src')).toEqual(["'none'"]);

  if (baseURL?.startsWith('https:')) expect(h['strict-transport-security']).toContain('max-age=31536000');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['x-robots-tag']).toBe('noindex, nofollow');
  expect(h['cache-control']).toBe('no-cache');

  const asset = (await res.text()).match(/src="(\/docs\/assets\/[^"]+\.js)"/)?.[1];
  expect(asset, 'a hashed script on the docs home page').toBeTruthy();
  const a = await request.get(asset!);
  expect(a.status()).toBe(200);
  expect(a.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(a.headers()['content-type']).toContain('javascript');
});

test('an unknown /docs path gets the 404 page, whose links work from any depth', async ({ page }) => {
  const finish = await watch(page, { expected404: '/docs/no/such/page' });
  const res = await page.goto('/docs/no/such/page');
  expect(res?.status()).toBe(404);
  expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page.locator('h1')).toHaveText('Page not found');
  await page.locator('a[href="/docs/database-schema"]').click();
  await expect(page).toHaveURL(/\/docs\/database-schema$/);
  await expect(page.locator('h1')).toContainText('Database');
  expect(await finish()).toEqual([]);
});

test('.html paths redirect to the clean path', async ({ request, baseURL }) => {
  for (const [from, to] of [
    ['/docs/verification-api.html', '/docs/verification-api'],
    ['/docs/index.html', '/docs/'],
    ['/docs', '/docs/'],
  ]) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect([301, 302, 307, 308], from).toContain(res.status());
    expect(new URL(res.headers()['location'] ?? '', baseURL).pathname, from).toBe(to);
  }
});

test('robots.txt keeps crawlers out', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  expect(await res.text()).toMatch(/^User-agent: \*\r?\nDisallow: \/$/m);
});

test('every internal link and #fragment resolves', async ({ request }) => {
  const html = new Map<string, string>();
  for (const p of SITE.pages) html.set(p.path, await (await request.get(p.path)).text());
  const ids = (doc: string) => new Set([...doc.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const problems: string[] = [];
  const checked = new Set<string>();
  for (const [from, doc] of html) {
    for (const [, href] of doc.matchAll(/<a\s[^>]*?href="([^"]+)"/g)) {
      if (!href || !(href.startsWith('/') || href.startsWith('#')) || href.startsWith('//')) continue;
      const [path, frag] = href.split('#');
      const target = path || from;
      const targetHtml = html.get(target);
      if (targetHtml === undefined) {
        if (checked.has(target)) continue;
        checked.add(target);
        const r = await request.get(target);
        if (r.status() !== 200) problems.push(`${from}: ${href} answers ${r.status()}`);
        continue;
      }
      if (frag && !ids(targetHtml).has(decodeURIComponent(frag))) problems.push(`${from}: ${href} has no target`);
    }
  }
  expect(problems).toEqual([]);
});

test('the HTTPS certificate is valid for the host', async ({ baseURL }) => {
  const url = new URL(baseURL!);
  test.skip(url.protocol !== 'https:', 'local run over http');
  // rejectUnauthorized (the default) fails the handshake on a bad chain or a
  // name mismatch, so getting a certificate back at all means it verified.
  const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: 443, servername: url.hostname, timeout: 15_000 }, () => {
      const c = socket.getPeerCertificate();
      socket.end();
      resolve(c);
    });
    socket.on('error', reject);
    socket.on('timeout', () => socket.destroy(new Error('TLS handshake timed out')));
  });
  const daysLeft = (new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000;
  expect(daysLeft).toBeGreaterThan(7);
  test.info().annotations.push({
    type: 'certificate',
    description: `${cert.subject?.CN} from ${cert.issuer?.O ?? ''} ${cert.issuer?.CN ?? ''}, valid to ${cert.valid_to}, SAN ${cert.subjectaltname}`,
  });
});
