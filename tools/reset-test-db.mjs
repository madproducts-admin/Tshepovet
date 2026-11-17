// Rebuilds the test database from the migrations (the same SQL production runs) and empties
// the test Redis database. Used by deploy/app/run-web-e2e.ps1 before the browser flows.
//   TEST_OWNER_DATABASE_URL, TEST_REDIS_URL must be set.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const owner = process.env.TEST_OWNER_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!owner || !redisUrl) throw new Error('TEST_OWNER_DATABASE_URL and TEST_REDIS_URL are required');
if (!/\/tshepovet_test(\?|$)/.test(owner)) throw new Error('refusing to reset a database that is not tshepovet_test');

const c = new pg.Client({ connectionString: owner });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
const dir = path.join(root, 'db', 'migrations');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  await c.query(readFileSync(path.join(dir, f), 'utf8'));
  console.log(`applied ${f}`);
}
await c.end();

const r = new Redis(redisUrl);
await r.flushdb();
await r.quit();
console.log('test database and redis reset');
