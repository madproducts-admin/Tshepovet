import { z } from 'zod';
import { ActorSchema, ListQuerySchema, pageSchema, Timestamp, Uuid } from './common';

export const CONSENT_PURPOSES = [
  'kyb_company_verification',
  'director_identity_verification',
  'tax_compliance_verification',
  'driver_licence_verification',
  'bbbee_verification',
  'bank_account_verification',
  'continuous_monitoring',
  'passport_sharing',
  'conflict_of_interest_screening',
  'document_ocr_processing',
  'cross_border_processing',
  'whatsapp_service_messages',
  'direct_marketing',
] as const;

export const ConsentListQuerySchema = ListQuerySchema.extend({
  supplier_id: Uuid.optional(),
  purpose: z.enum(CONSENT_PURPOSES).optional(),
  state: z.enum(['active', 'withdrawn']).optional(),
});

export const ConsentSchema = z.strictObject({
  id: Uuid,
  supplier_id: Uuid.nullable(),
  supplier_name: z.string().nullable(),
  subject_display: z.string(),
  subject_type: z.string(),
  subject_role: z.string(),
  on_behalf_of_subject: z.boolean(),
  capture_method: z.string(),
  notice: z.strictObject({ id: Uuid, code: z.string(), version: z.number().int(), channel: z.string() }),
  captured_by: ActorSchema.nullable(),
  granted_at: Timestamp,
  expires_at: Timestamp.nullable(),
  purposes: z.array(z.strictObject({ purpose: z.string(), lawful_basis: z.string(), special_pi_basis: z.string().nullable(), withdrawn_at: Timestamp.nullable() })),
});
export const ConsentPageSchema = pageSchema(ConsentSchema);

export const WithdrawConsentSchema = z
  .object({
    /** Omit to withdraw every purpose. */
    purposes: z.array(z.enum(CONSENT_PURPOSES)).min(1).optional(),
    channel: z.enum(['email', 'phone', 'letter', 'in_person', 'portal']).default('portal'),
  })
  .strict();

export const NoticeSchema = z.strictObject({
  id: Uuid,
  code: z.string(),
  version: z.number().int(),
  language: z.string(),
  channel: z.string(),
  body: z.string(),
  effective_from: Timestamp,
  retired_at: Timestamp.nullable(),
});

export const DSR_TYPES = ['access', 'correction', 'deletion', 'objection', 'withdraw_consent', 'restrict'] as const;
export const DSR_STATUSES = ['received', 'verifying', 'in_progress', 'completed', 'refused', 'escalated_to_ir'] as const;

export const DsrListQuerySchema = ListQuerySchema.extend({ status: z.enum(DSR_STATUSES).optional(), open: z.enum(['true', 'false']).optional() });

export const DsrSchema = z.strictObject({
  id: Uuid,
  request_type: z.enum(DSR_TYPES),
  requester_display: z.string(),
  supplier_id: Uuid.nullable(),
  supplier_name: z.string().nullable(),
  identity_verified: z.boolean(),
  status: z.enum(DSR_STATUSES),
  received_at: Timestamp,
  due_at: Timestamp,
  completed_at: Timestamp.nullable(),
  outcome_notes: z.string().nullable(),
  /** Whole days until due (negative once overdue); null once closed. */
  days_left: z.number().int().nullable(),
});
export const DsrPageSchema = pageSchema(DsrSchema);

export const CreateDsrSchema = z
  .object({
    request_type: z.enum(DSR_TYPES),
    requester_display: z.string().trim().min(1).max(120),
    supplier_id: Uuid.optional(),
    received_on: z.iso.date().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const UpdateDsrSchema = z
  .object({
    status: z.enum(DSR_STATUSES).optional(),
    identity_verified: z.boolean().optional(),
    outcome_notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' })
  .refine((b) => !(b.status && ['completed', 'refused'].includes(b.status)) || Boolean(b.outcome_notes), {
    message: 'Record what was done before closing the request.',
    path: ['outcome_notes'],
  });

export const AuditQuerySchema = z.object({
  action: z.string().trim().max(80).optional(),
  actor_type: z.enum(['user', 'api_key', 'system', 'vendor_contact', 'tshepovet_staff']).optional(),
  entity_type: z.string().trim().max(40).optional(),
  entity_id: z.string().trim().max(80).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  before_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ChainVerificationSchema = z.strictObject({
  intact: z.boolean(),
  entries_checked: z.number().int(),
  broken_at_sequence: z.number().int().nullable(),
  checked_at: Timestamp,
});

export const ProcessingActivitySchema = z.strictObject({
  code: z.string(),
  description: z.string(),
  purpose: z.string(),
  lawful_basis: z.string(),
  data_categories: z.array(z.string()),
  special_pi: z.boolean(),
  cross_border: z.boolean(),
  retention_days: z.number().int().nullable(),
});
