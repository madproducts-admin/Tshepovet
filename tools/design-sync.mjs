#!/usr/bin/env node
/**
 * The design reference: the owner edits the design system and the page layouts in dashboard.html
 * (kept out of git; its Color Palette & Themes, Typography & Font Scaling, Layout & Structure and
 * Brand Assets & Micro-interactions tabs). An edit there is a *requested change* until Claude
 * applies it. This tool carries the reference between the dashboard and the repository.
 *
 *   node tools/design-sync.mjs pending          what waits for Claude in the dashboard
 *   node tools/design-sync.mjs pull             dashboard -> design/tokens.json, design/pages.json,
 *                                               apps/web/app/tokens.css (refused if a pair fails AAA)
 *   node tools/design-sync.mjs applied <commit> mark the requested changes applied in the dashboard
 *   node tools/design-sync.mjs declined <change-id> <reason>
 *   node tools/design-sync.mjs handled <id>...  a decision, or a blocker's instructions, acted on
 *   node tools/design-sync.mjs push             design/*.json -> the dashboard (requested changes,
 *                                               uploads and everything else in it are kept)
 *   node tools/design-sync.mjs check            fails when the app drifts from design/*.json
 *   node tools/design-sync.mjs css              design/tokens.json -> tokens.css (after a hand edit)
 *
 * What reaches the app by itself: colours (both themes), the type scale, the interface scale,
 * radii, layout widths and motion timing (the settings that carry a `token`). Fonts, rules, brand
 * text, components, page layouts and uploaded files Claude changes in the code.
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
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--dashboard');
const DASHBOARD = opt('--dashboard', path.join(ROOT, 'dashboard.html'));

// --- reading and writing ---------------------------------------------------------------------

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const STATE_RE = /(<script id="dashboard-state" type="application\/json">)\s*([\s\S]*?)\s*(<\/script>)/;
const RAW_RE = /(<textarea id="raw-data"[^>]*>)([\s\S]*?)(<\/textarea>)/;
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function readDashboard() {
  if (!fs.existsSync(DASHBOARD)) throw new Error(`No dashboard at ${DASHBOARD}.`);
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  const m = STATE_RE.exec(html);
  if (!m) throw new Error('The dashboard has no embedded state (<script id="dashboard-state">).');
  const state = JSON.parse(m[2]);
  if (state.version !== 2) throw new Error(`Dashboard state version ${state.version}; expected 2.`);
  return { html, state };
}

/** Writes the state back the way the dashboard's own Save to disk does (state and raw copy). */
function writeDashboard(html, state) {
  state.updatedAt = new Date().toISOString();
  const json = JSON.stringify(state, null, 2);
  let out = html.replace(STATE_RE, (_, open, _b, close) => `${open}\n${json.replace(/</g, '\\u003c')}\n${close}`);
  out = out.replace(RAW_RE, (_, open, _b, close) => `${open}${escapeHtml(json)}${close}`);
  fs.writeFileSync(DASHBOARD, out);
}

const stripChanges = ({ changes: _c, ...rest }) => rest;

// --- validation ------------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const TOKEN_KIND = {
  length: /^\d+(\.\d+)?(px|rem)$/,
  duration: /^\d+(\.\d+)?ms$/,
  easing: /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\))$/,
  percent: /^\d+(\.\d+)?%$/,
};

export function validateTokens(t) {
  const errors = [];
  if (!t || t.version !== 2) return ['design/tokens.json: version 2 expected'];
  const ids = new Set();
  for (const c of t.colors ?? []) {
    if (!ID.test(c.id ?? '')) errors.push(`colour "${c.id}": the name must be lower-case letters, digits and hyphens`);
    if (ids.has(c.id)) errors.push(`colour "${c.id}" appears twice`);
    ids.add(c.id);
    for (const theme of ['light', 'dark']) if (!HEX.test(String(c[theme] ?? '').toLowerCase())) errors.push(`colour "${c.id}" ${theme}: "${c[theme]}" is not a #rrggbb value`);
  }
  if (!ids.size) errors.push('no colours');
  for (const p of t.contrast ?? []) {
    if (!ids.has(p.fg) || !ids.has(p.bg)) errors.push(`contrast pair ${p.fg} on ${p.bg}: unknown colour`);
    if (!(p.min >= 1)) errors.push(`contrast pair ${p.fg} on ${p.bg}: no minimum`);
  }
  for (const id of ['font-sans', 'font-mono']) if (!(t.typography ?? []).some((x) => x.id === id && String(x.value ?? '').trim())) errors.push(`typography: ${id} is required`);
  for (const s of t.scale ?? []) {
    if (!/^text-[a-z0-9]+$/.test(s.id ?? '')) errors.push(`type scale "${s.id}": the name must be text-<step>`);
    const rem = /^(\d+(\.\d+)?)rem$/.exec(String(s.size ?? ''));
    if (!rem || !(Number(rem[1]) > 0 && Number(rem[1]) < 10)) errors.push(`type scale "${s.id}": size "${s.size}" must be in rem, under 10rem`);
    const lh = Number(s.lineHeight);
    if (!(lh >= 1 && lh <= 3)) errors.push(`type scale "${s.id}": line height "${s.lineHeight}" must be a number from 1 to 3`);
  }
  const sids = new Set();
  for (const s of t.settings ?? []) {
    if (!ID.test(s.id ?? '')) errors.push(`setting "${s.id}": bad id`);
    if (sids.has(s.id)) errors.push(`setting "${s.id}" appears twice`);
    sids.add(s.id);
    if (s.token) {
      const re = TOKEN_KIND[s.token.kind];
      if (!re) errors.push(`setting "${s.id}": unknown token kind "${s.token.kind}"`);
      else if (!re.test(String(s.value).trim())) errors.push(`${s.label ?? s.id}: "${s.value}" is not a valid ${s.token.kind} (for example ${{ length: '17rem or 6px', duration: '150ms', easing: 'cubic-bezier(0.4, 0, 0.2, 1)', percent: '100%' }[s.token.kind]})`);
      if (s.token.kind === 'percent') {
        const n = parseFloat(s.value);
        if (!(n >= 75 && n <= 150)) errors.push(`${s.label ?? s.id}: ${s.value} is outside 75% to 150%`);
      }
      if (s.token.css !== 'font-size' && !/^--[a-z][a-z0-9-]*$/.test(s.token.css ?? '')) errors.push(`setting "${s.id}": token.css must be a custom property`);
    }
  }
  for (const theme of ['light', 'dark']) if (typeof t.shadow?.[theme] !== 'string' || /[;{}]/.test(t.shadow[theme])) errors.push(`shadow.${theme}: a single CSS box-shadow value is required`);
  return errors;
}

const SHELLS = ['public', 'auth', 'portal', 'supplier', 'staff', 'staff-auth', 'bare'];
const KINDS = ['header', 'toolbar', 'banner', 'stats', 'card', 'table', 'form', 'chart', 'tabs', 'list', 'dialog', 'empty', 'other'];
const SPANS = ['full', 'main', 'side', 'half', 'third'];

export function validatePages(u) {
  const errors = [];
  if (!u || u.version !== 2 || !Array.isArray(u.pages)) return ['design/pages.json: version 2 with pages expected'];
  const areas = new Set((u.areas ?? []).map((a) => a.slug));
  const ids = new Set();
  const routes = new Set();
  for (const p of u.pages) {
    const name = p.title || p.id;
    if (!ID.test(p.id ?? '')) errors.push(`page "${name}": bad id "${p.id}"`);
    if (ids.has(p.id)) errors.push(`page id ${p.id} appears twice`);
    ids.add(p.id);
    if (typeof p.route !== 'string' || !p.route.startsWith('/')) errors.push(`page "${name}": the route must start with /`);
    if (routes.has(p.route)) errors.push(`page ${p.route} appears twice`);
    routes.add(p.route);
    if (!areas.has(p.area)) errors.push(`page ${p.route}: unknown area "${p.area}"`);
    if (p.shell && !SHELLS.includes(p.shell)) errors.push(`page ${p.route}: unknown shell "${p.shell}"`);
    if (!Array.isArray(p.regions)) errors.push(`page ${p.route}: regions must be a list`);
    for (const r of p.regions ?? []) {
      if (!r.id || !r.name) errors.push(`page ${p.route}: a region needs an id and a name`);
      if (!KINDS.includes(r.kind)) errors.push(`page ${p.route}, region "${r.name}": unknown kind "${r.kind}"`);
      if (!SPANS.includes(r.span)) errors.push(`page ${p.route}, region "${r.name}": unknown width "${r.span}"`);
    }
  }
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
  const byId = Object.fromEntries(t.colors.map((c) => [c.id, c]));
  const out = [];
  for (const p of t.contrast ?? []) {
    for (const theme of ['light', 'dark']) {
      const r = contrast(byId[p.fg][theme].toLowerCase(), byId[p.bg][theme].toLowerCase());
      if (r + 1e-9 < p.min) out.push(`${theme}: ${p.fg} on ${p.bg} is ${r.toFixed(2)}:1, under ${p.min}:1 (${p.use ?? 'text'})`);
    }
  }
  return out;
}

// --- generation ------------------------------------------------------------------------------

const clean = (s) => String(s).replace(/\*\//g, '');
function colourBlock(t, theme, indent) {
  const lines = t.colors.map((c) => `${indent}--${c.id}: ${c[theme].toLowerCase()};${c.usage ? ` /* ${clean(c.usage)} */` : ''}`);
  lines.push(`${indent}--shadow: ${t.shadow[theme]};`, `${indent}color-scheme: ${theme};`);
  return lines.join('\n');
}

export function generateCss(t) {
  const tokens = (t.settings ?? []).filter((s) => s.token);
  const radii = tokens.filter((s) => s.token.css.startsWith('--radius-'));
  const root = tokens.filter((s) => !s.token.css.startsWith('--radius-'));
  const rootLines = root.map((s) => `  ${s.token.css}: ${String(s.value).trim()}; /* ${clean(s.label)} */`);
  const theme = [
    ...t.colors.map((c) => `  --color-${c.id}: var(--${c.id});`),
    '',
    ...t.scale.flatMap((s) => [`  --${s.id}: ${s.size};`, `  --${s.id}--line-height: ${s.lineHeight};`]),
    '',
    ...radii.map((s) => `  ${s.token.css}: ${String(s.value).trim()};`),
    '',
    '  --shadow-sheet: var(--shadow);',
  ];
  return `/*
 * GENERATED by tools/design-sync.mjs from design/tokens.json: do not edit this file.
 * Change the design in the dashboard (its Color Palette & Themes, Typography & Font Scaling and
 * Layout & Structure tabs) or in design/tokens.json, then run \`npm run design:pull\` (or
 * \`npm run design:css\`). \`npm run design:check\` fails when this file and tokens.json disagree.
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

/* The interface scale, layout widths and motion: the same in both themes. */
:root {
${rootLines.join('\n')}
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
  if (!state.design || !state.ui) throw new Error('The dashboard has no design or page layouts yet: run push first.');
  const tokens = stripChanges(state.design);
  const pages = stripChanges(state.ui);
  const errors = [...validateTokens(tokens), ...validatePages(pages)];
  if (errors.length) fail("The dashboard's design data is not valid; nothing was written:", errors);
  const low = contrastFailures(tokens);
  if (low.length) fail("The dashboard's colours break the AAA floor; nothing was written. Decline those changes (declined <id> <reason>) or ask the owner for other colours:", low);
  writeJson(TOKENS, tokens);
  writeJson(PAGES, pages);
  fs.writeFileSync(CSS, generateCss(tokens));
  console.log(`pulled: ${path.relative(ROOT, TOKENS)}, ${path.relative(ROOT, PAGES)}, ${path.relative(ROOT, CSS)}`);
  check({ quiet: true, compareDashboard: false });
}

function push() {
  const tokens = readJson(TOKENS);
  const pages = readJson(PAGES);
  const errors = [...validateTokens(tokens), ...validatePages(pages)];
  if (errors.length) fail('design/*.json is not valid; the dashboard was not changed:', errors);
  const { html, state } = readDashboard();
  state.design = { ...tokens, changes: state.design?.changes ?? [] };
  state.ui = { ...pages, changes: state.ui?.changes ?? [] };
  writeDashboard(html, state);
  console.log(`pushed design/tokens.json and design/pages.json into ${path.relative(ROOT, DASHBOARD) || DASHBOARD} (requested changes and uploads kept)`);
}

function pending() {
  const { state } = readDashboard();
  const out = [];
  for (const area of ['design', 'ui']) {
    for (const c of state[area]?.changes ?? []) if (c.status === 'requested') out.push(`change   ${c.id}: ${c.label}: ${String(c.from).slice(0, 60)} -> ${String(c.to).slice(0, 60)}`);
  }
  for (const p of state.ui?.pages ?? []) if (String(p.request ?? '').trim()) out.push(`request  page ${p.route}: ${p.request}`);
  for (const b of state.blockers ?? []) for (const r of b.replies ?? []) if (r.kind === 'instruction' && !r.handled) out.push(`blocker  ${b.id}: ${r.text}`);
  const decided = new Set((state.decisions ?? []).map((d) => d.id));
  for (const [id, v] of Object.entries(state.answers ?? {})) if (String(v).trim() && !decided.has(id)) out.push(`answer   ${id} typed but not recorded: ${v}`);
  for (const d of state.decisions ?? []) if (!d.handled && !String(d.id).startsWith('d-')) out.push(`decision ${d.id}: ${d.answer}`);
  for (const a of state.assets ?? []) if (a.status !== 'applied') out.push(`upload   ${a.file} (${a.purpose})${a.saved ? '' : ' NOT SAVED to temp/ yet'}: ${a.note ?? ''}`);
  console.log(out.length ? out.join('\n') : 'Nothing waits for Claude.');
}

function markChanges(status, mutate) {
  const { html, state } = readDashboard();
  let n = 0;
  for (const area of ['design', 'ui']) {
    for (const c of state[area]?.changes ?? []) if (c.status === 'requested' && mutate(c)) n++;
  }
  writeDashboard(html, state);
  console.log(`${n} change${n === 1 ? '' : 's'} marked ${status}`);
}

function applied() {
  const commit = positional[0];
  if (!commit) throw new Error('usage: applied <commit>');
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  markChanges('applied', (c) => Object.assign(c, { status: 'applied', appliedIn: commit, appliedAt: at }));
}

// A change's id is "<collection>|<item id>|<field>", as the dashboard records it.
const LISTS = {
  colors: (s) => s.design?.colors, type: (s) => s.design?.typography, scale: (s) => s.design?.scale, settings: (s) => s.design?.settings,
  rules: (s) => s.design?.rules, components: (s) => s.design?.components, pages: (s) => s.ui?.pages,
};
/** Puts an item's value back (a declined change must not stay in the dashboard as if it held). */
function restore(state, changeId, value) {
  const [coll, id, field] = changeId.split('|');
  const list = LISTS[coll]?.(state);
  if (!list) return false;
  if (field === '__page') {
    const i = list.findIndex((x) => x.id === id);
    if (value === '' && i >= 0) list.splice(i, 1);
    return true;
  }
  const item = list.find((x) => x.id === id);
  if (!item) return false;
  if (field === 'regions') item.regions = JSON.parse(value);
  else item[field] = value;
  return true;
}

function declined() {
  const [id, ...reason] = positional;
  if (!id || !reason.length) throw new Error('usage: declined <change-id> <reason>');
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const { html, state } = readDashboard();
  let n = 0;
  for (const area of ['design', 'ui']) {
    for (const c of state[area]?.changes ?? []) {
      if (c.status !== 'requested' || c.id !== id) continue;
      if (!restore(state, c.id, c.from)) throw new Error(`could not put back ${c.id}`);
      Object.assign(c, { status: 'declined', reason: reason.join(' '), appliedAt: at });
      n++;
    }
  }
  if (!n) throw new Error(`no requested change "${id}" (run pending)`);
  writeDashboard(html, state);
  console.log(`declined ${id}; its value is back to what the app has`);
}

/** Marks decisions (by question id) or a blocker's instructions (by blocker id) as acted on. */
function handled() {
  if (!positional.length) throw new Error('usage: handled <decision-or-blocker-id>...');
  const { html, state } = readDashboard();
  const done = [];
  for (const id of positional) {
    const d = (state.decisions ?? []).find((x) => x.id === id);
    const b = (state.blockers ?? []).find((x) => x.id === id);
    if (d) { d.handled = true; done.push(`decision ${id}`); }
    if (b) for (const r of b.replies ?? []) if (r.kind === 'instruction' && !r.handled) { r.handled = true; done.push(`instruction on ${id}`); }
    if (!d && !b) throw new Error(`no decision or blocker "${id}"`);
  }
  writeDashboard(html, state);
  console.log(`marked handled: ${done.join(', ') || 'nothing new'}`);
}

function check({ quiet = false, compareDashboard = true } = {}) {
  const problems = [];
  const notes = [];
  const tokens = readJson(TOKENS);
  const pages = readJson(PAGES);
  problems.push(...validateTokens(tokens), ...validatePages(pages));
  if (!problems.length) {
    problems.push(...contrastFailures(tokens).map((l) => `contrast: ${l}`));
    const css = fs.existsSync(CSS) ? fs.readFileSync(CSS, 'utf8') : '';
    if (css !== generateCss(tokens)) problems.push('apps/web/app/tokens.css was not generated from design/tokens.json (run `npm run design:css`)');

    // The fonts are loaded by next/font in the root layout, so a family change is a code change.
    const layout = fs.readFileSync(LAYOUT, 'utf8');
    for (const id of ['font-sans', 'font-mono']) {
      const family = tokens.typography.find((x) => x.id === id).value.split(',')[0].replace(/['"]/g, '').trim();
      const ident = family.replace(/\s+/g, '_');
      if (!new RegExp(`\\b${ident}\\b`).test(layout)) problems.push(`font: design/tokens.json names "${family}", but apps/web/app/layout.tsx does not load ${ident} from next/font/google`);
    }

    const app = new Set(appRoutes());
    const built = new Set(pages.pages.filter((p) => !p.proposed).map((p) => p.route));
    for (const r of app) if (!built.has(r)) problems.push(`pages: the app has ${r}, but design/pages.json does not list it`);
    for (const r of built) if (!app.has(r)) problems.push(`pages: design/pages.json lists ${r}, but the app has no such page (mark it proposed if it is planned)`);
    for (const p of pages.pages) {
      if (p.proposed) notes.push(`proposed page, not built yet: ${p.route} (${p.title})`);
      if (String(p.request ?? '').trim()) notes.push(`change request on ${p.route}: ${String(p.request).trim()}`);
    }
  }

  if (compareDashboard && fs.existsSync(DASHBOARD)) {
    try {
      const { state } = readDashboard();
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (state.design && !same(stripChanges(state.design), tokens)) notes.push("the dashboard's design differs from design/tokens.json (pull to take the dashboard's, push to take the repository's)");
      if (state.ui && !same(stripChanges(state.ui), pages)) notes.push("the dashboard's page layouts differ from design/pages.json (pull or push)");
      const waiting = ['design', 'ui'].reduce((n, a) => n + (state[a]?.changes ?? []).filter((c) => c.status === 'requested').length, 0);
      if (waiting) notes.push(`${waiting} requested change${waiting === 1 ? '' : 's'} in the dashboard wait for Claude (run pending)`);
    } catch (err) {
      notes.push(`dashboard not read: ${err.message}`);
    }
  }

  if (notes.length && !quiet) console.log(notes.map((n) => `note: ${n}`).join('\n'));
  if (problems.length) fail('design check failed:', problems);
  if (!quiet) console.log(`design check passed: ${tokens.colors.length} colours, ${(tokens.contrast ?? []).length} contrast pairs in two themes, ${tokens.settings.filter((s) => s.token).length} token settings, ${pages.pages.length} pages`);
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

const commands = { pull, push, check, css, pending, applied, declined, handled };
if (!commands[command]) {
  console.error('usage: node tools/design-sync.mjs pending|pull|applied|declined|handled|push|check|css [--dashboard <path>]');
  process.exit(2);
}
try {
  commands[command]();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
