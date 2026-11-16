/**
 * Runs the docs-site smoke suite against `wrangler dev` serving deploy/dist,
 * the same files and _headers a deploy would upload. Nothing leaves the machine
 * apart from the Google Fonts requests the pages make.
 *
 *   npm run site:build && npm run site:smoke:local
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(ROOT, 'deploy/dist/_headers'))) {
  console.error('deploy/dist is not assembled: run npm run site:build first');
  process.exit(1);
}
const env = { ...process.env, TSV_E2E_BASE_URL: process.env.TSV_E2E_BASE_URL ?? 'http://127.0.0.1:8787' };
// The docs suite only: wrangler dev serves deploy/dist, not the API (tests/smoke/api.smoke.ts).
const res = spawnSync('npx playwright test tests/smoke/site.smoke.ts', { cwd: ROOT, shell: true, stdio: 'inherit', env });
process.exit(res.status ?? 1);
