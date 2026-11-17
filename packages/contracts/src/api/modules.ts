import { z } from 'zod';
import { Cents, Day, Timestamp, Uuid } from './common';

export const MODULES = [
  { sku: 'MOD_BBBEE', name: 'B-BBEE spend and scorecard', description: 'Records procurement spend per supplier and works out recognised spend from each supplier’s verified B-BBEE level.' },
  { sku: 'MOD_COI_RADAR', name: 'Conflict-of-interest radar', description: 'Matches staff records against supplier directors, owners and bank accounts to find undeclared interests and ghost suppliers.' },
  { sku: 'MOD_CONSTRUCTION', name: 'Construction add-on', description: 'COIDA letters of good standing and CIDB grading for construction suppliers.' },
  { sku: 'MOD_LOGISTICS', name: 'Logistics add-on', description: 'Driver’s licence and PrDP checks for drivers on your contracts.' },
] as const;
export const MODULE_SKU_LIST = MODULES.map((m) => m.sku) as unknown as readonly ['MOD_BBBEE', 'MOD_COI_RADAR', 'MOD_CONSTRUCTION', 'MOD_LOGISTICS'];
export const ModuleSkuSchema = z.enum(['MOD_BBBEE', 'MOD_COI_RADAR', 'MOD_CONSTRUCTION', 'MOD_LOGISTICS']);

export const ModuleSchema = z.strictObject({
  sku: ModuleSkuSchema,
  name: z.string(),
  description: z.string(),
  price_cents: Cents,
  /** off: not subscribed; on: in effect; ending: on until current_period_end, then off. */
  state: z.enum(['off', 'on', 'ending']),
  available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  current_period_end: Day.nullable(),
});

export const ModuleChangeSchema = z.strictObject({ module: ModuleSchema, charged_cents: Cents });

// --- B-BBEE spend and scorecard -------------------------------------------------------------
export const PeriodQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to".' });

export const SpendLineInputSchema = z
  .object({
    supplier_id: Uuid,
    period_start: z.iso.date(),
    period_end: z.iso.date(),
    amount_cents: z.number().int().min(1).max(1_000_000_000_000),
    description: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((l) => l.period_start <= l.period_end, { message: 'The period must not end before it starts.', path: ['period_end'] });

export const AddSpendSchema = z.object({ lines: z.array(SpendLineInputSchema).min(1).max(500) }).strict();

export const SpendLineSchema = z.strictObject({
  id: Uuid,
  supplier_id: Uuid,
  legal_name: z.string(),
  period_start: Day,
  period_end: Day,
  amount_cents: Cents,
  description: z.string().nullable(),
  created_at: Timestamp,
});

export const ScorecardSchema = z.strictObject({
  period: z.strictObject({ from: Day, to: Day }),
  total_measured_spend_cents: Cents,
  recognised_spend_cents: Cents,
  /** Spend with suppliers whose B-BBEE evidence is missing, unaccepted or expired. */
  unverified_spend_cents: Cents,
  eme_spend_cents: Cents,
  qse_spend_cents: Cents,
  black_owned_51_spend_cents: Cents,
  black_women_owned_30_spend_cents: Cents,
  empowering_supplier_spend_cents: Cents,
  by_level: z.array(z.strictObject({ level: z.number().int().nullable(), suppliers: z.number().int(), spend_cents: Cents, recognised_cents: Cents })),
  suppliers: z.array(
    z.strictObject({
      supplier_id: Uuid,
      legal_name: z.string(),
      level: z.number().int().nullable(),
      recognition_pct: z.number(),
      spend_cents: Cents,
      recognised_cents: Cents,
      valid_until: Day.nullable(),
      flags: z.array(z.enum(['no_evidence', 'evidence_expired', 'evidence_not_accepted'])),
    }),
  ),
});
