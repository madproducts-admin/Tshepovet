/**
 * One-command deploy of the docs (https://tshepovet.madproducts.ai/docs) with
 * a post-deploy gate. Same shape as Mia's Crowns' tools/deploy.mjs, minus the
 * shop-only steps (migration ledger, worker data, image variants). The API on
 * the rest of the host has its own deploy: deploy/app/deploy-app.ps1.
 *
 *   node tools/deploy.mjs [--dry-run] [--skip-tests] [--skip-smoke]
 *   npm run deploy | npm run deploy:dry
 *
 * Everything that can fail cheaply runs before anything touches production:
 *
 *   0. the working tree is clean. The build ships the WORKING TREE, not HEAD,
 *      so anything uncommitted would go live without being in git. A dry run
 *      only warns, and its build id ends in "-dirty"
 *      + usable Cloudflare credentials, and the route pre-flight: no custom
 *      domain may hold the host, and no other Worker our routes (read-only;
 *      see customDomainPreflight). Both are checked again right before wrangler
 *   1. typecheck + the unit tests that need no Redis or PostgreSQL. The other
 *      30 (waterfall + integration) run in GitHub CI, which has both services
 *   2. build the site (tools/build-site.mjs: renders the diagrams, and fails on
 *      a broken link, an inline script or a claude.ai URL)
 *   3. assemble deploy/dist + _headers (tools/assemble-deploy.mjs)
 *   4. wrangler deploy                                         <- --dry-run stops here
 *   5. wait until the live site serves the new build id
 *   6. the Playwright smoke suite against the live URL
 *
 * Step 5 exists because the edge takes a few seconds to switch: checking too
 * early reads the old build and looks like a failed deploy.
 *
 * If the smoke suite fails, the deploy is already live: the script prints the
 * rollback command rather than pretending it can undo it silently.
 *
 * Cloudflare credentials (see deploy/README.md):
 *   - CLOUDFLARE_API_TOKEN from the environment, else wrangler's own OAuth
 *     login (oauth_token in %APPDATA%\xdg.config\.wrangler\config\default.toml).
 *     That token lasts an hour and running wrangler does not renew it while
 *     it is still valid, so the deploy refuses one with < 15 minutes left.
 *   - CLOUDFLARE_ACCOUNT_ID from the environment, else from TSV_CF_ENV
 *     (default: Mia's Crowns' old/v1/.env, the same account). Only that one
 *     line is read: the API token in that file is dead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = JSON.parse(readFileSync(join(ROOT, 'tools/lib/site.json'), 'utf8'));
const WRANGLER_DIR = join(ROOT, 'deploy/site');
const WORKER = SITE.worker;
const LIVE = process.env.TSV_DEPLOY_URL ?? SITE.liveUrl; // the host; the smoke suite's base URL
const DOCS = `${LIVE}${SITE.basePath}/`; // where the build id is read
const OAUTH_FILE = process.env.TSV_WRANGLER_OAUTH ?? join(process.env.APPDATA ?? '', 'xdg.config/.wrangler/config/default.toml');
const ACCOUNT_FILE = process.env.TSV_CF_ENV ?? 'D:/applications/MiasCrowns.com/old/v1/.env';
const MIN_TOKEN_MINUTES = 15;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const dryRun = has('--dry-run');

let step = 0;
const head = (msg) => console.log(`\n\u2500\u2500 ${++step}. ${msg} ${'\u2500'.repeat(Math.max(0, 54 - msg.length))}`);
const die = (msg, extra) => {
  console.error(`\nFAILED: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
};

function run(cmd, opts = {}) {
  const res = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit', ...opts });
  if (res.status !== 0) die(`${cmd} exited ${res.status}`);
}

// ── Cloudflare credentials ─────────────────────────────────────────────────
/** Returns { env, problems, note }. Never prints a token. */
function cloudflareEnv() {
  const env = { ...process.env };
  const problems = [];
  let note = '';
  if (!env.CLOUDFLARE_ACCOUNT_ID && existsSync(ACCOUNT_FILE)) {
    const m = readFileSync(ACCOUNT_FILE, 'utf8').match(/^CLOUDFLARE_ACCOUNT_ID=(.+)$/m);
    if (m) env.CLOUDFLARE_ACCOUNT_ID = m[1].trim();
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID) problems.push(`no CLOUDFLARE_ACCOUNT_ID (environment or ${ACCOUNT_FILE})`);

  if (env.CLOUDFLARE_API_TOKEN) {
    note = 'CLOUDFLARE_API_TOKEN from the environment';
  } else if (!existsSync(OAUTH_FILE)) {
    problems.push(`no CLOUDFLARE_API_TOKEN and no wrangler login at ${OAUTH_FILE}`);
  } else {
    const toml = readFileSync(OAUTH_FILE, 'utf8');
    const token = toml.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
    const expires = Date.parse(toml.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1] ?? '');
    const minutes = Math.floor((expires - Date.now()) / 60_000);
    if (!token || Number.isNaN(expires)) {
      problems.push(`${OAUTH_FILE} has no oauth_token/expiration_time: run any wrangler command (e.g. npx wrangler@4 whoami) with CLOUDFLARE_API_TOKEN unset to log in`);
    } else if (minutes < MIN_TOKEN_MINUTES) {
      problems.push(
        minutes < 0
          ? `the wrangler OAuth token expired ${-minutes} min ago: run npx wrangler@4 whoami (CLOUDFLARE_API_TOKEN unset) to refresh it`
          : `the wrangler OAuth token expires in ${minutes} min (< ${MIN_TOKEN_MINUTES}): wait for it to pass, run npx wrangler@4 whoami to refresh it, then deploy`,
      );
    } else {
      env.CLOUDFLARE_API_TOKEN = token;
      note = `wrangler OAuth token, valid for another ${minutes} min`;
    }
  }
  return { env, problems, note };
}

// ── Route pre-flight ───────────────────────────────────────────────────────
/**
 * The Worker answers only /docs* and /robots.txt on the host (plain routes);
 * the API on the box answers the rest through the zone's *.madproducts.ai
 * wildcard. Two things would break that, and both are checked read-only:
 *  - a Workers custom domain on the host: it takes the whole host, so the API
 *    would vanish behind the Worker (the docs site used one until 2026-11-16);
 *  - one of our route patterns already pointing at another Worker.
 * Never use custom_domain for this host: wrangler 4 without a terminal (as
 * this script runs it) also replaces any DNS record of the same name unasked.
 */
async function cfGet(env, path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page: the status says enough */
  }
  return { status: res.status, ok: res.ok && body?.success === true, result: body?.result };
}

async function customDomainPreflight(env) {
  const host = SITE.host;
  const acct = env.CLOUDFLARE_ACCOUNT_ID;
  const domains = await cfGet(env, `/accounts/${acct}/workers/domains?hostname=${encodeURIComponent(host)}`);
  if (!domains.ok) return { ok: false, reason: `could not list Worker custom domains (HTTP ${domains.status})` };
  const attached = domains.result.filter((d) => d.hostname === host);
  if (attached.length) {
    return {
      ok: false,
      reason:
        `${host} is a custom domain of Worker "${attached[0].service}", which hides the API. Detach it ` +
        `(DELETE /accounts/:account/workers/domains/${attached[0].id}; see deploy/README.md, "Cutover") and rerun`,
    };
  }
  const zones = await cfGet(env, `/zones?name=${encodeURIComponent(SITE.zone)}&account.id=${acct}`);
  if (!zones.ok || zones.result.length !== 1) {
    return { ok: false, reason: `zone ${SITE.zone} not found in account ${acct.slice(0, 6)}… (HTTP ${zones.status})` };
  }
  const routes = await cfGet(env, `/zones/${zones.result[0].id}/workers/routes`);
  if (!routes.ok) return { ok: false, reason: `could not list the zone's Worker routes (HTTP ${routes.status})` };
  const taken = routes.result.filter((r) => SITE.routes.includes(r.pattern) && r.script && r.script !== WORKER);
  if (taken.length) return { ok: false, reason: `route ${taken[0].pattern} belongs to Worker "${taken[0].script}"` };
  const ours = routes.result.filter((r) => SITE.routes.includes(r.pattern)).length;
  return { ok: true, note: `no custom domain on ${host}; ${ours} of ${SITE.routes.length} routes already ours, none taken` };
}

const buildIdOf = (html) => html.match(/<meta name="build-id" content="([^"]+)"/)?.[1] ?? null;

/** What the live site serves now: { status, build }. */
async function fetchLive() {
  try {
    const res = await fetch(`${DOCS}?cb=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    return { status: res.status, build: res.ok ? buildIdOf(await res.text()) : null };
  } catch (err) {
    return { status: `unreachable (${err.cause?.code ?? err.message})`, build: null };
  }
}

// ── 0. Committed work only ─────────────────────────────────────────────────
head('working tree is clean');
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const headSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (dirty) {
  const msg = `uncommitted changes would ship:\n${dirty.split('\n').map((l) => `   ${l}`).join('\n')}`;
  if (!dryRun) die(msg, 'Commit (or stash) them first: the deploy builds the working tree, not HEAD.');
  console.log(`   WARNING (dry run, so continuing): ${msg}`);
} else {
  console.log(`   clean at ${headSha} on ${branch || '(detached)'}`);
}

const creds = cloudflareEnv();
console.log(`   Cloudflare: ${creds.problems.length ? creds.problems.join('; ') : `${creds.note}, account ${creds.env.CLOUDFLARE_ACCOUNT_ID.slice(0, 6)}…`}`);
if (creds.problems.length && !dryRun) die('Cloudflare credentials are not usable', creds.problems.join('\n'));

// Read-only. Run again right before wrangler, since the build takes minutes.
head('route pre-flight (read-only)');
let preflight = { ok: false, reason: 'skipped: no usable Cloudflare credentials' };
if (!creds.problems.length) preflight = await customDomainPreflight(creds.env);
console.log(`   ${preflight.ok ? `ok: ${preflight.note}` : `BLOCKED: ${preflight.reason}`}`);
if (!preflight.ok && !dryRun) die('the route pre-flight did not pass');

// ── 1. Cheap gates first ───────────────────────────────────────────────────
if (!has('--skip-tests')) {
  head('typecheck');
  run('npm run typecheck');
  head('unit tests that need no Redis or PostgreSQL');
  run('npm run test:unit:no-services');
} else {
  console.log('\n(skipping typecheck and tests at your request)');
}

// ── 2-3. Build + assemble ──────────────────────────────────────────────────
head('build the site');
run('node tools/build-site.mjs');
head('assemble deploy/dist + _headers');
run('node tools/assemble-deploy.mjs');

const expected = readFileSync(join(ROOT, 'deploy/dist/build-id.txt'), 'utf8').trim();
console.log(`   build to publish:  ${expected}`);
const before = await fetchLive();
console.log(`   currently live:    ${before.build ?? `(no TshepoVet build: HTTP ${before.status})`}`);
if (before.build === expected) console.log('   note: this build id is already live: a redeploy changes nothing but the version id');

const rollbackHelp = `Roll back:  cd deploy/site && npx wrangler@4 rollback --name ${WORKER}`;

if (dryRun) {
  console.log('\n--dry-run: stopping before wrangler deploy.');
  console.log(`   would deploy deploy/dist as Worker "${WORKER}" on ${SITE.routes.join(', ')}`);
  // Fall through rather than process.exit(): an open keep-alive socket from
  // the live check makes a hard exit assert inside libuv on Windows.
} else {
  // ── 4. Deploy ────────────────────────────────────────────────────────────
  head('wrangler deploy');
  const fresh = cloudflareEnv(); // the token may have aged during the build
  if (fresh.problems.length) die('Cloudflare credentials are no longer usable', fresh.problems.join('\n'));
  const again = await customDomainPreflight(fresh.env);
  if (!again.ok) die(`route pre-flight: ${again.reason}`);
  const res = spawnSync('npx --yes wrangler@4 deploy', { cwd: WRANGLER_DIR, shell: true, encoding: 'utf8', env: fresh.env });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  process.stdout.write(out);
  if (res.status !== 0) die('wrangler deploy failed (nothing new is live)');
  const versionId = out.match(/Current Version ID:\s*([0-9a-f-]+)/)?.[1] ?? null;

  // ── 5. Wait for the edge to serve it ─────────────────────────────────────
  head('wait for the new build to be served');
  let live = null;
  for (let i = 0; i < 40; i++) {
    live = await fetchLive();
    if (live.build === expected) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (live?.build !== expected) {
    die(`the edge still serves ${live?.build ?? `HTTP ${live?.status}`} after 120s, expected ${expected}`, rollbackHelp);
  }
  console.log(`   serving ${expected} \u2713`);

  // ── 6. Post-deploy gate ──────────────────────────────────────────────────
  if (has('--skip-smoke')) {
    console.log('\n(skipping the smoke suite at your request)');
  } else {
    head('docs smoke suite against the live site');
    const smoke = spawnSync('npx playwright test tests/smoke/site.smoke.ts --reporter=line', {
      cwd: ROOT,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, TSV_E2E_BASE_URL: LIVE, TSV_EXPECTED_BUILD_ID: expected },
    });
    if (smoke.status !== 0) {
      console.error('\n' + '='.repeat(64));
      console.error('THE DEPLOY IS LIVE AND THE SMOKE SUITE FAILED.');
      if (before.build === expected) {
        console.error('But the build id is the one that was already live, so this deploy');
        console.error('did not change the pages: a rollback would move the version id and');
        console.error('nothing else. Re-run the failed tests alone before touching anything.');
      } else {
        console.error(rollbackHelp);
      }
      console.error('='.repeat(64));
      process.exit(1);
    }
  }

  console.log(`\n\u2713 deployed and verified${versionId ? ` (version ${versionId})` : ''}`);
  console.log(`  live: ${LIVE}  build: ${expected}`);
  console.log(`  ${rollbackHelp.split('\n')[0]}`);
}
