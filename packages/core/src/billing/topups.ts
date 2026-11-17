import type { PoolClient } from 'pg';
import type { Config } from '../config';
import { credit } from './wallet';

/** South African VAT, charged on top of wallet credit (credit is VAT-exclusive). */
export const VAT_RATE = 0.15;

/**
 * Only a registered VAT vendor may charge VAT or issue tax invoices (VAT Act s7, s20). TshepoVet's
 * operator is registered exactly when SELLER_VAT_NUMBER is set (the owner, 2026-11-17: "We are not
 * VAT registered yet"); until then top-ups carry no VAT and their invoices are plain invoices.
 */
export const vatRegistered = (c: Pick<Config, 'SELLER_VAT_NUMBER'>): boolean => Boolean(c.SELLER_VAT_NUMBER);
export const vatRateFor = (c: Pick<Config, 'SELLER_VAT_NUMBER'>): number => (vatRegistered(c) ? VAT_RATE : 0);

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
 * and given an invoice number, all in the caller's tenant transaction. The real provider
 * (Paddle via the Cloud billing gateway) will create the pending row first and settle it from
 * its webhook; the credit and invoice steps stay the same. `vatRate` is vatRateFor(config): 0
 * while the operator is not a VAT vendor.
 */
export async function settleSandboxTopup(
  client: PoolClient,
  a: { tenantId: string; creditCents: number; requestedBy: string | null; reference: string; vatRate: number },
): Promise<TopupRecord> {
  const vat = Math.round(a.creditCents * a.vatRate);
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
