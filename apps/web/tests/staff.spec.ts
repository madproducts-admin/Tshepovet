import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { hashPassword } from '../../../packages/core/src/auth/password';
import { totpCode, totpStep } from '../../../packages/core/src/auth/totp';
import { expectAxe } from './axe';

/**
 * The staff console in the browser, against the e2e API and worker (deploy/app/run-web-e2e.ps1):
 * sign-in with mandatory two-step enrolment, every page under axe at AAA, a review decision,
 * the audited tenant view, the mail reader, and the WhatsApp simulator answered by the real bot.
 */
test.describe.configure({ mode: 'serial' });

const stamp = Date.now();
const EMAIL = `ops-${stamp}@tshepovet.example`;
const PW = 'correct horse battery 42';
const TENANT = `E2E Staff Console Buyers ${stamp} (Pty) Ltd`;
let context: BrowserContext;
let page: Page;
let tenantId = '';
let documentId = '';

async function db<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

test.beforeAll(async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop' || !process.env.TEST_OWNER_DATABASE_URL, 'staff flows run once, against the e2e API');
  // Staff accounts are made by a script on the box, never through the API.
  await db(`INSERT INTO staff_users (email, full_name, role, password_hash) VALUES ($1, 'Naledi Ops', 'admin', $2)`, [EMAIL, await hashPassword(PW)]);
  tenantId = (await db<{ id: string }>(`INSERT INTO tenants (legal_name) VALUES ($1) RETURNING id`, [TENANT]))[0]!.id;
  const vendor = (await db<{ id: string }>(`INSERT INTO vendors (legal_name, entity_kind) VALUES ('E2E REVIEW SUPPLIER (PTY) LTD', 'other') RETURNING id`))[0]!.id;
  documentId = (
    await db<{ id: string }>(
      `INSERT INTO vendor_documents (vendor_id, tenant_id, document_type, sha256, mime_type, size_bytes, source_channel, review_status, review_flags,
                                     image_purge_after, record_purge_after)
       VALUES ($1, $2, 'sa_smart_id_card', '\\x01', 'image/jpeg', 10, 'portal', 'needs_review', '{not_listed_director}', now() + interval '30 days', now() + interval '5 years')
       RETURNING id`,
      [vendor, tenantId],
    )
  )[0]!.id;
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context?.close();
});

test('signs in and must set up two-step verification first', async () => {
  await page.goto('/staff');
  await expect(page).toHaveURL(/\/staff\/sign-in$/);
  await expectAxe(page, 'staff sign-in');
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expectAxe(page, 'staff enrolment');
  const key = (await page.getByText(/^Setup key:/).textContent())!.replace('Setup key:', '').replace(/\s/g, '');
  await page.getByLabel('6-digit code').fill(totpCode(key, totpStep()));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByRole('heading', { name: 'Staff console', level: 1 })).toBeVisible();
  await expectAxe(page, 'staff overview');
});

test('decides a document in the review queue', async () => {
  await page.getByRole('navigation', { name: 'Staff console' }).getByRole('link', { name: 'Review queue' }).click();
  const row = page.getByRole('row', { name: /E2E REVIEW SUPPLIER/ });
  await expect(row).toContainText('Not a director on the register');
  await expectAxe(page, 'review queue');
  await row.getByRole('button', { name: /^Decide/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Record the decision' }).click();
  await expect(dialog.getByText('Say why: the buyer sees it')).toBeVisible();
  await expectAxe(page, 'review decision with an error');
  await dialog.getByRole('radio', { name: 'Reject it' }).check();
  await dialog.getByLabel('Reason').fill('The photo is of a different card.');
  await dialog.getByRole('button', { name: 'Record the decision' }).click();
  await expect(page.getByText('Document rejected', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E REVIEW SUPPLIER/ })).toHaveCount(0);
  expect((await db<{ review_status: string }>(`SELECT review_status FROM vendor_documents WHERE id = $1`, [documentId]))[0]!.review_status).toBe('rejected');
});

test('opens a tenant, which is recorded, and verifies its audit chain', async () => {
  await page.goto('/staff/tenants');
  await page.getByLabel('Search by name').fill(`Staff Console Buyers ${stamp}`);
  await expect(page.getByRole('row')).toHaveCount(2);
  await expectAxe(page, 'tenants');
  await page.getByRole('link', { name: TENANT }).click();
  await expect(page.getByRole('heading', { name: TENANT, level: 1 })).toBeVisible();
  await expect(page.getByText('This view is on the tenant’s record')).toBeVisible();
  await page.getByRole('button', { name: 'Verify the audit chain' }).click();
  await expect(page.getByText(/The audit chain is intact/)).toBeVisible();
  await expectAxe(page, 'tenant detail');
  const views = await db(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'staff.support_view'`, [tenantId]);
  expect(views.length).toBeGreaterThanOrEqual(1);
});

test('reads the sandbox mail outbox', async () => {
  await page.goto('/staff/mail');
  await expect(page.getByRole('heading', { name: 'Mail outbox', level: 1 })).toBeVisible();
  await expectAxe(page, 'mail outbox');
});

test('plays the supplier in the WhatsApp simulator, and the real bot answers', async () => {
  await page.goto('/staff/whatsapp');
  await page.getByRole('combobox', { name: 'Inviting buyer' }).click();
  await page.getByRole('option', { name: TENANT }).click();
  const number = `2782${String(stamp).slice(-7)}`;
  await page.getByLabel('Supplier’s mobile number').fill(number);
  await page.getByRole('button', { name: 'Send the invitation' }).click();
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText(`${TENANT} uses TshepoVet`);
  await expectAxe(page, 'whatsapp simulator');
  await page.getByLabel('Message').fill('Hi');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(log.getByText('Hi', { exact: true })).toBeVisible();
  // The worker's conversation bot replies through the sandbox Graph client.
  await expect(log.locator('li').nth(2)).toBeVisible({ timeout: 30_000 });
  await expectAxe(page, 'whatsapp simulator with replies');
});

test('collapses the sidebar to a rail and back (Q1)', async () => {
  await page.goto('/staff');
  const aside = page.locator('aside:has(#staff-nav)');
  await aside.getByRole('button', { name: 'Collapse menu' }).click();
  await expect(aside.getByRole('button', { name: 'Expand menu' })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThan(120);
  await expect(aside.getByRole('link', { name: 'Review queue' })).toBeVisible();
  await expect(aside.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expectAxe(page, 'collapsed staff sidebar');
  await aside.getByRole('button', { name: 'Expand menu' }).click();
  await expect(aside.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
  await expect(aside.getByText('Staff console')).toBeVisible();
});

test('shows bureaus, prices and purge runs to an admin', async () => {
  await page.goto('/staff/bureaus');
  await expect(page.getByRole('heading', { name: 'Price book' })).toBeVisible();
  await expectAxe(page, 'bureaus and prices');
  await page.getByRole('button', { name: 'Set a new price' }).click();
  await expect(page.getByRole('dialog', { name: 'Set a new price' })).toBeVisible();
  await expectAxe(page, 'new price dialog');
  await page.keyboard.press('Escape');
  await page.goto('/staff/purge');
  await expect(page.getByRole('heading', { name: 'Purge runs', level: 1 })).toBeVisible();
  await expectAxe(page, 'purge runs');
  await page.goto('/staff/requests');
  await expectAxe(page, 'data requests');
});
