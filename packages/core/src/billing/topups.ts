import type { PoolClient } from 'pg';
import { credit } from './wallet';

/** South African VAT, charged on top of wallet credit (credit is VAT-exclusive). */
export const VAT_RATE = 0.15;

export interface TopupRecord {
  id: string;
  credit_cents: number;
  vat_cents: number;
  gross_cents: number;
  status: string;
  tax_invoice_number: string | null;
  payment_provider: string;
  created_at: Date;
  balance_cents: number;
}

/**
 * A top-up settled by the sandbox payment stand-in (docs/PLAN.md §6): recorded, credited
 * through the same ledger path a real payment would use (Dr cash_clearing / Cr the wallet),
 * and given a tax invoice number, all in the caller's tenant transaction. The real provider
 * (Paddle via the Cloud billing gateway) will create the pending row first and settle it from
 * its webhook; the credit and invoice steps stay the same.
 */
export async function settleSandboxTopup(
  client: PoolClient,
  a: { tenantId: string; creditCents: number; requestedBy: string | null; reference: string },
): Promise<TopupRecord> {
  const vat = Math.round(a.creditCents * VAT_RATE);
  const t = await client.query<{ id: string }>(
    `INSERT INTO wallet_topups (tenant_id, payment_provider, provider_reference, gross_cents, vat_cents, credit_cents, status, requested_by)
     VALUES ($1, 'sandbox', $2, $3, $4, $5, 'pending', $6) RETURNING id`,
    [a.tenantId, a.reference, a.creditCents + vat, vat, a.creditCents, a.requestedBy],
  );
  const id = t.rows[0]!.id;
  // Namespaced: the key is unique across tenants, and RLS hides other tenants' keys.
  const key = `topup:${id}`;
  const balance = await credit(client, { tenantId: a.tenantId, amountCents: a.creditCents, kind: 'topup', idempotencyKey: key, memo: 'Sandbox top-up' });
  const tx = await client.query<{ id: string }>(`SELECT id FROM ledger_transactions WHERE idempotency_key = $1`, [key]);
  const r = await client.query<Omit<TopupRecord, 'balance_cents'>>(
    `UPDATE wallet_topups
        SET status = 'succeeded', ledger_transaction_id = $2,
            tax_invoice_number = 'TV-' || lpad(nextval('tax_invoice_seq')::text, 6, '0')
      WHERE id = $1
      RETURNING id, credit_cents, vat_cents, gross_cents, status, tax_invoice_number, payment_provider, created_at`,
    [id, tx.rows[0]!.id],
  );
  return { ...r.rows[0]!, balance_cents: balance };
}
