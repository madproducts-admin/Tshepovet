import { Client } from 'pg';
import { generateApiKey, hashApiKey } from '../packages/core/src/auth/apiKeys';

/** Creates a demo buyer tenant, a wallet with R1,000 credit and live+test API keys. */
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.WORKER_DATABASE_URL;
  const pepper = Buffer.from(process.env.API_KEY_PEPPER ?? '', 'base64');
  if (!url || pepper.length !== 32) throw new Error('MIGRATION_DATABASE_URL and API_KEY_PEPPER are required');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  const t = await c.query<{ id: string }>(`INSERT INTO tenants (legal_name) VALUES ('Demo Buyer (Pty) Ltd') RETURNING id`);
  const tenantId = t.rows[0]!.id;
  const acct = await c.query<{ id: string }>(`INSERT INTO ledger_accounts (tenant_id, code, kind) VALUES ($1, 'customer_wallet', 'liability') RETURNING id`, [tenantId]);
  await c.query(`INSERT INTO wallets (tenant_id, ledger_account_id) VALUES ($1, $2)`, [tenantId, acct.rows[0]!.id]);
  const tx = await c.query<{ id: string }>(`INSERT INTO ledger_transactions (tenant_id, kind, idempotency_key, memo) VALUES ($1, 'promo_credit', $2, 'dev seed') RETURNING id`, [tenantId, `seed:${tenantId}`]);
  const promo = await c.query<{ id: string }>(`SELECT id FROM ledger_accounts WHERE tenant_id IS NULL AND code = 'promo_credit_expense'`);
  await c.query(`INSERT INTO ledger_entries (transaction_id, account_id, tenant_id, amount_cents) VALUES ($1, $2, $4, 100000), ($1, $3, $4, -100000)`, [tx.rows[0]!.id, promo.rows[0]!.id, acct.rows[0]!.id, tenantId]);
  await c.query(`UPDATE wallets SET balance_cents = 100000 WHERE tenant_id = $1`, [tenantId]);
  const keys: Record<string, string> = {};
  for (const env of ['live', 'test'] as const) {
    const k = generateApiKey(env);
    await c.query(`INSERT INTO api_keys (tenant_id, prefix, secret_hash, environment, name) VALUES ($1, $2, $3, $4, $5)`, [tenantId, k.prefix, hashApiKey(pepper, k.key), env, `dev ${env}`]);
    keys[env] = k.key;
  }
  await c.query('COMMIT');
  await c.end();
  console.log(JSON.stringify({ tenantId, wallet_cents: 100000, api_keys: keys }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
