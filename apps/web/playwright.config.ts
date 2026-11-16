import { defineConfig, devices } from '@playwright/test';

/**
 * Accessibility and flow tests for the web app, against a production build (`next start`).
 *   npx playwright test -c apps/web/playwright.config.ts
 * TSV_WEB_URL points them at another server (e.g. the live site) instead.
 */
const port = Number(process.env.TSV_WEB_PORT ?? 3194);
const baseURL = process.env.TSV_WEB_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 120_000,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.TSV_WEB_URL
    ? undefined
    : {
        command: `npx next start --port ${port} --hostname 127.0.0.1`,
        cwd: __dirname,
        url: `${baseURL}/design-system`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
