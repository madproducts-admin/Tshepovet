/**
 * Builds the static docs site (tshepovet.madproducts.ai) into build/site/.
 *
 *   node tools/build-site.mjs
 *
 * Sources: the five design pages in docs/pages/ and the site-only files in
 * deploy/site/static/ (404 page, site CSS, favicon, robots.txt); the page map
 * is tools/lib/site.json. The design pages are also published as private
 * claude.ai pages, so their sources keep claude.ai links and mermaid source.
 * This build adapts a copy for the public site and leaves the sources alone.
 *
 * Per page:
 *   - hoists the <title>, <meta>, <link> and <style> that the claude.ai shell
 *     left in <body> into <head>, and drops the claude:* meta tags
 *   - rewrites links to the claude.ai pages as root-relative clean paths
 *     (/docs/database-schema#billing). Root-relative rather than ./relative because
 *     404.html is served at any depth under /docs/
 *   - renders each <pre class="mermaid"> to inline SVG in headless Chromium,
 *     inside the page's own CSS with the page's own web fonts loaded, so the
 *     labels are measured exactly as they will be shown. No mermaid ships
 *   - moves each inline <script> into a content-hashed /assets/*.js file, so
 *     the CSP can be script-src 'self' with no 'unsafe-inline' and no hashes
 *   - stamps <meta name="build-id"> (the git SHA, "-dirty" if the working tree
 *     is not clean) and <meta name="robots" content="noindex, nofollow">
 *
 * Then it validates the whole output and fails on: a claude.ai URL left
 * anywhere, a diagram not rendered, an inline script or on* handler, a script
 * or stylesheet from an origin the CSP does not allow, or an internal link
 * whose path or #fragment does not exist.
 *
 * Needs Playwright's Chromium (npx playwright install chromium) and network
 * access to Google Fonts: without the fonts the diagrams would be measured
 * with fallback metrics and clip on the live site, so the build stops.
 * TSV_ALLOW_FALLBACK_FONTS=1 overrides that, for an offline look only.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = JSON.parse(await readFile(join(ROOT, 'tools/lib/site.json'), 'utf8'));
const OUT = join(ROOT, 'build/site');
const STATIC = join(ROOT, 'deploy/site/static');
const MERMAID = join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js');
// Pages are rendered from this made-up origin, answered from OUT by a route
// handler, so relative and root-relative URLs resolve as they will live.
const BUILD_ORIGIN = 'https://site.build';
const allowFallbackFonts = process.env.TSV_ALLOW_FALLBACK_FONTS === '1';

// One light palette from the design tokens (--ink, --muted, --rule, --accent,
// --accent-soft, --bg, --warn). site.css puts every diagram on a light canvas.
const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  themeVariables: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: '14px',
    background: '#ffffff',
    primaryColor: '#e5e7f6',
    primaryBorderColor: '#2b3796',
    primaryTextColor: '#151922',
    secondaryColor: '#f4f5f8',
    secondaryBorderColor: '#d9dce3',
    secondaryTextColor: '#151922',
    tertiaryColor: '#ffffff',
    tertiaryBorderColor: '#d9dce3',
    tertiaryTextColor: '#151922',
    lineColor: '#586174',
    textColor: '#151922',
    clusterBkg: '#f4f5f8',
    clusterBorder: '#d9dce3',
    edgeLabelBackground: '#ffffff',
    noteBkgColor: '#f8ecd9',
    noteBorderColor: '#9a5800',
    noteTextColor: '#151922',
    actorBkg: '#e5e7f6',
    actorBorder: '#2b3796',
    actorTextColor: '#151922',
    actorLineColor: '#586174',
    signalColor: '#151922',
    signalTextColor: '#151922',
    labelBoxBkgColor: '#e5e7f6',
    labelBoxBorderColor: '#2b3796',
    labelTextColor: '#151922',
    loopTextColor: '#151922',
    activationBkgColor: '#ffffff',
    activationBorderColor: '#2b3796',
    sequenceNumberColor: '#ffffff',
  },
};

// Site-only layout choices; the diagram text is never changed.
// - ER diagrams default to top-to-bottom, which puts the schema's 28
//   relationships in one 5,600px row. Left-to-right stacks them instead. The
//   statement is added here, not in docs/pages, because the claude.ai and
//   GitHub renderers of the same source may not know it.
// - A diagram never shrinks below 70% of its natural size (text stays ~10px);
//   past that its .diagram frame scrolls sideways (overflow-x: auto).
const ER_DIRECTION = 'LR';
const MIN_DIAGRAM_SCALE = 0.7;

function layoutForSite(code) {
  if (/^\s*erDiagram\b/.test(code) && !/^\s*direction\s+(TB|BT|LR|RL)\b/m.test(code)) {
    return code.replace(/^(\s*erDiagram[^\n]*\n)/, `$1  direction ${ER_DIRECTION}\n`);
  }
  return code;
}

const fail = (msg) => {
  console.error(`\nbuild-site FAILED: ${msg}`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function buildId() {
  const sha = git('rev-parse', 'HEAD');
  return git('status', '--porcelain').length > 0 ? `${sha}-dirty` : sha;
}

// ── In-page helpers (serialised into the browser; must be self-contained) ──

/** Adapts one source page. Uses DOMParser, so no page script ever runs. */
function transformInPage({ html, artifactPaths, buildId, buildIdMeta, siteCssHref, faviconHref }) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const head = doc.head;
  const headOnly = new Set(['TITLE', 'META', 'LINK', 'STYLE']);
  for (const el of Array.from(doc.body.children)) {
    if (headOnly.has(el.tagName)) head.appendChild(el);
  }
  for (const el of doc.querySelectorAll('meta[name^="claude:"]')) el.remove();
  if (doc.querySelectorAll('title').length !== 1) throw new Error('expected exactly one <title>');
  if (doc.querySelector('base')) throw new Error('<base> would change how every link resolves');

  const meta = (name, content) => {
    const m = doc.createElement('meta');
    m.setAttribute('name', name);
    m.setAttribute('content', content);
    return m;
  };
  const icon = doc.createElement('link');
  icon.setAttribute('rel', 'icon');
  icon.setAttribute('type', 'image/svg+xml');
  icon.setAttribute('href', faviconHref);
  head.querySelector('title').after(meta(buildIdMeta, buildId), meta('robots', 'noindex, nofollow'), icon);
  const css = doc.createElement('link');
  css.setAttribute('rel', 'stylesheet');
  css.setAttribute('href', siteCssHref);
  head.appendChild(css); // last, so site rules win over the page's own

  const unknown = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const m = a.getAttribute('href').match(/^https:\/\/claude\.ai\/artifact\/([A-Za-z0-9]+)(#.*)?$/);
    if (!m) continue;
    const path = artifactPaths[m[1]];
    if (path) a.setAttribute('href', path + (m[2] ?? ''));
    else unknown.push(m[1]);
  }
  if (unknown.length) throw new Error(`links to claude.ai pages this site does not publish: ${unknown.join(', ')}`);

  const scripts = [];
  for (const s of doc.querySelectorAll('script:not([src])')) {
    const type = (s.getAttribute('type') ?? '').trim().toLowerCase();
    if (type && type !== 'text/javascript') {
      // JSON-LD and other data blocks never execute, so the CSP ignores them.
      if (type === 'module') throw new Error('inline module scripts are not handled');
      continue;
    }
    scripts.push(s.textContent);
    s.textContent = '';
    s.setAttribute('src', `__TSV_SCRIPT_${scripts.length - 1}__`);
  }

  const diagrams = [];
  for (const pre of doc.querySelectorAll('pre.mermaid')) {
    diagrams.push(pre.textContent);
    const canvas = doc.createElement('div');
    canvas.className = 'diagram-canvas';
    canvas.setAttribute('data-diagram', String(diagrams.length - 1));
    pre.replaceWith(canvas);
  }
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML + '\n', scripts, diagrams };
}

/** Renders every .diagram-canvas on the loaded page; returns the SVG markup. */
async function renderInPage({ config, codes, fonts, allowFallbackFonts }) {
  await document.fonts.ready;
  await Promise.all(fonts.map((f) => document.fonts.load(`16px "${f}"`)));
  // fonts.check() is true when no face of that name exists at all, so look
  // for a face that actually loaded rather than trusting it.
  const loaded = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')));
  const missing = fonts.filter((f) => !loaded.has(f));
  if (missing.length && !allowFallbackFonts) {
    throw new Error(`web fonts did not load (${missing.join(', ')}): diagrams would be measured with fallback metrics`);
  }
  window.mermaid.initialize(config);
  const canvases = document.querySelectorAll('.diagram-canvas[data-diagram]');
  if (canvases.length !== codes.length) throw new Error(`found ${canvases.length} diagram slots for ${codes.length} diagrams`);
  const svgs = [];
  for (let i = 0; i < codes.length; i++) {
    const { svg } = await window.mermaid.render(`diagram-${i + 1}`, codes[i], canvases[i]);
    svgs.push(svg);
  }
  return svgs;
}

function insertSvgsInPage({ html, svgs, minScale }) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const canvases = doc.querySelectorAll('.diagram-canvas[data-diagram]');
  canvases.forEach((c, i) => {
    c.innerHTML = svgs[i];
    c.removeAttribute('data-diagram');
    // mermaid sizes the SVG width:100% up to max-width (its natural width)
    const svg = c.querySelector('svg');
    const natural = parseFloat(svg?.style.maxWidth ?? '');
    if (svg && natural > 0) svg.style.minWidth = `${Math.round(natural * minScale)}px`;
  });
  return '<!doctype html>\n' + doc.documentElement.outerHTML + '\n';
}

function inspectInPage(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const handlers = [];
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) handlers.push(`<${el.localName} ${attr.name}>`);
      if (/^\s*javascript:/i.test(attr.value)) handlers.push(`<${el.localName} ${attr.name}="javascript:…">`);
    }
  }
  const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
  return {
    ids,
    duplicateIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
    hrefs: [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    scripts: [...doc.querySelectorAll('script')].map((s) => ({
      src: s.getAttribute('src'),
      type: s.getAttribute('type'),
      inline: !s.hasAttribute('src') && s.textContent.trim().length > 0,
    })),
    stylesheets: [...doc.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.getAttribute('href')),
    embeds: [...doc.querySelectorAll('iframe, object, embed, img, video, audio, source')].map((e) => e.localName),
    handlers,
    title: doc.querySelector('head > title')?.textContent.trim() ?? '',
    buildId: doc.querySelector('meta[name="build-id"]')?.getAttribute('content') ?? null,
    robots: doc.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
    unrendered: doc.querySelectorAll('pre.mermaid, .diagram-canvas[data-diagram]').length,
    svgs: doc.querySelectorAll('.diagram-canvas > svg').length,
  };
}

// ── Build ──────────────────────────────────────────────────────────────────

if (!existsSync(MERMAID)) fail(`${MERMAID} is missing: run npm ci`);

const id = buildId();
const BASE = SITE.basePath; // every page and asset lives under it; the Worker is routed there
console.log(`build id: ${id}`);
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, BASE, 'assets'), { recursive: true });

const assetNames = new Map(); // content hash -> <base>/assets/ path
async function writeAsset(stem, ext, text) {
  const hash = sha12(text);
  if (!assetNames.has(hash)) {
    const name = `${BASE}/assets/${stem}.${hash}.${ext}`;
    await writeFile(join(OUT, name), text);
    assetNames.set(hash, name);
  }
  return assetNames.get(hash);
}

const siteCssHref = await writeAsset('site', 'css', await readFile(join(ROOT, SITE.siteCss), 'utf8'));
for (const f of SITE.staticFiles) {
  await mkdir(dirname(join(OUT, f.to)), { recursive: true });
  await copyFile(join(STATIC, f.from), join(OUT, f.to));
}
const faviconHref = `/${SITE.staticFiles.find((f) => f.from === 'favicon.svg').to}`;

const artifactPaths = Object.fromEntries(SITE.pages.map((p) => [p.artifact, p.path]));
const jobs = [...SITE.pages, { ...SITE.notFound, path: null }];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(`${BUILD_ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('.js')) return route.abort(); // page scripts play no part in rendering
    const file = join(OUT, decodeURIComponent(pathname));
    if (!file.startsWith(OUT) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto('about:blank');

  const built = [];
  for (const job of jobs) {
    const source = await readFile(join(ROOT, job.source), 'utf8');
    const stem = basename(job.out, '.html');
    await mkdir(dirname(join(OUT, job.out)), { recursive: true });
    let { html, scripts, diagrams } = await page.evaluate(transformInPage, {
      html: source,
      artifactPaths,
      buildId: id,
      buildIdMeta: SITE.buildIdMeta,
      siteCssHref,
      faviconHref,
    });
    for (let i = 0; i < scripts.length; i++) {
      html = html.replace(`__TSV_SCRIPT_${i}__`, await writeAsset(stem, 'js', scripts[i].trim() + '\n'));
    }
    if (diagrams.length) {
      await writeFile(join(OUT, job.out), html);
      await page.goto(`${BUILD_ORIGIN}/${job.out}`, { waitUntil: 'load' });
      await page.addScriptTag({ path: MERMAID });
      const svgs = await page.evaluate(renderInPage, {
        config: MERMAID_CONFIG,
        codes: diagrams.map(layoutForSite),
        fonts: SITE.fonts,
        allowFallbackFonts,
      });
      await page.goto('about:blank');
      html = await page.evaluate(insertSvgsInPage, { html, svgs, minScale: MIN_DIAGRAM_SCALE });
    }
    await writeFile(join(OUT, job.out), html);
    built.push({ job, html, diagrams: diagrams.length, scripts: scripts.length });
    console.log(`  ${job.out.padEnd(30)} ${String(diagrams.length).padStart(2)} diagram(s)  ${scripts.length} script(s)  ${(html.length / 1024).toFixed(0)} KB`);
  }
  if (pageErrors.length) fail(`page errors while rendering:\n  ${pageErrors.join('\n  ')}`);

  // ── Validate ─────────────────────────────────────────────────────────────
  const problems = [];
  const warnings = [];
  const info = new Map();
  for (const b of built) info.set(b.job.out, await page.evaluate(inspectInPage, b.html));
  const idsByPath = new Map(SITE.pages.map((p) => [p.path, new Set(info.get(p.out).ids)]));
  const files = new Set([...SITE.staticFiles.map((f) => `/${f.to}`), ...assetNames.values()]);
  const allowedStyles = SITE.csp.styleOrigins.map((o) => `${o}/`);
  const external = new Set();

  for (const b of built) {
    const where = b.job.out;
    const r = info.get(where);
    if (b.html.includes('claude.ai')) problems.push(`${where}: still mentions claude.ai`);
    if (r.unrendered) problems.push(`${where}: ${r.unrendered} diagram(s) not rendered`);
    if (r.svgs !== b.diagrams) problems.push(`${where}: ${r.svgs} SVG diagram(s) for ${b.diagrams} source diagram(s)`);
    if (!r.title) problems.push(`${where}: no <title> in <head>`);
    if (r.buildId !== id) problems.push(`${where}: build-id meta is ${r.buildId}`);
    if (r.robots !== 'noindex, nofollow') problems.push(`${where}: robots meta is ${r.robots}`);
    for (const h of r.handlers) problems.push(`${where}: inline handler ${h} (blocked by the CSP)`);
    for (const e of r.embeds) problems.push(`${where}: <${e}> is not expected on this site; check the CSP allows its source`);
    for (const s of r.scripts) {
      if (s.inline && !s.type) problems.push(`${where}: inline <script> (blocked by the CSP)`);
      else if (s.src && !(s.src.startsWith(`${BASE}/assets/`) && files.has(s.src))) problems.push(`${where}: script ${s.src} is not a built asset`);
    }
    for (const href of r.stylesheets) {
      if (!(files.has(href) || allowedStyles.some((o) => href.startsWith(o)))) problems.push(`${where}: stylesheet ${href} is not allowed by the CSP`);
    }
    for (const id2 of r.duplicateIds) warnings.push(`${where}: duplicate id "${id2}"`);
    for (const href of r.hrefs) {
      if (/^(mailto|tel):/i.test(href)) continue;
      if (/^https?:\/\//i.test(href)) {
        external.add(href);
        continue;
      }
      const [path, frag] = href.split('#');
      if (path === '') {
        if (frag && !r.ids.includes(decodeURIComponent(frag))) problems.push(`${where}: #${frag} has no target`);
        continue;
      }
      if (!path.startsWith('/') || path.startsWith('//')) {
        problems.push(`${where}: link "${href}" is not root-relative`);
        continue;
      }
      if (idsByPath.has(path)) {
        if (frag && !idsByPath.get(path).has(decodeURIComponent(frag))) problems.push(`${where}: ${href} has no target`);
      } else if (!files.has(path)) {
        problems.push(`${where}: ${href} does not exist on the site`);
      }
      if (!path.startsWith(`${BASE}/`)) problems.push(`${where}: ${href} is outside ${BASE}/, which the API answers, not this site`);
    }
  }
  for (const w of warnings) console.warn(`  warning: ${w}`);
  if (external.size) console.log(`  external links: ${[...external].join(', ')}`);
  if (problems.length) fail(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
} finally {
  await browser.close();
}

await writeFile(join(OUT, 'build-id.txt'), id + '\n');
console.log(`build/site written (${jobs.length} pages, ${assetNames.size} assets)`);
