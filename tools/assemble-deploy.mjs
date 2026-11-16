/**
 * Assembles the Cloudflare static-asset directory deploy/dist/ from
 * build/site/, and writes its _headers file. Run after tools/build-site.mjs.
 *
 * The Worker is assets-only (deploy/site/wrangler.toml has no `main`), so
 * _headers is the only way responses get security or caching headers.
 */
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = JSON.parse(await readFile(join(ROOT, 'tools/lib/site.json'), 'utf8'));
const BUILD = join(ROOT, 'build/site');
const DIST = join(ROOT, 'deploy/dist');

if (!existsSync(join(BUILD, 'build-id.txt'))) {
  console.error('build/site is missing or incomplete: run node tools/build-site.mjs first');
  process.exit(1);
}

/**
 * The CSP for this site's own origins. Scripts: 'self', plus Cloudflare Web
 * Analytics, whose beacon the madproducts.ai zone injects into every HTML page
 * (static.cloudflareinsights.com) and which reports to cloudflareinsights.com.
 * Every page script of our own is a file under /assets/ (the build moves them
 * out and fails on any inline script or on* handler), so there is no
 * 'unsafe-inline' and no hash list to keep in step. 'report-sample' puts the
 * first 40 characters of anything blocked into the violation, which is how the
 * smoke suite tells the zone's inline bot-detection snippet (still blocked)
 * apart from a real regression.
 * Styles keep 'unsafe-inline': each page carries its CSS in <style>, and the
 * rendered diagrams use style attributes.
 */
function contentSecurityPolicy(site = SITE) {
  return [
    "default-src 'self'",
    `script-src 'self' 'report-sample' ${site.csp.scriptOrigins.join(' ')}`,
    `connect-src 'self' ${site.csp.connectOrigins.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${site.csp.styleOrigins.join(' ')}`,
    `font-src 'self' ${site.csp.fontOrigins.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// No Cache-Control on /*: when two rules set the same header Cloudflare joins
// the values, so a catch-all no-cache would also land on the immutable assets.
// Pages are listed one by one instead. Unknown paths (the 404 page) keep the
// assets default, public, max-age=0, must-revalidate.
const HEADERS = `
/*
  Content-Security-Policy: ${contentSecurityPolicy()}
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  X-Robots-Tag: noindex, nofollow

/assets/*
  Cache-Control: public, max-age=31536000, immutable
${SITE.pages.map((p) => `\n${p.path}\n  Cache-Control: no-cache\n`).join('')}`;

await rm(DIST, { recursive: true, force: true });
await cp(BUILD, DIST, { recursive: true });
await writeFile(join(DIST, '_headers'), HEADERS.trimStart());

const id = (await readFile(join(DIST, 'build-id.txt'), 'utf8')).trim();
console.log(`deploy/dist assembled (build ${id}, ${SITE.pages.length} pages + 404, _headers written)`);
