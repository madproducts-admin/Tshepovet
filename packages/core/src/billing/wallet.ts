import type { PoolClient } from 'pg';
import { Errors } from '../lib/errors';

/**
 * Prepaid wallet over a double-entry ledger.
 *
 *   Top-up (R1,150 paid incl. 15% VAT -> R1,000 credits):
 *       Dr cash_clearing        +100000
 *       Cr customer_wallet      -100000     (liability: we owe the buyer checks)
 *
 *   Usage capture (one R3.00 check):
 *       Dr customer_wallet         +300
 *       Cr revenue_usage           -300
 *
 * Flow per check: RESERVE (hold) before calling bureaus -> CAPTURE when a
 * billable result is delivered, RELEASE when we could not deliver (provider
 * outage). Holds make concurrent requests safe without locking the wallet
 * for the duration of a bureau call; the DB CHECK constraint
 * `balance - held + credit_limit >= 0` is the last line of defence.
 *
 * All functions expect to run inside withTenantTx (RLS context set).
 */
export interface Hold {
  id: string;
  walletId: string;
  amountCents: number;
}

export async function ensureWallet(client: PoolClient, tenantId: string): Promise<string> {
  const existing = await client.query<{ id: string }>(`SELECT id FROM wallets WHERE tenant_id = $1`, [tenantId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const acct = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (tenant_id, code, kind) VALUES ($1, 'customer_wallet', 'liability')
     ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId],
  );
  const accountId =
    acct.rows[0]?.id ??
    (await client.query<{ id: string }>(`SELECT id FROM ledger_accounts WHERE tenant_id = $1 AND code = 'customer_wallet'`, [tenantId])).rows[0]!.id;
  const w = await client.query<{ id: string }>(
    `INSERT INTO wallets (tenant_id, ledger_account_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id RETURNING id`,
    [tenantId, accountId],
  );
  return w.rows[0]!.id;
}

export async function reserve(
  client: PoolClient,
  args: { tenantId: string; amountCents: number; sku: string; referenceType: string; referenceId: string },
): Promise<Hold | null> {
  if (args.amountCents === 0) return null; // free checks (sandbox, promos) need no hold
  const r = await client.query<{ id: string; available: string }>(
    `UPDATE wallets SET held_cents = held_cents + $2, updated_at = now()
      WHERE tenant_id = $1 AND status = 'active'
        AND balance_cents - held_cents + credit_limit_cents >= $2
      RETURNING id, (balance_cents - held_cents + credit_limit_cents) AS available`,
    [args.tenantId, args.amountCents],
  );
  const wallet = r.rows[0];
  if (!wallet) {
    const bal = await client.query<{ available: string }>(
      `SELECT balance_cents - held_cents + credit_limit_cents AS available FROM wallets WHERE tenant_id = $1`,
      [args.tenantId],
    );
    throw Errors.insufficientFunds(args.amountCents, Number(bal.rows[0]?.available ?? 0));
  }
  const h = await client.query<{ id: string }>(
    `INSERT INTO wallet_holds (wallet_id, tenant_id, amount_cents, sku, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [wallet.id, args.tenantId, args.amountCents, args.sku, args.referenceType, args.referenceId],
  );
  return { id: h.rows[0]!.id, walletId: wallet.id, amountCents: args.amountCents };
}

async function platformAccount(client: PoolClient, code: string): Promise<string> {
  const r = await client.query<{ id: string }>(`SELECT id FROM ledger_accounts WHERE tenant_id IS NULL AND code = $1`, [code]);
  if (!r.rows[0]) throw new Error(`platform ledger account ${code} missing`);
  return r.rows[0].id;
}

/**
 * Capture a hold. Idempotent: the ledger transaction's idempotency key is the
 * hold id, so a retried finaliser can never double-charge.
 * Returns the new available balance.
 */
export async function capture(client: PoolClient, tenantId: string, holdId: string, memo: string): Promise<{ captured: boolean; balanceCents: number }> {
  const h = await client.query<{ amount_cents: string; wallet_id: string; reference_type: string; reference_id: string }>(
    `UPDATE wallet_holds SET status = 'captured', settled_at = now()
      WHERE id = $1 AND status = 'active' RETURNING amount_cents, wallet_id, reference_type, reference_id`,
    [holdId],
  );
  const hold = h.rows[0];
  if (!hold) {
    const bal = await client.query<{ balance_cents: string }>(`SELECT balance_cents FROM wallets WHERE tenant_id = $1`, [tenantId]);
    return { captured: false, balanceCents: Number(bal.rows[0]?.balance_cents ?? 0) };
  }
  const amount = Number(hold.amount_cents);
  const w = await client.query<{ balance_cents: string; ledger_account_id: string }>(
    `UPDATE wallets SET held_cents = held_cents - $2, balance_cents = balance_cents - $2, updated_at = now()
      WHERE id = $1 RETURNING balance_cents, ledger_account_id`,
    [hold.wallet_id, amount],
  );
  const wallet = w.rows[0]!;
  const revenue = await platformAccount(client, 'revenue_usage');
  const tx = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (tenant_id, kind, reference_type, reference_id, idempotency_key, memo)
     VALUES ($1, 'usage_capture', $2, $3, $4, $5) RETURNING id`,
    [tenantId, hold.reference_type, hold.reference_id, `capture:${holdId}`, memo],
  );
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, tenant_id, amount_cents)
     VALUES ($1, $2, $4, $5), ($1, $3, $4, -$5)`,
    [tx.rows[0]!.id, wallet.ledger_account_id, revenue, tenantId, amount],
  );
  return { captured: true, balanceCents: Number(wallet.balance_cents) };
}

export async function release(client: PoolClient, holdId: string): Promise<boolean> {
  const h = await client.query<{ amount_cents: string; wallet_id: string }>(
    `UPDATE wallet_holds SET status = 'released', settled_at = now()
      WHERE id = $1 AND status = 'active' RETURNING amount_cents, wallet_id`,
    [holdId],
  );
  const hold = h.rows[0];
  if (!hold) return false;
  await client.query(`UPDATE wallets SET held_cents = held_cents - $2, updated_at = now() WHERE id = $1`, [hold.wallet_id, Number(hold.amount_cents)]);
  return true;
}

/** Credit the wallet (top-up settled by the payment provider, or promo credit). */
export async function credit(
  client: PoolClient,
  args: { tenantId: string; amountCents: number; kind: 'topup' | 'promo_credit' | 'refund'; idempotencyKey: string; memo?: string },
): Promise<number> {
  const walletId = await ensureWallet(client, args.tenantId);
  const dup = await client.query(`SELECT 1 FROM ledger_transactions WHERE idempotency_key = $1`, [args.idempotencyKey]);
  if (dup.rowCount) {
    const b = await client.query<{ balance_cents: string }>(`SELECT balance_cents FROM wallets WHERE id = $1`, [walletId]);
    return Number(b.rows[0]!.balance_cents);
  }
  const counter = await platformAccount(client, args.kind === 'promo_credit' ? 'promo_credit_expense' : 'cash_clearing');
  const w = await client.query<{ balance_cents: string; ledger_account_id: string }>(
    `UPDATE wallets SET balance_cents = balance_cents + $2, updated_at = now() WHERE id = $1 RETURNING balance_cents, ledger_account_id`,
    [walletId, args.amountCents],
  );
  const tx = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (tenant_id, kind, idempotency_key, memo) VALUES ($1, $2, $3, $4) RETURNING id`,
    [args.tenantId, args.kind, args.idempotencyKey, args.memo ?? null],
  );
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, tenant_id, amount_cents) VALUES ($1, $2, $4, $5), ($1, $3, $4, -$5)`,
    [tx.rows[0]!.id, counter, w.rows[0]!.ledger_account_id, args.tenantId, args.amountCents],
  );
  return Number(w.rows[0]!.balance_cents);
}

export async function availableBalance(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ available: string }>(
    `SELECT balance_cents - held_cents + credit_limit_cents AS available FROM wallets WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(r.rows[0]?.available ?? 0);
}

/** Price for a SKU today: tenant override first, then the public price book. */
export async function priceFor(client: PoolClient, tenantId: string, sku: string, environment: 'live' | 'test'): Promise<number> {
  if (environment === 'test') return 0; // sandbox keys are free and hit only the mock provider
  const r = await client.query<{ unit_price_cents: number }>(
    `SELECT unit_price_cents FROM (
        SELECT unit_price_cents, 0 AS pri FROM tenant_price_overrides
         WHERE tenant_id = $1 AND sku = $2 AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)
        UNION ALL
        SELECT unit_price_cents, 1 AS pri FROM price_book
         WHERE sku = $2 AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)
     ) p ORDER BY pri LIMIT 1`,
    [tenantId, sku],
  );
  if (!r.rows[0]) throw new Error(`no price for ${sku}`);
  return r.rows[0].unit_price_cents;
}
