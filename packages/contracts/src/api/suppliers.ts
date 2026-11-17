import { z } from 'zod';
import { ActorSchema, Cents, Day, ListQuerySchema, pageSchema, QueryBool, Timestamp, Uuid } from './common';

export const SUPPLIER_STATUSES = ['invited', 'onboarding', 'pending_review', 'approved', 'rejected', 'suspended', 'offboarded'] as const;
export const RISK_RATINGS = ['low', 'medium', 'high', 'critical'] as const;
export const INDUSTRY_PROFILES = ['general', 'construction', 'logistics'] as const;
export const PAYMENT_LOCK_STATUSES = ['unlocked', 'locked', 'override'] as const;

/** Statuses a portal user may set (invited and onboarding are the onboarding flow's). */
export const SETTABLE_SUPPLIER_STATUSES = ['pending_review', 'approved', 'rejected', 'suspended', 'offboarded'] as const;

export const SupplierListQuerySchema = ListQuerySchema.extend({
  status: z.enum(SUPPLIER_STATUSES).optional(),
  risk: z.enum(RISK_RATINGS).optional(),
  monitored: QueryBool.optional(),
});
export type SupplierListQuery = z.infer<typeof SupplierListQuerySchema>;
export const SUPPLIER_SORTS = ['legal_name', 'status', 'risk_rating', 'last_verified_at', 'next_expiry_on', 'created_at'] as const;

export const SupplierListItemSchema = z.strictObject({
  id: Uuid, // the relationship (tenant_vendors) id: the supplier as this organisation knows it
  vendor_id: Uuid,
  legal_name: z.string(),
  trading_name: z.string().nullable(),
  registration_number: z.string().nullable(),
  entity_kind: z.string(),
  status: z.enum(SUPPLIER_STATUSES),
  risk_rating: z.enum(RISK_RATINGS).nullable(),
  external_ref: z.string().nullable(),
  cipc_status: z.string().nullable(),
  passport_status: z.string(),
  last_verified_at: Timestamp.nullable(),
  last_outcome: z.string().nullable(),
  monitored: z.boolean(),
  payment_lock_status: z.enum(PAYMENT_LOCK_STATUSES),
  next_expiry_on: Day.nullable(),
  created_at: Timestamp,
});
export type SupplierListItem = z.infer<typeof SupplierListItemSchema>;
export const SupplierPageSchema = pageSchema(SupplierListItemSchema);

export const AddSupplierSchema = z
  .object({
    registration_number: z.string().trim().min(10, 'Enter the CIPC registration number, for example 2019/123456/07.').max(20),
    external_ref: z.string().trim().min(1).max(100).optional(),
    industry_profile: z.enum(INDUSTRY_PROFILES).optional(),
  })
  .strict();

export const UpdateSupplierSchema = z
  .object({
    external_ref: z.string().trim().min(1).max(100).nullable().optional(),
    risk_rating: z.enum(RISK_RATINGS).nullable().optional(),
    industry_profile: z.enum(INDUSTRY_PROFILES).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });

export const SupplierStatusChangeSchema = z
  .object({
    status: z.enum(SETTABLE_SUPPLIER_STATUSES),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => !['rejected', 'suspended', 'offboarded'].includes(b.status) || Boolean(b.reason), {
    message: 'Give a reason: it is kept in the audit log.',
    path: ['reason'],
  });

const CheckSummarySchema = z.strictObject({
  id: Uuid,
  type: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  risk_flags: z.array(z.string()),
  price_cents: Cents,
  charged: z.boolean(),
  requested_at: Timestamp,
  completed_at: Timestamp.nullable(),
});

export const SupplierDetailSchema = z.strictObject({
  relationship: z.strictObject({
    id: Uuid,
    status: z.enum(SUPPLIER_STATUSES),
    risk_rating: z.enum(RISK_RATINGS).nullable(),
    external_ref: z.string().nullable(),
    industry_profile: z.enum(INDUSTRY_PROFILES).nullable(),
    onboarding_channel: z.string(),
    approved_at: Timestamp.nullable(),
    approved_by: z.string().nullable(),
    payment_lock_status: z.enum(PAYMENT_LOCK_STATUSES),
    payment_lock_reason: z.string().nullable(),
    relationship_ended_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  }),
  vendor: z.strictObject({
    id: Uuid,
    legal_name: z.string(),
    trading_name: z.string().nullable(),
    entity_kind: z.string(),
    registration_number: z.string().nullable(),
    cipc_status: z.string().nullable(),
    cipc_status_raw: z.string().nullable(),
    incorporation_date: Day.nullable(),
    annual_return_due_date: Day.nullable(),
    vat_number: z.string().nullable(),
    csd_supplier_number: z.string().nullable(),
    passport_status: z.string(),
    passport_last_verified_at: Timestamp.nullable(),
  }),
  directors: z.array(
    z.strictObject({ full_name: z.string(), role: z.string(), status: z.string(), appointed_on: Day.nullable(), resigned_on: Day.nullable(), as_of: Timestamp }),
  ),
  beneficial_owners: z.array(
    z.strictObject({ full_name: z.string(), ownership_pct: z.number().nullable(), control_type: z.string().nullable(), source: z.string(), declared_at: Timestamp }),
  ),
  bank_accounts: z.array(
    z.strictObject({
      bank_name: z.string(),
      account_type: z.string().nullable(),
      account_last4: z.string(),
      avs_status: z.string().nullable(),
      avs_checked_at: Timestamp.nullable(),
    }),
  ),
  bbbee: z
    .strictObject({
      level: z.number().int().nullable(),
      procurement_recognition_pct: z.number().nullable(),
      evidence_type: z.string(),
      issued_on: Day,
      valid_until: Day,
      status: z.string(),
      is_empowering_supplier: z.boolean().nullable(),
      /** Special personal information (POPIA s26): only for users allowed to see it. */
      ownership: z
        .strictObject({
          black_ownership_pct: z.number().nullable(),
          black_female_ownership_pct: z.number().nullable(),
          designated_group_ownership_pct: z.number().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  credentials: z.array(
    z.strictObject({
      id: Uuid,
      credential_type: z.string(),
      holder_display: z.string().nullable(),
      reference_number: z.string().nullable(),
      issuer: z.string().nullable(),
      status: z.string(),
      valid_until: Day.nullable(),
      verified_at: Timestamp.nullable(),
    }),
  ),
  documents: z.array(
    z.strictObject({
      id: Uuid,
      document_type: z.string(),
      document_name: z.string(),
      review_status: z.string(),
      source_channel: z.string(),
      issued_on: Day.nullable(),
      expires_on: Day.nullable(),
      image_available: z.boolean(),
      created_at: Timestamp,
    }),
  ),
  monitoring: z.strictObject({
    enrolled: z.boolean(),
    since: Timestamp.nullable(),
    erp_lock_enabled: z.boolean(),
    schedules: z.array(
      z.strictObject({
        id: Uuid,
        subject_type: z.string(),
        expires_on: Day,
        grace_until: Day.nullable(),
        state: z.string(),
        next_action: z.string().nullable(),
        next_action_at: Timestamp.nullable(),
      }),
    ),
  }),
  checks: z.array(CheckSummarySchema),
  permissions: z.strictObject({ can_view_special_pi: z.boolean() }),
});
export type SupplierDetail = z.infer<typeof SupplierDetailSchema>;

export const AuditEntrySchema = z.strictObject({
  id: z.number().int(),
  occurred_at: Timestamp,
  actor: ActorSchema,
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  request_id: z.string().nullable(),
  ip: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditListSchema = z.strictObject({ items: z.array(AuditEntrySchema), next_before_id: z.number().int().nullable() });

// --- Saved views -------------------------------------------------------------------------
export const SAVED_VIEW_SCOPES = ['suppliers', 'checks'] as const;
export const SavedViewSchema = z.strictObject({
  id: Uuid,
  scope: z.enum(SAVED_VIEW_SCOPES),
  name: z.string(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  created_at: Timestamp,
});
export const CreateSavedViewSchema = z
  .object({
    scope: z.enum(SAVED_VIEW_SCOPES),
    name: z.string().trim().min(1).max(60),
    query: z.record(z.string().max(40), z.union([z.string().max(100), z.number(), z.boolean()])).refine((q) => Object.keys(q).length <= 12, 'Too many filters.'),
  })
  .strict();
