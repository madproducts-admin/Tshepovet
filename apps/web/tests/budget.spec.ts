import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

/**
 * Script budget for the public pages (docs/PLAN.md §9, mobile performance). They render on the
 * server and need almost no client code of their own: React, the Next.js runtime and a few
 * kilobytes. The signed-in areas' client state (React Query, the toaster) lives in those areas'
 * layouts (AreaProviders, lib/queries.tsx); put back in the root layout, it adds about 36 KB to
 * every public page, and this test fails.
 *
 * Measured as in PLAN.md: gzip -9 of each of the app's own scripts (/_next/) the HTML loads,
 * without the noModule polyfills, which a current browser never downloads. Scripts Cloudflare
 * adds on the live site (Web Analytics) are not the app's and are not counted.
 */
const BUDGET_KB = 150;
const PUBLIC_PAGES = ['/', '/pricing', '/glossary'];

for (const path of PUBLIC_PAGES) {
  test(`public page ${path}: at most ${BUDGET_KB} KB of script, and no React Query`, async ({ request }) => {
    test.skip(test.info().project.name !== 'desktop', 'the weight is the same on every device: measured once');
    const html = await (await request.get(path)).text();
    const srcs = new Set(
      [...html.matchAll(/<script[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => !/\snomodule/i.test(tag))
        .map((tag) => /\ssrc="([^"]+)"/.exec(tag)?.[1])
        .filter((src): src is string => Boolean(src?.startsWith('/_next/')))
        .map((src) => src.replace(/&amp;/g, '&')),
    );
    expect(srcs.size, `${path} loads no scripts: the page did not render`).toBeGreaterThan(0);
    let total = 0;
    for (const src of srcs) {
      const body = await (await request.get(src)).body();
      total += gzipSync(body, { level: 9 }).length;
      expect(body.toString('utf8').includes('QueryClient'), `${src} carries React Query: is AreaProviders back in the root layout?`).toBe(false);
    }
    expect(Math.round(total / 1024), `${path}: KB of script (gzip)`).toBeLessThanOrEqual(BUDGET_KB);
  });
}
