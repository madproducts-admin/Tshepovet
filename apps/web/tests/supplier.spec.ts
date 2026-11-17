import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { totpCode, totpStep } from '../../../packages/core/src/auth/totp';
import { expectAxe } from './axe';

/**
 * The supplier's side in the browser, against a real API (deploy/app/run-web-e2e.ps1): a buyer
 * invites a supplier from its record; the supplier's director onboards from the emailed link
 * with the sandbox's sample documents and publishes a passport; signs in to self-service with
 * a magic link; the public passport and the printed-code check; withdrawing the passport.
 * axe at AAA on every screen on the way.
 */
test.describe.configure({ mode: 'serial' });

const stamp = Date.now();
const BUYER = `buyer-${stamp}@e2e-supplier-side.example`;
const DIRECTOR = `director-${stamp}@e2e-mock-555555.example`;
const REGISTRATION = '2021/555555/07';
const COMPANY = 'MOCK ENTERPRISE 555555 (PTY) LTD';
const PW = 'correct horse battery 42';

let buyerContext: BrowserContext;
let buyer: Page;
let supplierContext: BrowserContext;
let supplier: Page;
let supplierId = '';
let code = '';
let passportPath = '';

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

/** A buyer with two-step verification, a topped-up wallet and the supplier, set up through the API. */
async function setUpBuyer(rq: APIRequestContext) {
  let csrf = (await (await rq.get('/api/auth/csrf')).json()).csrf_token as string;
  const post = async (path: string, data: unknown = {}) => {
    const r = await rq.post(path, { data, headers: { 'x-csrf-token': csrf } });
    expect(r.status(), `${path}: ${await r.text()}`).toBeLessThan(300);
    const body = r.status() === 204 ? {} : await r.json();
    csrf = body?.session?.csrf_token ?? body?.csrf_token ?? csrf;
    return body;
  };
  await post('/api/auth/signup', { organisation_name: 'E2E Supplier Side Buyers (Pty) Ltd', full_name: 'Lerato Dlamini', email: BUYER, password: PW, accept_terms: true });
  await post('/api/auth/verify-email', { token: await mailToken(BUYER, 'verify_email') });
  await post('/api/auth/login', { email: BUYER, password: PW });
  const setup = await post('/api/auth/mfa/setup');
  await post('/api/auth/mfa/enable', { code: totpCode(setup.secret, totpStep()) });
  await post('/api/wallet/topups', { credit_cents: 100_000 });
  supplierId = (await post('/api/suppliers', { registration_number: REGISTRATION })).id;
}

test.beforeAll(async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop' || !process.env.TEST_OWNER_DATABASE_URL, 'supplier flows run once, against the e2e API');
  buyerContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  buyer = await buyerContext.newPage();
  await setUpBuyer(buyerContext.request);
  supplierContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  supplier = await supplierContext.newPage();
});
test.afterAll(async () => {
  await buyerContext?.close();
  await supplierContext?.close();
});

test('the buyer invites the supplier to onboard itself', async () => {
  await buyer.goto(`/app/suppliers/${supplierId}`);
  // Added without a check, the record waits for the register (onboarding looks it up).
  await expect(buyer.getByRole('heading', { name: 'PENDING VERIFICATION', level: 1 })).toBeVisible();
  await expect(buyer.getByRole('main').getByText(REGISTRATION).first()).toBeVisible();
  await buyer.getByRole('button', { name: 'Invite to onboard' }).click();
  const dialog = buyer.getByRole('dialog', { name: 'Invite the supplier to onboard' });
  await dialog.getByRole('button', { name: 'Send the invitation' }).click();
  await expect(dialog.getByText('Enter the supplier contact’s email address.')).toBeVisible();
  await expectAxe(buyer, 'invite dialog with an error');
  await dialog.getByLabel('Supplier contact’s email address').fill(DIRECTOR);
  await dialog.getByLabel(/Their name/).fill('Thandi Mokoena');
  await dialog.getByRole('button', { name: 'Send the invitation' }).click();
  await expect(buyer.getByText(`Invitation sent to ${DIRECTOR}`, { exact: true })).toBeVisible();

  await buyer.getByRole('tab', { name: 'Onboarding' }).click();
  await expect(buyer.getByRole('row', { name: new RegExp(DIRECTOR) })).toContainText('Sent');
  await expectAxe(buyer, 'onboarding invitations');
});

test('the director onboards from the emailed link and publishes a passport', async () => {
  await supplier.goto(`/onboard#token=${await mailToken(DIRECTOR, 'vendor_invite')}`);
  await expect(supplier.getByRole('heading', { name: /Supplier onboarding for E2E Supplier Side Buyers/ })).toBeVisible();
  await expect(supplier).toHaveURL(/\/onboard$/); // the token left the address bar
  await expectAxe(supplier, 'onboarding: agree');

  await supplier.getByRole('button', { name: 'Agree and continue' }).click();
  await expect(supplier.getByRole('alert').filter({ hasText: 'Check the form' })).toBeVisible();
  await expectAxe(supplier, 'onboarding: agree with errors');
  await supplier.getByLabel('Your full name').fill('Thandi Mokoena');
  await supplier.getByLabel(/Your role at the company/).fill('Director');
  await supplier.getByRole('checkbox', { name: /I agree, on behalf of/ }).check();
  await supplier.getByRole('button', { name: 'Agree and continue' }).click();

  await expect(supplier.getByRole('heading', { name: 'Is this your company?' })).toBeVisible();
  await expect(supplier.getByText('THANDI MOKOENA')).toBeVisible();
  await expectAxe(supplier, 'onboarding: company');
  await supplier.getByRole('button', { name: 'Yes, this is my company' }).click();

  await expect(supplier.getByRole('heading', { name: 'Your identity document' })).toBeVisible();
  await supplier.getByRole('radio', { name: 'Smart ID card of a director' }).check();
  await expectAxe(supplier, 'onboarding: identity');
  await supplier.getByRole('button', { name: 'Add the document' }).click();

  await expect(supplier.getByRole('heading', { name: 'B-BBEE evidence' })).toBeVisible();
  await supplier.getByRole('radio', { name: 'EME affidavit, 100% black-owned' }).check();
  await supplier.getByRole('button', { name: 'Add the document' }).click();

  await expect(supplier.getByRole('heading', { name: 'Bank details' })).toBeVisible();
  await supplier.getByRole('combobox', { name: 'Bank' }).click();
  await supplier.getByRole('option', { name: 'Capitec' }).click();
  await supplier.getByLabel('Account number').fill('1400123456');
  await expectAxe(supplier, 'onboarding: bank');
  await supplier.getByRole('button', { name: 'Add bank details' }).click();

  await expect(supplier.getByRole('heading', { name: 'Tax compliance' })).toBeVisible();
  await supplier.getByLabel('Income tax reference number').fill('9123456789');
  await supplier.getByLabel('Tax compliance status PIN').fill('AB12CD34EF');
  await supplier.getByRole('button', { name: 'Check with SARS' }).click();

  await expect(supplier.getByRole('heading', { name: 'Check and submit' })).toBeVisible();
  await expect(supplier.getByText('Tax compliant')).toBeVisible();
  await expect(supplier.getByRole('checkbox', { name: 'Publish a Verified Vendor Passport' })).toBeChecked();
  await expectAxe(supplier, 'onboarding: review');
  await supplier.getByRole('button', { name: /^Submit to E2E Supplier Side Buyers/ }).click();
  await expect(supplier.getByRole('heading', { name: 'Submitted' })).toBeVisible();
  await expectAxe(supplier, 'onboarding: submitted');

  // The buyer sees it arrive, under the name the register gave.
  await buyer.reload();
  await expect(buyer.getByRole('heading', { name: COMPANY, level: 1 })).toBeVisible();
  await buyer.getByRole('tab', { name: 'Onboarding' }).click();
  await expect(buyer.getByRole('row', { name: new RegExp(DIRECTOR) })).toContainText('Submitted');
});

test('the director signs in to self-service with an emailed link', async () => {
  await supplier.goto('/supplier');
  await expect(supplier).toHaveURL(/\/supplier\/sign-in$/); // no supplier session yet
  await expectAxe(supplier, 'supplier sign-in');
  await supplier.getByLabel('Email address').fill(DIRECTOR);
  await supplier.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(supplier.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await supplier.goto(`/supplier/sign-in#token=${await mailToken(DIRECTOR, 'vendor_login')}`);
  await expect(supplier).toHaveURL(/\/supplier$/);
  await expect(supplier.getByRole('heading', { name: COMPANY, level: 1 })).toBeVisible();
  await expect(supplier.getByText('Published', { exact: true })).toBeVisible();
  await expect(supplier.getByRole('row', { name: /E2E Supplier Side Buyers/ })).toBeVisible();
  await expectAxe(supplier, 'supplier self-service');
});

test('the public passport shows the verified facts and a code for paper copies', async () => {
  await supplier.getByRole('link', { name: 'Open your passport' }).click();
  await expect(supplier).toHaveURL(/\/passport\/[0-9a-f]{24}$/);
  passportPath = new URL(supplier.url()).pathname;
  await expect(supplier.getByRole('heading', { name: COMPANY, level: 1 })).toBeVisible();
  await expect(supplier.getByText('Tax compliant')).toBeVisible();
  await expect(supplier.getByText('Level 1 contributor')).toBeVisible();
  await expect(supplier.getByRole('img', { name: 'QR code that opens this passport' })).toBeVisible();
  code = (await supplier.getByText(/^([0-9A-F]{4} ){10}[0-9A-F]{4}$/).textContent())!;
  await expectAxe(supplier, 'public passport');

  // Printed, the page keeps the passport and the sandbox band, and drops the site chrome.
  await supplier.emulateMedia({ media: 'print' });
  await expect(supplier.getByRole('navigation', { name: 'Site' })).toBeHidden();
  await expect(supplier.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
  await expect(supplier.getByRole('heading', { name: COMPANY, level: 1 })).toBeVisible();
  await supplier.emulateMedia({ media: 'screen' });
});

test('anyone can check a printed code', async () => {
  // A visitor with no session at all.
  const anonContext = await supplierContext.browser()!.newContext();
  const anon = await anonContext.newPage();
  await anon.goto('/verify-passport');
  await expectAxe(anon, 'verify passport');
  await anon.getByLabel('Verification code').fill(code);
  await anon.getByRole('button', { name: 'Check the code' }).click();
  await expect(anon.getByText('Genuine and current')).toBeVisible();
  await expectAxe(anon, 'verify passport: genuine');

  const forged = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
  await anon.getByLabel('Verification code').fill(forged);
  await anon.getByRole('button', { name: 'Check the code' }).click();
  await expect(anon.getByText('TshepoVet did not issue this code')).toBeVisible();
  await anonContext.close();
});

test('the director withdraws the passport', async () => {
  await supplier.goto('/supplier');
  await supplier.getByRole('button', { name: 'Withdraw the passport' }).click();
  const confirm = supplier.getByRole('alertdialog', { name: 'Withdraw your passport?' });
  await expectAxe(supplier, 'withdraw confirmation');
  await confirm.getByRole('button', { name: 'Withdraw the passport' }).click();
  await expect(supplier.getByText('Passport withdrawn', { exact: true })).toBeVisible();
  await expect(supplier.getByRole('button', { name: 'Publish the passport' })).toBeVisible();

  await supplier.goto(passportPath);
  await expect(supplier.getByRole('heading', { name: 'This passport was withdrawn', level: 1 })).toBeVisible();
  await expectAxe(supplier, 'withdrawn passport');

  await supplier.goto('/verify-passport');
  await supplier.getByLabel('Verification code').fill(code);
  await supplier.getByRole('button', { name: 'Check the code' }).click();
  await expect(supplier.getByText('Genuine, but the passport was withdrawn')).toBeVisible();
});
