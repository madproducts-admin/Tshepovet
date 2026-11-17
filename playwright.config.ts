import { defineConfig, devices } from '@playwright/test';

/**
 * Docs-site smoke suite (tests/smoke). The target is TSV_E2E_BASE_URL, else
 * the live site. A local http URL starts `wrangler dev` on deploy/dist first,
 * so run `npm run site:build` before `npm run site:smoke:local`.
 */
const LIVE = 'https://tshepovet.madproducts.ai';
const baseURL = process.env.TSV_E2E_BASE_URL ?? LIVE;
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(baseURL);
const port = local ? new URL(baseURL).port || '8787' : null;

export default defineConfig({
  testDir: 'tests/smoke',
  testMatch: '**/*.smoke.ts',
  timeout: 60_000,
  // One retry against the live edge absorbs a network blip; a real defect
  // fails both attempts. None locally, where there is no network to blame.
  retries: local ? 0 : 1,
  workers: 2,
  reporter: [['line']],
  use: { baseURL, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: local
    ? {
        command: `npx --yes wrangler@4 dev --config deploy/site/wrangler.toml --ip 127.0.0.1 --port ${port} --log-level warn`,
        // Ready once the docs answer: "/" is the API's (a 404 here), and Playwright waits
        // for a status below 400.
        url: `${baseURL.replace(/\/$/, '')}/docs/`,
        reuseExistingServer: false,
        timeout: 180_000,
      }
    : undefined,
});
