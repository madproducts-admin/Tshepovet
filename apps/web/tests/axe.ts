import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** axe with the AAA rules; `only` scopes it to a popup that deliberately hides the page. */
export const AAA_TAGS = ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa', 'wcag22a', 'wcag22aa', 'best-practice'];

export async function expectAxe(page: Page, label: string, only?: string) {
  const builder = new AxeBuilder({ page }).withTags(AAA_TAGS);
  if (only) builder.include(only);
  const r = await builder.analyze();
  const summary = r.violations.map((v) => ({ rule: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
  expect(summary, `${label}: ${JSON.stringify(summary, null, 1)}`).toEqual([]);
}
