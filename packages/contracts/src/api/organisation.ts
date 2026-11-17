import { z } from 'zod';
import { ActorSchema, Cents, Timestamp, Uuid } from './common';
import { ModuleSchema } from './modules';

/** GET /api/meta: public facts the web app needs before anyone signs in (banner, pricing). */
export const MetaSchema = z.strictObject({
  sandbox: z.boolean(),
  currency: z.literal('ZAR'),
  vat_rate: z.number(),
  check_prices: z.strictObject({ company_cents: Cents, company_live_cents: Cents, driver_cents: Cents, monitoring_per_supplier_month_cents: Cents }),
  modules: z.array(ModuleSchema.pick({ sku: true, name: true, description: true, price_cents: true, available: true, unavailable_reason: true })),
  /** Whether TshepoVet's operator is a VAT vendor: if not, vat_rate is 0 and no VAT is charged. */
  vat_registered: z.boolean(),
  /** Who runs TshepoVet (ECTA s43, POPIA), for the footer, the terms and the privacy notice. null: not configured yet. */
  seller: z.strictObject({
    legal_name: z.string(),
    trading_name: z.string(),
    registration_number: z.string().nullable(),
    vat_number: z.string().nullable(),
    address: z.string().nullable(),
    directors: z.array(z.string()),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    website: z.string(),
    information_officer: z.string().nullable(),
    information_regulator_number: z.string().nullable(),
  }),
});

export const OverviewSchema = z.strictObject({
  checks_this_month: z.strictObject({
    total: z.number().int(),
    processing: z.number().int(),
    verified: z.number().int(),
    verified_with_warnings: z.number().int(),
    failed_checks: z.number().int(),
    not_found: z.number().int(),
    unable_to_verify: z.number().int(),
  }),
  /** Share of this month's finished checks that verified (with or without warnings). */
  verified_rate: z.number().nullable(),
  suppliers: z.strictObject({ total: z.number().int(), approved: z.number().int(), in_progress: z.number().int(), needs_attention: z.number().int() }),
  expiries_due_30d: z.number().int(),
  alerts: z.number().int(),
  wallet: z.strictObject({ balance_cents: Cents, held_cents: Cents, available_cents: Cents, low_balance: z.boolean() }),
  recent_checks: z.array(
    z.strictObject({
      id: Uuid,
      type: z.string(),
      subject: z.string(),
      supplier_name: z.string().nullable(),
      status: z.string(),
      outcome: z.string().nullable(),
      requested_at: Timestamp,
    }),
  ),
  /** Empty for roles without the audit log. */
  recent_activity: z.array(z.strictObject({ id: z.number().int(), occurred_at: Timestamp, actor: ActorSchema, action: z.string(), entity_type: z.string() })),
});

export const PreferencesSchema = z.strictObject({
  require_consent_for_all_checks: z.boolean(),
  notify_low_balance: z.boolean(),
  notify_expiries: z.boolean(),
  expiry_reminder_days: z.array(z.number().int()),
});

export const SettingsSchema = z.strictObject({
  organisation: z.strictObject({
    id: Uuid,
    legal_name: z.string(),
    registration_number: z.string().nullable(),
    vat_number: z.string().nullable(),
    information_officer_email: z.string().nullable(),
    is_public_sector: z.boolean(),
    data_region: z.string(),
    status: z.string(),
    created_at: Timestamp,
  }),
  preferences: PreferencesSchema,
});

export const UpdateSettingsSchema = z
  .object({
    organisation: z
      .object({
        legal_name: z.string().trim().min(2).max(160).optional(),
        registration_number: z
          .string()
          .trim()
          .regex(/^\d{4}\/\d{6}\/\d{2}$/, 'Use the CIPC format, for example 2019/123456/07.')
          .nullable()
          .optional(),
        vat_number: z.string().trim().regex(/^4\d{9}$/, 'SA VAT numbers are 10 digits starting with 4.').nullable().optional(),
        information_officer_email: z.email('Enter a valid email address.').max(254).nullable().optional(),
        is_public_sector: z.boolean().optional(),
      })
      .strict()
      .optional(),
    preferences: z
      .object({
        require_consent_for_all_checks: z.boolean().optional(),
        notify_low_balance: z.boolean().optional(),
        notify_expiries: z.boolean().optional(),
        expiry_reminder_days: z.array(z.number().int().min(0).max(120)).max(6).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => b.organisation || b.preferences, { message: 'Nothing to change.' });
