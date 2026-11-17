import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * WCAG 2.2 AAA, as far as a machine can check it: axe with the AAA rules (enhanced contrast
 * among them) in both themes, with the overlays open; plus the AAA rules axe does not cover,
 * checked directly: 44-pixel targets (2.5.5), a visible focus ring (2.4.13), reflow without
 * sideways scrolling (1.4.10), and a skip link.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa', 'wcag22a', 'wcag22aa', 'best-practice'];

async function axe(page: Page, label: string, only?: string) {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  // A listbox popup hides the page behind it on purpose (like a native select): audit the popup.
  if (only) builder.include(only);
  const r = await builder.analyze();
  const summary = r.violations.map((v) => ({ rule: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
  expect(summary, `${label}: ${JSON.stringify(summary, null, 1)}`).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`design system, ${theme} theme`, () => {
    test.beforeEach(async ({ context, baseURL }) => {
      await context.addCookies([{ name: 'tv_theme', value: theme, url: baseURL! }]);
    });

    test('passes axe at AAA', async ({ page }) => {
      await page.goto('/design-system');
      await page.waitForLoadState('networkidle');
      await axe(page, 'page');
    });

    test('passes axe with errors shown and overlays open', async ({ page }) => {
      await page.goto('/design-system');
      await page.getByRole('button', { name: 'Check the form' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Check the form' })).toBeVisible();
      await axe(page, 'form errors');

      await page.getByRole('button', { name: 'Open a dialog' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await axe(page, 'dialog');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'More actions' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await axe(page, 'menu');
      await page.keyboard.press('Escape');

      await page.getByRole('combobox', { name: 'Entity type' }).click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await axe(page, 'select', '[role="listbox"]');
    });
  });
}

// The public pages a visitor meets first, in both themes (the API may be absent: they fall back).
const PUBLIC_PAGES: Array<[string, string]> = [
  ['/', 'landing'],
  ['/pricing', 'pricing'],
  ['/verify-passport', 'verify passport'],
  ['/supplier/sign-in', 'supplier sign-in'],
  ['/legal/terms', 'terms of use'],
];
for (const theme of ['light', 'dark'] as const) {
  test(`public pages pass axe at AAA, ${theme} theme`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'tv_theme', value: theme, url: baseURL! }]);
    for (const [path, label] of PUBLIC_PAGES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await axe(page, `${label} (${theme})`);
    }
  });
}

// ECTA s43, in the owner's words: "MAD Products (Pty) Ltd t/a TshepoVet | Reg No: [CIPC Number] |
// VAT No: [SARS VAT Number] | [Physical Address]". The expected line comes from /api/meta, so the
// test holds on the test API (no details: the placeholders) and on the live site (the real ones);
// with no VAT number the operator is not a VAT vendor ("We are not VAT registered yet").
test('the footers and the terms say who runs TshepoVet (ECTA s43)', async ({ page, request }) => {
  const meta = (await (await request.get('/api/meta')).json()) as {
    vat_registered: boolean;
    seller: { legal_name: string; trading_name: string; registration_number: string | null; vat_number: string | null; address: string | null; directors: string[] };
  };
  const s = meta.seller;
  const lit = (v: string) => v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const vatPart = s.vat_number ? `VAT No \\(Value-added tax registration number\\): ${lit(s.vat_number)}` : 'Not registered for VAT \\(Value-added tax\\)';
  const line = new RegExp(
    `^${lit(s.legal_name)} t\\/a \\(trading as\\) ${lit(s.trading_name)}\\s*\\|\\s*Reg No \\(Company registration number\\): ${lit(s.registration_number ?? '[CIPC Number]')}\\s*\\|\\s*${vatPart}\\s*\\|\\s*${lit(s.address ?? '[Physical Address]')}$`,
  );
  for (const path of ['/', '/pricing', '/sign-in', '/supplier/sign-in']) {
    await page.goto(path);
    await expect(page.locator('footer address'), path).toHaveText(line);
  }
  await page.goto('/legal/terms');
  await expect(page.getByRole('heading', { level: 2, name: 'Who we are' })).toBeVisible();
  await expect(page.locator('main address')).toHaveText(line);
  // The rest of s43: legal status, the address for legal notices, directors, contact, website.
  const details = page.locator('main dl');
  const director = s.directors.length === 1 ? 'Director' : 'Directors';
  for (const term of ['Registered name', 'Registration number', 'Registered office, also for legal notices', director, 'Value-added tax', 'Email', 'Telephone', 'Website']) {
    await expect(details.getByRole('term').filter({ hasText: new RegExp(`^${term}$`) }), term).toHaveCount(1);
  }
  if (!meta.vat_registered) {
    await expect(details).toContainText('Not registered, so none is charged');
    await expect(page.getByText(/not registered for VAT, so no VAT is added/)).toBeVisible();
    await page.goto('/pricing');
    await expect(page.getByText(/not registered for VAT, so you pay the prices shown/)).toBeVisible();
  }
});

test('public pages reflow at 320 CSS pixels (WCAG 1.4.10)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const [path, label] of PUBLIC_PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(wide, `${label} scrolls sideways at 320px`).toBe(false);
  }
});

test('every target is at least 44 by 44 pixels (WCAG 2.5.5)', async ({ page }) => {
  await page.goto('/design-system');
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const inText = (el: Element) => Boolean(el.closest('p, li > p, dd, td') && getComputedStyle(el).display === 'inline');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, [role="combobox"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"]'))) {
      if (el.offsetParent === null || el.closest('.sr-only') || el.classList.contains('sr-only')) continue;
      if (el.tagName === 'A' && inText(el)) continue; // inline links in a sentence are exempt
      const target = el.closest('label') ?? el; // a control's label row is its target
      const r = target.getBoundingClientRect();
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  expect(small).toEqual([]);
});

test('the skip link comes first and focus is always visible (WCAG 2.4.1, 2.4.13)', async ({ page }) => {
  await page.goto('/design-system');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const host = el.closest('label');
      const hostStyle = host ? getComputedStyle(host) : null;
      return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, host: hostStyle ? parseFloat(hostStyle.outlineWidth) : 0 };
    });
    if (!outline) continue;
    expect(Math.max(outline.width, outline.host), JSON.stringify(outline)).toBeGreaterThanOrEqual(2);
  }
});

test('reflows at 320 CSS pixels without sideways scrolling (WCAG 1.4.10)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/design-system');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
