import { z } from 'zod';
import { Cents, ListQuerySchema, pageSchema, Timestamp, Uuid } from './common';

export const LEDGER_KINDS = ['topup', 'usage_capture', 'refund', 'adjustment', 'subscription_charge', 'monitoring_charge', 'promo_credit'] as const;

export const WalletSchema = z.strictObject({
  currency: z.literal('ZAR'),
  balance_cents: Cents,
  held_cents: Cents,
  available_cents: Cents,
  credit_limit_cents: Cents,
  low_balance_threshold_cents: Cents,
  low_balance: z.boolean(),
  status: z.enum(['active', 'frozen']),
  sandbox: z.boolean(),
});

export const UpdateWalletSchema = z
  .object({ low_balance_threshold_cents: z.number().int().min(0).max(100_000_000) })
  .strict();

export const HoldSchema = z.strictObject({
  id: Uuid,
  sku: z.string(),
  amount_cents: Cents,
  reference_type: z.string(),
  reference_id: Uuid,
  created_at: Timestamp,
  expires_at: Timestamp,
});

export const LedgerQuerySchema = ListQuerySchema.extend({
  kind: z.enum(LEDGER_KINDS).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

/** One movement of the wallet: positive adds credit, negative spends it. */
export const LedgerItemSchema = z.strictObject({
  id: Uuid,
  kind: z.enum(LEDGER_KINDS),
  memo: z.string().nullable(),
  reference_type: z.string().nullable(),
  reference_id: Uuid.nullable(),
  amount_cents: Cents,
  created_at: Timestamp,
});
export const LedgerPageSchema = pageSchema(LedgerItemSchema);

/** A sandbox top-up: the credit (VAT-exclusive) the wallet receives. R100 to R100 000. */
export const TopupRequestSchema = z
  .object({
    credit_cents: z
      .number()
      .int()
      .min(10_000, 'The smallest top-up is R100.')
      .max(10_000_000, 'The largest top-up is R100 000.'),
  })
  .strict();

export const TopupSchema = z.strictObject({
  id: Uuid,
  credit_cents: Cents,
  vat_cents: Cents,
  gross_cents: Cents,
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']),
  payment_provider: z.string(),
  tax_invoice_number: z.string().nullable(),
  created_at: Timestamp,
});
export const TopupPageSchema = pageSchema(TopupSchema);
export const TopupResultSchema = z.strictObject({ topup: TopupSchema, balance_cents: Cents });
