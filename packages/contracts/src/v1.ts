import { LICENCE_CODES, PRDP_CATEGORIES } from './domain';
import { z } from 'zod';

/**
 * Request bodies of the public /v1 API (API keys). openapi/openapi.yaml documents them, and
 * test/openapi-contract.test.ts keeps the two in step. Changing a schema here changes a public
 * contract: add fields, never repurpose or remove them.
 */
export const PURPOSES = [
  'kyb_company_verification',
  'director_identity_verification',
  'tax_compliance_verification',
  'driver_licence_verification',
  'continuous_monitoring',
] as const;

export const ConsentAttestationSchema = z.object({
  notice_code: z.enum(['company_verification', 'driver_verification']),
  subject_display: z.string().min(1).max(120),
  subject_role: z.enum(['vendor_entity', 'authorised_representative', 'director', 'driver', 'sole_proprietor']),
  on_behalf_of_subject: z.boolean().default(false),
  purposes: z.array(z.enum(PURPOSES)).min(1),
  captured_at: z.string().datetime({ offset: true }),
  evidence_reference: z.string().min(1).max(200),
  attested_by: z.string().min(1).max(200),
});
export type ConsentAttestation = z.infer<typeof ConsentAttestationSchema>;

const freshness = z.enum(['cached_ok', 'live']).default('cached_ok');
const mode = z.enum(['sync', 'async']).default('sync');

export const CompanyRequestSchema = z
  .object({
    registration_number: z.string().min(10).max(20),
    vat_number: z.string().max(14).optional(),
    tax_reference_number: z.string().max(14).optional(),
    tcs_pin: z.string().max(30).optional(),
    checks: z.array(z.enum(['registration', 'directors', 'vat', 'tcs'])).min(1).default(['registration', 'directors']),
    external_ref: z.string().max(100).optional(),
    consent_id: z.string().uuid().optional(),
    consent: ConsentAttestationSchema.optional(),
    freshness,
    max_age_seconds: z.number().int().min(60).max(30 * 86_400).optional(),
    mode,
    monitor: z.boolean().default(false),
  })
  .strict();
export type CompanyRequest = z.infer<typeof CompanyRequestSchema>;

export const DriverRequestSchema = z
  .object({
    id_number: z.string().min(13).max(15),
    licence_number: z.string().regex(/^[A-Za-z0-9]{6,20}$/).optional(),
    surname: z.string().min(1).max(80).optional(),
    required_codes: z.array(z.enum(LICENCE_CODES)).default([]),
    required_prdp: z.array(z.enum(PRDP_CATEGORIES)).default([]),
    vendor_id: z.string().uuid().optional(),
    external_ref: z.string().max(100).optional(),
    consent_id: z.string().uuid().optional(),
    consent: ConsentAttestationSchema.optional(),
    freshness,
    mode,
    monitor: z.boolean().default(false),
  })
  .strict();
export type DriverRequest = z.infer<typeof DriverRequestSchema>;
