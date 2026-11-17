import { z } from 'zod';
import { Cents, Day, ListQuerySchema, pageSchema, Timestamp, Uuid } from './common';

/**
 * The staff console (/api/staff, docs/PLAN.md M8): TshepoVet's own people, with separate
 * accounts and mandatory two-step verification. Roles:
 *   support   tenants and users, data-subject requests, the mail outbox, the WhatsApp simulator
 *   reviewer  the review queue, the WhatsApp simulator
 *   admin     everything, including suspending a tenant, bureaus and prices, purge runs
 */
export const STAFF_ROLES = ['support', 'reviewer', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const Count = z.number().int();

export const StaffOverviewSchema = z.strictObject({
  sandbox: z.boolean(),
  review: z.strictObject({ documents: Count, handoffs: Count }),
  requests: z.strictObject({ open: Count, due_within_7_days: Count, overdue: Count }),
  tenants: z.strictObject({ active: Count, suspended: Count }),
  verifications: z.strictObject({ processing: Count, last_24h: Count, failed_24h: Count }),
  mail: z.strictObject({ held: Count, queued: Count }),
  last_purge_at: Timestamp.nullable(),
});

// --- The review queue ----------------------------------------------------------------------
export const ReviewDocumentSchema = z.strictObject({
  id: Uuid,
  tenant: z.string().nullable(),
  supplier: z.string(),
  document_type: z.string(),
  document_name: z.string(),
  source: z.string(),
  flags: z.array(z.string()),
  level: z.number().int().nullable(),
  created_at: Timestamp,
});
export const ReviewHandoffSchema = z.strictObject({
  id: Uuid,
  tenant: z.string(),
  supplier: z.string().nullable(),
  reason: z.string().nullable(),
  since: Timestamp,
});
export const ReviewQueueSchema = z.strictObject({ documents: z.array(ReviewDocumentSchema), handoffs: z.array(ReviewHandoffSchema) });
export const ReviewDecisionSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    note: z.string().trim().min(1, 'Say why: the buyer sees it in the supplier’s record.').max(500),
  })
  .strict();

// --- Tenants and users ----------------------------------------------------------------------
export const TENANT_STATUSES = ['active', 'suspended', 'closed'] as const;
export const StaffTenantQuerySchema = ListQuerySchema.extend({ status: z.enum(TENANT_STATUSES).optional() });
export const StaffTenantListItemSchema = z.strictObject({
  id: Uuid,
  legal_name: z.string(),
  status: z.enum(TENANT_STATUSES),
  users: Count,
  suppliers: Count,
  balance_cents: Cents,
  created_at: Timestamp,
});
export const StaffTenantPageSchema = pageSchema(StaffTenantListItemSchema);
export const StaffTenantSchema = z.strictObject({
  id: Uuid,
  legal_name: z.string(),
  status: z.enum(TENANT_STATUSES),
  created_at: Timestamp,
  balance_cents: Cents,
  held_cents: Cents,
  counts: z.strictObject({ suppliers: Count, monitored: Count, verifications_30d: Count }),
  users: z.array(
    z.strictObject({
      id: Uuid,
      full_name: z.string(),
      email: z.string(),
      role: z.string(),
      mfa_enrolled: z.boolean(),
      locked_until: Timestamp.nullable(),
      disabled: z.boolean(),
      last_login_at: Timestamp.nullable(),
    }),
  ),
  recent_activity: z.array(z.strictObject({ action: z.string(), actor_type: z.string(), occurred_at: Timestamp })),
});
export const TenantStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended']),
    reason: z.string().trim().min(1, 'Give a reason: it is kept in the tenant’s audit log.').max(500),
  })
  .strict();

// --- Data-subject requests across tenants ---------------------------------------------------
export const StaffRequestSchema = z.strictObject({
  id: Uuid,
  tenant: z.string(),
  supplier: z.string().nullable(),
  request_type: z.string(),
  status: z.string(),
  received_at: Timestamp,
  due_at: Timestamp,
  days_left: z.number().int(),
});

// --- Retention purge and the audit chain ----------------------------------------------------
export const PurgeRunSchema = z.strictObject({
  id: z.union([Uuid, z.number().int()]),
  started_at: Timestamp,
  finished_at: Timestamp.nullable(),
  counts: z.record(z.string(), z.number()),
});

// --- Bureaus and prices ---------------------------------------------------------------------
export const StaffProviderSchema = z.strictObject({
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  operator_agreement_signed_on: Day.nullable(),
  capabilities: z.array(
    z.strictObject({
      capability: z.string(),
      unit_cost_cents: Cents,
      is_live_source: z.boolean(),
      timeout_ms: z.number().int(),
      enabled: z.boolean(),
      health: z.strictObject({ circuit: z.enum(['closed', 'open', 'half_open']), success_rate: z.number(), latency_ms: z.number(), samples: Count }),
    }),
  ),
});
export const CapabilityUpdateSchema = z.object({ enabled: z.boolean() }).strict();
export const PriceSchema = z.strictObject({
  sku: z.string(),
  description: z.string(),
  billing_type: z.string(),
  unit_price_cents: Cents,
  effective_from: Day,
  effective_to: Day.nullable(),
});
export const NewPriceSchema = z
  .object({
    sku: z.string().trim().min(2).max(40),
    unit_price_cents: z.number().int().min(0).max(100_000_000),
    effective_from: Day,
  })
  .strict();

// --- The WhatsApp simulator (sandbox only) --------------------------------------------------
export const WaConversationSchema = z.strictObject({
  id: Uuid,
  tenant: z.string(),
  number: z.string(),
  state: z.string(),
  updated_at: Timestamp,
  expires_at: Timestamp,
});
export const WaTenantSchema = z.strictObject({ id: Uuid, legal_name: z.string() });
export const WaStartSchema = z
  .object({
    tenant_id: Uuid,
    number: z.string().trim().regex(/^27[6-8]\d{8}$/, 'A South African mobile number in international form, like 27821234567.'),
  })
  .strict();
export const WaMessageSchema = z.strictObject({
  id: z.number().int(),
  direction: z.enum(['in', 'out']),
  kind: z.string(),
  body: z.record(z.string(), z.unknown()),
  created_at: Timestamp,
});
export const WaSendSchema = z
  .object({
    text: z.string().trim().min(1).max(1000).optional(),
    button: z.strictObject({ id: z.string().min(1).max(100), title: z.string().min(1).max(40) }).optional(),
    sample: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  })
  .strict()
  .refine((v) => [v.text, v.button, v.sample].filter((x) => x !== undefined).length === 1, { message: 'Send one thing: a text, a button reply or a sample document.' });

// --- The mail outbox --------------------------------------------------------------------------
export const StaffMailQuerySchema = ListQuerySchema.extend({ template: z.string().max(40).optional() });
export const StaffMailItemSchema = z.strictObject({
  id: Uuid,
  tenant: z.string().nullable(),
  to_email: z.string(),
  template: z.string(),
  subject: z.string(),
  status: z.string(),
  created_at: Timestamp,
});
export const StaffMailPageSchema = pageSchema(StaffMailItemSchema);
export const StaffMailSchema = z.strictObject({ ...StaffMailItemSchema.shape, body_text: z.string() });
