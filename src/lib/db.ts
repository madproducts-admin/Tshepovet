import { Pool, PoolClient, QueryResultRow } from 'pg';

export type Db = Pool;

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'tshepovet',
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction with the RLS tenant context set. SET LOCAL
 * scopes the setting to this transaction, so a pooled connection can never
 * leak one tenant's context into another tenant's request.
 */
export async function withTenantTx<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('invalid tenant id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(
  client: PoolClient | Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const r = await client.query<T>(sql, params);
  return r.rows[0];
}
