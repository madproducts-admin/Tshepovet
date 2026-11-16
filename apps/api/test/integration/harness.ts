import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import { Client, Pool } from 'pg';
import { generateApiKey, hashApiKey, loadConfig, logger } from '@tshepovet/core';
import { buildContainer, type Container, type ContainerOverrides } from '../../src/container';
import { createHttpApp } from '../../src/create-http-app';

export const KEYS = {
  KEK_KEYS: `1:${crypto.randomBytes(32).toString('base64')}`,
  BLIND_INDEX_ROOT_KEY: crypto.randomBytes(32).toString('base64'),
  API_KEY_PEPPER: crypto.randomBytes(32).toString('base64'),
};

/** Rebuilds the test database from migrations - the same SQL production runs. */
export async function resetDatabase() {
  const c = new Client({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  const dir = path.join(__dirname, '..', '..', '..', '..', 'db', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await c.query(readFileSync(path.join(dir, f), 'utf8'));
  await c.end();
}

export function ownerPool() {
  return new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL, max: 4 });
}

export async function createTenant(owner: Pool, name: string, walletCents: number, settings: Record<string, unknown> = {}) {
  const t = await owner.query<{ id: string }>(`INSERT INTO tenants (legal_name, settings) VALUES ($1, $2) RETURNING id`, [name, JSON.stringify(settings)]);
  const tenantId = t.rows[0]!.id;
  const acct = await owner.query<{ id: string }>(`INSERT INTO ledger_accounts (tenant_id, code, kind) VALUES ($1, 'customer_wallet', 'liability') RETURNING id`, [tenantId]);
  await owner.query(`INSERT INTO wallets (tenant_id, ledger_account_id, balance_cents) VALUES ($1, $2, $3)`, [tenantId, acct.rows[0]!.id, walletCents]);
  const pepper = Buffer.from(KEYS.API_KEY_PEPPER, 'base64');
  const keys: Record<'live' | 'test', string> = { live: '', test: '' };
  for (const env of ['live', 'test'] as const) {
    const k = generateApiKey(env);
    await owner.query(`INSERT INTO api_keys (tenant_id, prefix, secret_hash, environment, name, scopes) VALUES ($1, $2, $3, $4, 'test', '{verify:write,verify:read}')`, [
      tenantId,
      k.prefix,
      hashApiKey(pepper, k.key),
      env,
    ]);
    keys[env] = k.key;
  }
  return { tenantId, keys };
}

export async function buildTestApp(overrides: ContainerOverrides = {}) {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL,
    ENABLED_PROVIDERS: 'mock',
    SYNC_DEADLINE_MS: '5000',
    SANDBOX: 'true',
    ...KEYS,
  });
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  const redis = new Redis(config.REDIS_URL);
  const container: Container = buildContainer(config, pool, redis, logger, overrides);
  const nest = await createHttpApp(container);
  return {
    app: nest.getHttpServer(),
    nest,
    container,
    close: async () => {
      await nest.close();
      await pool.end();
      await redis.quit();
    },
  };
}
