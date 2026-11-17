#!/usr/bin/env node
/**
 * The design reference: the owner edits the design system and the page map in dashboard.html
 * (kept out of git); this tool carries them into the repository and back.
 *
 *   node tools/design-sync.mjs pull    dashboard.html -> design/tokens.json, design/pages.json,
 *                                      apps/web/app/tokens.css (refused if a pair fails WCAG AAA)
 *   node tools/design-sync.mjs push    design/*.json -> the dashboard's embedded state
 *   node tools/design-sync.mjs css     design/tokens.json -> apps/web/app/tokens.css (after a
 *                                      hand edit of tokens.json)
 *   node tools/design-sync.mjs check   fails when the app drifts from design/*.json: tokens.css
 *                                      not generated from tokens.json, a contrast pair under its
 *                                      minimum, the wrong font loaded, or a page added to or
 *                                      removed from the app without the page map
 *
 * Options: --dashboard <path> (default ./dashboard.html). No dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = path.join(ROOT, 'design', 'tokens.json');
const PAGES = path.join(ROOT, 'design', 'pages.json');
const CSS = path.join(ROOT, 'apps', 'web', 'app', 'tokens.css');
const APP_DIR = path.join(ROOT, 'apps', 'web', 'app');
const LAYOUT = path.join(APP_DIR, 'layout.tsx');

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : fallback;
};
const DASHBOARD = opt('--dashboard', path.join(ROOT, 'dashboard.html'));

// --- reading and writing ---------------------------------------------------------------------

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

const STATE_RE = /(<script id="dashboard-state" type="application\/json">)([\s\S]*?)(<\/script>)/;

function readDashboard() {
  if (!fs.existsSync(DASHBOARD)) throw new Error(`No dashboard at ${DASHBOARD}.`);
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  const m = STATE_RE.exec(html);
  if (!m) throw new Error('The dashboard has no embedded state (<script id="dashboard-state">).');
  const state = JSON.parse(m[2]);
  if (state.version !== 2) throw new Error(`Dashboard state version ${state.version}; expected 2.`);
  return { html, state };
}

function writeDashboard(html, state) {
  // The same escaping the dashboard's own "Download updated HTML" uses: no "<" inside the script.
  const json = JSON.stringify(state, null, 2).replace(/</g, '\\u003c');
  fs.writeFileSync(DASHBOARD, html.replace(STATE_RE, (_, open, _body, close) => `${open}\n${json}\n${close}`));
}

// --- validation ------------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
const TOKEN = /^[a-z][a-z0-9-]*$/;

function validateTokens(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['tokens: not an object'];
  if (!Array.isArray(t.colors) || !t.colors.length) errors.push('tokens.colors: empty');
  const names = new Set();
  for (const c of t.colors ?? []) {
    if (!TOKEN.test(c.token ?? '')) errors.push(`colour "${c.token}": the name must be lower-case letters, digits and hyphens`);
    if (names.has(c.token)) errors.push(`colour "${c.token}" appears twice`);
    names.add(c.token);
    for (const theme of ['light', 'dark']) if (!HEX.test(c[theme] ?? '')) errors.push(`colour "${c.token}" ${theme}: "${c[theme]}" is not a #rrggbb value`);
  }
  for (const p of t.contrast ?? []) {
    if (!names.has(p.fg) || !names.has(p.bg)) errors.push(`contrast pair ${p.fg} on ${p.bg}: unknown colour`);
    if (!(p.min >= 1)) errors.push(`contrast pair ${p.fg} on ${p.bg}: no minimum`);
  }
  const ty = t.type ?? {};
  if (!ty.sans || !ty.mono) errors.push('type: the sans and mono families are required');
  for (const s of ty.scale ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.step ?? '')) errors.push(`type step "${s.step}": bad name`);
    if (!(s.rem > 0 && s.rem < 10)) errors.push(`type step "${s.step}": size ${s.rem}rem is out of range`);
    if (!(s.lineHeight >= 1 && s.lineHeight <= 3)) errors.push(`type step "${s.step}": line height ${s.lineHeight} is out of range`);
  }
  for (const [k, v] of Object.entries(t.radii ?? {})) {
    if (!TOKEN.test(k) || !(v >= 0 && v <= 64)) errors.push(`radius "${k}": ${v}px is out of range`);
  }
  for (const theme of ['light', 'dark']) if (typeof t.shadow?.[theme] !== 'string' || /[;{}]/.test(t.shadow[theme])) errors.push(`shadow.${theme}: a single CSS box-shadow value is required`);
  return errors;
}

function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function contrastFailures(t) {
  const byName = Object.fromEntries(t.colors.map((c) => [c.token, c]));
  const out = [];
  for (const p of t.contrast ?? []) {
    for (const theme of ['light', 'dark']) {
      const r = contrast(byName[p.fg][theme], byName[p.bg][theme]);
      if (r + 1e-9 < p.min) out.push(`${theme}: ${p.fg} on ${p.bg} is ${r.toFixed(2)}:1, under ${p.min}:1 (${p.use ?? 'text'})`);
    }
  }
  return out;
}

const SHELLS = ['public', 'auth', 'portal', 'supplier', 'staff', 'staff-auth', 'bare'];
const STATUSES = ['built', 'planned'];

function validatePages(p) {
  const errors = [];
  if (!p || !Array.isArray(p.pages) || !Array.isArray(p.shells)) return ['pages: { shells: [], pages: [] } expected'];
  const routes = new Set();
  for (const s of p.shells) if (!SHELLS.includes(s.id)) errors.push(`shell "${s.id}": unknown id`);
  for (const pg of p.pages) {
    if (typeof pg.route !== 'string' || !pg.route.startsWith('/')) errors.push(`page "${pg.name}": the route must start with /`);
    if (routes.has(pg.route)) errors.push(`page ${pg.route} appears twice`);
    routes.add(pg.route);
    if (!SHELLS.includes(pg.shell)) errors.push(`page ${pg.route}: unknown shell "${pg.shell}"`);
    if (!STATUSES.includes(pg.status)) errors.push(`page ${pg.route}: status must be built or planned`);
    if (!Array.isArray(pg.regions)) errors.push(`page ${pg.route}: regions must be a list`);
  }
  return errors;
}

// --- generation ------------------------------------------------------------------------------

function colourBlock(t, theme, indent) {
  const lines = t.colors.map((c) => `${indent}--${c.token}: ${c[theme].toLowerCase()};${c.role ? ` /* ${c.role.replace(/\*\//g, '')} */` : ''}`);
  lines.push(`${indent}--shadow: ${t.shadow[theme]};`, `${indent}color-scheme: ${theme};`);
  return lines.join('\n');
}

export function generateCss(t) {
  const theme = [
    ...t.colors.map((c) => `  --color-${c.token}: var(--${c.token});`),
    '',
    ...t.type.scale.flatMap((s) => [`  --text-${s.step}: ${s.rem}rem;`, `  --text-${s.step}--line-height: ${s.lineHeight};`]),
    '',
    ...Object.entries(t.radii).map(([k, v]) => `  --radius-${k}: ${v}px;`),
    '',
    '  --shadow-sheet: var(--shadow);',
  ];
  return `/*
 * GENERATED by tools/design-sync.mjs from design/tokens.json: do not edit this file.
 * Change the design in the dashboard's Design system tab (or design/tokens.json), then run
 * \`npm run design:pull\` (or \`node tools/design-sync.mjs pull\`). \`npm run design:check\` fails
 * when this file and design/tokens.json disagree.
 *
 * ${t.name}. Themes: data-theme="light" | "dark" on <html>, else the system preference.
 */

:root {
${colourBlock(t, 'light', '  ')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${colourBlock(t, 'dark', '    ')}
  }
}

:root[data-theme='dark'] {
${colourBlock(t, 'dark', '  ')}
}

/* Paper is light whatever the screen theme: the light tokens again, specific enough to win. */
@media print {
  :root:root:root {
${colourBlock(t, 'light', '    ')}
  }
}

@theme inline {
${theme.join('\n')}
}
`;
}

// --- the app's pages -------------------------------------------------------------------------

export function appRoutes(dir = APP_DIR) {
  const routes = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'page.tsx') {
        const segs = path.relative(dir, d).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s));
        routes.push('/' + segs.join('/'));
      }
    }
  };
  walk(dir);
  return routes.sort();
}

// --- commands --------------------------------------------------------------------------------

function fail(title, lines) {
  console.error(`${title}\n${lines.map((l) => `  - ${l}`).join('\n')}`);
  process.exit(1);
}

function pull() {
  const { state } = readDashboard();
  if (!state.design || !state.pages) throw new Error('The dashboard state has no design or pages yet: run push first.');
  const errors = [...validateTokens(state.design), ...validatePages(state.pages)];
  if (errors.length) fail('The dashboard\'s design data is not valid; nothing was written:', errors);
  const low = contrastFailures(state.design);
  if (low.length) fail('The dashboard\'s colours break the AAA floor; nothing was written. Change these in the Design system tab:', low);
  writeJson(TOKENS, state.design);
  writeJson(PAGES, state.pages);
  fs.writeFileSync(CSS, generateCss(state.design));
  console.log(`pulled: ${path.relative(ROOT, TOKENS)}, ${path.relative(ROOT, PAGES)}, ${path.relative(ROOT, CSS)}`);
  check({ quiet: true });
}

function push() {
  const tokens = readJson(TOKENS);
  const pages = readJson(PAGES);
  const errors = [...validateTokens(tokens), ...validatePages(pages)];
  if (errors.length) fail('design/*.json is not valid; the dashboard was not changed:', errors);
  const { html, state } = readDashboard();
  state.design = tokens;
  state.pages = pages;
  state.updatedAt = new Date().toISOString();
  writeDashboard(html, state);
  console.log(`pushed design/tokens.json and design/pages.json into ${path.relative(ROOT, DASHBOARD) || DASHBOARD}`);
}

function check({ quiet = false } = {}) {
  const problems = [];
  const notes = [];
  const tokens = readJson(TOKENS);
  const pages = readJson(PAGES);
  problems.push(...validateTokens(tokens), ...validatePages(pages));
  if (!problems.length) {
    problems.push(...contrastFailures(tokens).map((l) => `contrast: ${l}`));
    const css = fs.existsSync(CSS) ? fs.readFileSync(CSS, 'utf8') : '';
    if (css !== generateCss(tokens)) problems.push('apps/web/app/tokens.css was not generated from design/tokens.json (run `npm run design:pull`, or regenerate after editing tokens.json)');

    // The fonts are loaded by next/font in the root layout, so a family change is a code change.
    const layout = fs.readFileSync(LAYOUT, 'utf8');
    for (const family of [tokens.type.sans, tokens.type.mono]) {
      const ident = family.replace(/\s+/g, '_');
      if (!new RegExp(`\\b${ident}\\b`).test(layout)) problems.push(`font: design/tokens.json names "${family}", but apps/web/app/layout.tsx does not load ${ident} from next/font/google`);
    }

    const app = new Set(appRoutes());
    const built = new Set(pages.pages.filter((p) => p.status === 'built').map((p) => p.route));
    for (const r of app) if (!built.has(r)) problems.push(`pages: the app has ${r}, but design/pages.json does not list it as built`);
    for (const r of built) if (!app.has(r)) problems.push(`pages: design/pages.json lists ${r} as built, but the app has no such page`);
    for (const p of pages.pages) {
      if (p.status === 'planned') notes.push(`planned page, not built yet: ${p.route} (${p.name})`);
      if (p.notes && p.notes.trim()) notes.push(`owner note on ${p.route}: ${p.notes.trim()}`);
    }
  }

  if (fs.existsSync(DASHBOARD)) {
    try {
      const { state } = readDashboard();
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (!same(state.design, tokens)) notes.push('the dashboard\'s design differs from design/tokens.json (pull to take the dashboard\'s, push to take the repository\'s)');
      if (!same(state.pages, pages)) notes.push('the dashboard\'s page map differs from design/pages.json (pull or push)');
    } catch (err) {
      notes.push(`dashboard not read: ${err.message}`);
    }
  }

  if (notes.length && !quiet) console.log(notes.map((n) => `note: ${n}`).join('\n'));
  if (problems.length) fail('design check failed:', problems);
  if (!quiet) console.log(`design check passed: ${tokens.colors.length} colours, ${(tokens.contrast ?? []).length} contrast pairs in two themes, ${pages.pages.length} pages`);
}

function css() {
  const tokens = readJson(TOKENS);
  const errors = validateTokens(tokens);
  if (errors.length) fail('design/tokens.json is not valid:', errors);
  const low = contrastFailures(tokens);
  if (low.length) fail('design/tokens.json breaks the AAA floor; tokens.css was not written:', low);
  fs.writeFileSync(CSS, generateCss(tokens));
  console.log(`wrote ${path.relative(ROOT, CSS)}`);
}

const commands = { pull, push, check, css };
if (!commands[command]) {
  console.error('usage: node tools/design-sync.mjs pull|push|check|css [--dashboard <path>]');
  process.exit(2);
}
try {
  commands[command]();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
