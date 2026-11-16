import { type BrowserContext, devices, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { totpCode, totpStep } from '../../../packages/core/src/auth/totp';
import { expectAxe } from './axe';

/**
 * The buyer portal as a new customer meets it, against a real API (deploy/app/run-web-e2e.ps1):
 * sign up, confirm the email, the enforced two-step setup, a sandbox top-up, a company check,
 * the supplier record, monitoring with consent, an API key, an invitation, consent records
 * and the audit chain. axe at AAA on every screen on the way; then the phone layout.
 */
test.describe.configure({ mode: 'serial' });

const stamp = Date.now();
const email = `owner-${stamp}@e2e-acme.example`;
const PW = 'correct horse battery 42';
let context: BrowserContext;
let page: Page;

async function mailToken(to: string, template: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
  await c.connect();
  try {
    for (let i = 0; i < 20; i++) {
      const r = await c.query<{ body_text: string }>(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`, [to, template]);
      const t = r.rows[0]?.body_text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
      if (t) return t;
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`no ${template} mail for ${to}`);
  } finally {
    await c.end();
  }
}

test.beforeAll(async ({ browser }, info) => {
  // Run once (desktop), and only against the e2e API with its database (run-web-e2e.ps1).
  test.skip(info.project.name !== 'desktop' || !process.env.TEST_OWNER_DATABASE_URL, 'portal flows run once, against the e2e API');
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context?.close();
});

test('signs up and confirms the email address', async () => {
  await page.goto('/sign-up');
  await expectAxe(page, 'sign-up');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Check the form' })).toBeVisible();
  await expectAxe(page, 'sign-up errors');

  await page.getByLabel('Organisation').fill('E2E Acme Buyers (Pty) Ltd');
  await page.getByLabel('Your full name').fill('Thandi Mokoena');
  await page.getByLabel('Work email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByRole('checkbox', { name: /I accept the terms/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.goto(`/verify-email#token=${await mailToken(email, 'verify_email')}`);
  await expect(page.getByRole('heading', { name: 'Email address confirmed' })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/); // the token left the address bar
});

test('signs in and sets up two-step verification before anything else', async () => {
  await page.goto('/sign-in');
  await expectAxe(page, 'sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/mfa-setup/);
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  const key = (await page.getByLabel(/^Setup key:/).textContent())!.replace(/\s/g, '');
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expectAxe(page, 'mfa setup');
  // A fresh step, so the code is not one the setup itself might have spent.
  await page.getByLabel('6-digit code').fill(totpCode(key, totpStep()));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification is on' })).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(10);
  await page.getByRole('button', { name: 'Continue to TshepoVet' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Thandi/ })).toBeVisible();
  await expectAxe(page, 'overview');
});

test('tops up the wallet in the sandbox and gets a tax invoice', async () => {
  await page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Wallet', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Top up' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAxe(page, 'top-up dialog');
  await page.getByRole('radio', { name: /^R\s?1\s000$/ }).check();
  await page.getByRole('button', { name: /^Pay R1\s150,00$/ }).click();
  await expect(page.getByRole('heading', { name: 'Wallet topped up' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(/TV-\d{6}/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(/^R1\s000,00$/).first()).toBeVisible();
  await expectAxe(page, 'wallet');
});

test('runs a company check and reads the result', async () => {
  await page.goto('/app/checks/new');
  await expectAxe(page, 'run a check');
  await page.getByLabel('Registration number').fill('2019/123456/07');
  await page.getByRole('button', { name: /^Run the check for/ }).click();
  await expect(page).toHaveURL(/\/app\/checks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'ACME TRADING (PTY) LTD', level: 1 })).toBeVisible();
  await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Nothing to look at')).toBeVisible();
  await expectAxe(page, 'check result');

  // A company being deregistered: the warning says what it means and what to do.
  await page.goto('/app/checks/new');
  await page.getByLabel('Registration number').fill('2018/000777/07');
  await page.getByRole('button', { name: /^Run the check for/ }).click();
  await expect(page.getByText('CIPC is deregistering the company')).toBeVisible();
  await expectAxe(page, 'check with warnings');
});

test('finds the supplier and works through its record', async () => {
  await page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Suppliers' }).click();
  await expect(page.getByRole('row', { name: /ACME TRADING/ })).toBeVisible();
  await expectAxe(page, 'suppliers');
  await page.getByRole('searchbox', { name: 'Search' }).fill('acme');
  await expect(page).toHaveURL(/q=acme/);
  await page.getByRole('link', { name: 'ACME TRADING (PTY) LTD' }).click();
  await expect(page.getByRole('heading', { name: 'ACME TRADING (PTY) LTD', level: 1 })).toBeVisible();
  await expectAxe(page, 'supplier facts');
  for (const tab of ['People', 'B-BBEE and bank', 'Documents', 'Checks', 'Audit trail']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectAxe(page, `supplier ${tab}`);
  }

  await page.getByRole('button', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: 'Approve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Supplier approved').first()).toBeVisible();
  await expect(page.getByText('Approved').first()).toBeVisible();
});

test('starts monitoring once the supplier’s consent is recorded', async () => {
  await page.getByRole('tab', { name: 'Monitoring' }).click();
  await page.getByRole('button', { name: 'Start monitoring' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start monitoring' }).click();
  await expect(page.getByRole('dialog')).toContainText('has not agreed to monitoring yet');
  await page.getByRole('checkbox', { name: 'The supplier agreed to continuous monitoring' }).check();
  await page.getByLabel('Where the evidence is kept').fill('Signed onboarding form SOF-E2E-1');
  await expectAxe(page, 'monitoring consent');
  await page.getByRole('dialog').getByRole('button', { name: 'Start monitoring' }).click();
  await expect(page.getByRole('button', { name: 'Stop monitoring' })).toBeVisible();
  await page.goto('/app/monitoring');
  await expect(page.getByRole('row', { name: /ACME TRADING/ })).toBeVisible();
  await expectAxe(page, 'monitoring');
});

test('adds a supplier by registration number', async () => {
  await page.goto('/app/suppliers');
  await page.getByRole('button', { name: 'Add a supplier' }).click();
  await page.getByRole('dialog').getByLabel('Registration number').fill('2020/654321/07');
  await page.getByRole('dialog').getByRole('button', { name: 'Add supplier' }).click();
  await expect(page).toHaveURL(/\/app\/suppliers\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Supplier added').first()).toBeVisible();
});

test('makes a test API key and shows it once', async () => {
  await page.goto('/app/developers');
  await expectAxe(page, 'developers');
  await page.getByRole('button', { name: 'Make a key' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('E2E integration');
  await page.getByRole('dialog').getByRole('button', { name: 'Make key' }).click();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  await expectAxe(page, 'new key');
  await page.getByRole('button', { name: 'I have stored it' }).click();
  await expect(page.getByRole('row', { name: /E2E integration/ })).toContainText('Never');
  await page.getByRole('tab', { name: 'Webhooks' }).click();
  await expectAxe(page, 'webhooks');
});

test('invites a colleague and explains the roles', async () => {
  await page.goto('/app/team');
  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByRole('dialog').getByLabel('Email address').fill(`buyer-${stamp}@e2e-acme.example`);
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Waiting to accept')).toBeVisible();
  await expectAxe(page, 'team');
});

test('shows consent records, modules, settings and the account', async () => {
  await page.goto('/app/compliance');
  await expect(page.getByRole('row', { name: /Monitoring/ }).first()).toBeVisible();
  await expectAxe(page, 'compliance');
  for (const tab of ['Data-subject requests', 'Privacy notices', 'What we process']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectAxe(page, `compliance ${tab}`);
  }
  for (const path of ['/app/modules', '/app/settings', '/app/account', '/app/checks']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAxe(page, path);
  }
});

test('verifies the audit chain', async () => {
  await page.goto('/app/compliance/audit');
  await page.getByRole('button', { name: 'Check the chain' }).click();
  await expect(page.getByText('The chain is intact')).toBeVisible();
  await expectAxe(page, 'audit log');
});

test('works on a phone: the menu opens as a dialog', async ({ browser }) => {
  const phone = await browser.newContext({ ...devices['Pixel 7'], storageState: await context.storageState() });
  const p = await phone.newPage();
  await p.goto('/app');
  await expect(p.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
  await expectAxe(p, 'phone overview');
  await p.getByRole('button', { name: 'Open the menu' }).click();
  await expect(p.getByRole('dialog', { name: 'Menu' })).toBeVisible();
  await expectAxe(p, 'phone menu');
  await p.getByRole('dialog').getByRole('link', { name: 'Suppliers' }).click();
  await expect(p.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await phone.close();
});

test('signs out', async () => {
  await page.goto('/app');
  await page.getByRole('button', { name: /Account menu for/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto('/app/wallet');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fwallet/);
});
