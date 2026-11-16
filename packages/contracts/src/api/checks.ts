import { LICENCE_CODES, PRDP_CATEGORIES } from '../domain';
import { z } from 'zod';
import { ActorSchema, Cents, ListQuerySchema, pageSchema, PortalConsentSchema, Timestamp, Uuid } from './common';

export const CHECK_TYPES = ['company', 'driver_licence'] as const;
export const CHECK_STATUSES = ['processing', 'completed', 'failed'] as const;
export const CHECK_OUTCOMES = ['verified', 'verified_with_warnings', 'failed_checks', 'not_found', 'unable_to_verify'] as const;
export const COMPANY_CHECKS = ['registration', 'directors', 'vat', 'tcs'] as const;

/** A company check run from the portal. Consent is ticked by the user when it is needed:
 *  for a tax compliance (TCS) check, for monitoring, or when the organisation requires it. */
export const PortalCompanyCheckSchema = z
  .object({
    registration_number: z.string().trim().min(10, 'Enter the CIPC registration number, for example 2019/123456/07.').max(20),
    vat_number: z.string().trim().max(14).optional(),
    tax_reference_number: z.string().trim().max(14).optional(),
    tcs_pin: z.string().trim().max(30).optional(),
    checks: z.array(z.enum(COMPANY_CHECKS)).min(1).default(['registration', 'directors']),
    freshness: z.enum(['cached_ok', 'live']).default('cached_ok'),
    monitor: z.boolean().default(false),
    external_ref: z.string().trim().min(1).max(100).optional(),
    consent: PortalConsentSchema.optional(),
  })
  .strict();
export type PortalCompanyCheck = z.infer<typeof PortalCompanyCheckSchema>;

/** A driver's licence / PrDP check. The driver's consent is always required. */
export const PortalDriverCheckSchema = z
  .object({
    id_number: z.string().trim().min(13).max(15),
    licence_number: z.string().trim().regex(/^[A-Za-z0-9]{6,20}$/, 'Licence numbers are 6 to 20 letters and digits.').optional(),
    surname: z.string().trim().min(1).max(80).optional(),
    required_codes: z.array(z.enum(LICENCE_CODES)).default([]),
    required_prdp: z.array(z.enum(PRDP_CATEGORIES)).default([]),
    supplier_id: Uuid.optional(),
    external_ref: z.string().trim().min(1).max(100).optional(),
    consent: PortalConsentSchema.extend({ on_behalf_of_subject: z.boolean().default(true) }),
  })
  .strict();
export type PortalDriverCheck = z.infer<typeof PortalDriverCheckSchema>;

export const CheckListQuerySchema = ListQuerySchema.extend({
  type: z.enum(CHECK_TYPES).optional(),
  status: z.enum(CHECK_STATUSES).optional(),
  outcome: z.enum(CHECK_OUTCOMES).optional(),
  supplier_id: Uuid.optional(),
});
export const CHECK_SORTS = ['requested_at', 'completed_at', 'outcome', 'price_cents'] as const;

export const CheckListItemSchema = z.strictObject({
  id: Uuid,
  type: z.enum(CHECK_TYPES),
  subject: z.string(),
  supplier_id: Uuid.nullable(),
  supplier_name: z.string().nullable(),
  status: z.enum(CHECK_STATUSES),
  outcome: z.enum(CHECK_OUTCOMES).nullable(),
  risk_flags: z.array(z.string()),
  price_cents: Cents,
  charged: z.boolean(),
  requested_by: ActorSchema,
  requested_at: Timestamp,
  completed_at: Timestamp.nullable(),
});
export const CheckPageSchema = pageSchema(CheckListItemSchema);

/** One check in full: the /v1 verification object plus where it sits in the portal. */
export const PortalVerificationSchema = z.strictObject({
  id: Uuid,
  object: z.literal('verification'),
  type: z.enum(CHECK_TYPES),
  status: z.enum(CHECK_STATUSES),
  outcome: z.enum(CHECK_OUTCOMES).nullable(),
  vendor_id: Uuid.nullable(),
  external_ref: z.string().nullable(),
  subject: z.string(),
  checks: z.record(z.string(), z.unknown()),
  risk_flags: z.array(z.string()),
  billing: z.strictObject({
    sku: z.string(),
    price_cents: Cents,
    currency: z.literal('ZAR'),
    vat_exclusive: z.literal(true),
    charged: z.boolean(),
    wallet_balance_cents: Cents.optional(),
  }),
  requested_at: Timestamp,
  completed_at: Timestamp.nullable(),
  supplier_id: Uuid.nullable(),
  supplier_name: z.string().nullable(),
  requested_by: ActorSchema,
});
export type PortalVerification = z.infer<typeof PortalVerificationSchema>;

export const CheckPricesSchema = z.strictObject({
  company: z.strictObject({ sku: z.string(), price_cents: Cents }),
  company_live: z.strictObject({ sku: z.string(), price_cents: Cents }),
  driver: z.strictObject({ sku: z.string(), price_cents: Cents }),
  available_cents: Cents,
  sandbox: z.boolean(),
  consent_always_required: z.boolean(),
});
