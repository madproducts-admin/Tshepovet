import { Pool, PoolClient, QueryResultRow, types } from 'pg';

/*
 * Type parsing for every pool in the process (pg keeps it in module state):
 * - DATE columns are calendar days, not instants: they stay 'YYYY-MM-DD' strings. pg's default
 *   makes a local-midnight Date, which JSON then shifts by the server's UTC offset (on a
 *   UTC+2 box, 2026-11-16 would reach the browser as 2026-11-15T22:00Z).
 * - int8 (bigint: money in cents, counts, audit sequence numbers) becomes a number, refused
 *   outside the safe-integer range rather than silently rounded.
 */
types.setTypeParser(1082, (v: string) => v);
types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${v} is outside the safe integer range`);
  return n;
});

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
