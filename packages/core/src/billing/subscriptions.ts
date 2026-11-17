import type { PoolClient } from 'pg';
import { ApiError, Errors } from '../lib/errors';
import { priceFor } from './wallet';

/**
 * Monthly modules (the subscription_monthly SKUs in price_book), paid from the prepaid wallet.
 *
 * A module is in effect while today < current_period_end (the end is exclusive). Activating
 * charges the first month at once:
 *     Dr customer_wallet      +price
 *     Cr revenue_subscription -price
 * Cancelling sets cancel_at to the period end: the module stays on until then, and turning it
 * back on before then costs nothing. Renewal at the period end is the monitoring job's (M7).
 */
export const MODULE_SKUS = ['MOD_BBBEE', 'MOD_COI_RADAR', 'MOD_CONSTRUCTION', 'MOD_LOGISTICS'] as const;
export type ModuleSku = (typeof MODULE_SKUS)[number];

export interface SubscriptionRow {
  id: string;
  sku: string;
  status: string;
  unit_price_cents: number;
  current_period_start: string;
  current_period_end: string;
  cancel_at: string | null;
  created_at: Date;
}

const COLUMNS = `id, sku, status, unit_price_cents, current_period_start, current_period_end, cancel_at, created_at`;

/** The modules in effect for the tenant now. */
export async function activeModules(client: PoolClient): Promise<Set<string>> {
  const r = await client.query<{ sku: string }>(`SELECT sku FROM subscriptions WHERE status = 'active' AND current_date < current_period_end`);
  return new Set(r.rows.map((x) => x.sku));
}

export async function activateModule(
  client: PoolClient,
  a: { tenantId: string; sku: ModuleSku },
): Promise<{ subscription: SubscriptionRow; charged_cents: number; resumed: boolean }> {
  const cur = (
    await client.query<SubscriptionRow & { in_period: boolean }>(
      `SELECT ${COLUMNS}, (status = 'active' AND current_date < current_period_end) AS in_period
         FROM subscriptions WHERE tenant_id = $1 AND sku = $2 FOR UPDATE`,
      [a.tenantId, a.sku],
    )
  ).rows[0];
  if (cur?.in_period) {
    if (!cur.cancel_at) throw new ApiError(409, 'already_active', 'This module is already on.');
    const r = await client.query<SubscriptionRow>(`UPDATE subscriptions SET cancel_at = NULL WHERE id = $1 RETURNING ${COLUMNS}`, [cur.id]);
    return { subscription: r.rows[0]!, charged_cents: 0, resumed: true };
  }

  const price = await priceFor(client, a.tenantId, a.sku, 'live');
  const sub = (
    await client.query<SubscriptionRow>(
      `INSERT INTO subscriptions (tenant_id, sku, status, unit_price_cents, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', $3, current_date, (current_date + interval '1 month')::date)
       ON CONFLICT (tenant_id, sku) DO UPDATE
         SET status = 'active', unit_price_cents = EXCLUDED.unit_price_cents, cancel_at = NULL,
             current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end
       RETURNING ${COLUMNS}`,
      [a.tenantId, a.sku, price],
    )
  ).rows[0]!;

  if (price > 0) {
    const w = await client.query<{ ledger_account_id: string }>(
      `UPDATE wallets SET balance_cents = balance_cents - $2, updated_at = now()
        WHERE tenant_id = $1 AND status = 'active' AND balance_cents - held_cents + credit_limit_cents >= $2
        RETURNING ledger_account_id`,
      [a.tenantId, price],
    );
    if (!w.rows[0]) {
      const bal = await client.query<{ available: number }>(
        `SELECT balance_cents - held_cents + credit_limit_cents AS available FROM wallets WHERE tenant_id = $1`,
        [a.tenantId],
      );
      throw Errors.insufficientFunds(price, Number(bal.rows[0]?.available ?? 0));
    }
    const revenue = await client.query<{ id: string }>(`SELECT id FROM ledger_accounts WHERE tenant_id IS NULL AND code = 'revenue_subscription'`);
    const tx = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, kind, reference_type, reference_id, idempotency_key, memo)
       VALUES ($1, 'subscription_charge', 'subscription', $2, $3, $4) RETURNING id`,
      [a.tenantId, sub.id, `subscription:${sub.id}:${sub.current_period_start}`, `${a.sku} ${sub.current_period_start} to ${sub.current_period_end}`],
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, tenant_id, amount_cents) VALUES ($1, $2, $4, $5), ($1, $3, $4, -$5)`,
      [tx.rows[0]!.id, w.rows[0].ledger_account_id, revenue.rows[0]!.id, a.tenantId, price],
    );
  }
  return { subscription: sub, charged_cents: price, resumed: false };
}

export async function cancelModule(client: PoolClient, a: { tenantId: string; sku: ModuleSku }): Promise<SubscriptionRow> {
  const r = await client.query<SubscriptionRow>(
    `UPDATE subscriptions SET cancel_at = current_period_end
      WHERE tenant_id = $1 AND sku = $2 AND status = 'active' AND current_date < current_period_end AND cancel_at IS NULL
      RETURNING ${COLUMNS}`,
    [a.tenantId, a.sku],
  );
  if (!r.rows[0]) throw new ApiError(409, 'not_active', 'This module is not on, or is already set to end.');
  return r.rows[0];
}
