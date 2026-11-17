import { z } from 'zod';
import { Day, PortalConsentSchema, Timestamp, Uuid } from './common';
import { PAYMENT_LOCK_STATUSES } from './suppliers';

export const MonitoringOverviewSchema = z.strictObject({
  counts: z.strictObject({ enrolled: z.number().int(), locked: z.number().int(), expiring_30d: z.number().int(), expired: z.number().int() }),
  enrolments: z.array(
    z.strictObject({
      supplier_id: Uuid,
      legal_name: z.string(),
      since: Timestamp,
      erp_lock_enabled: z.boolean(),
      payment_lock_status: z.enum(PAYMENT_LOCK_STATUSES),
      payment_lock_reason: z.string().nullable(),
      next_expiry_on: Day.nullable(),
    }),
  ),
});

export const EnrolSchema = z
  .object({
    erp_lock_enabled: z.boolean().default(false),
    /** Needed unless the supplier already consented to continuous monitoring. */
    consent: PortalConsentSchema.optional(),
  })
  .strict();

export const UpdateEnrolmentSchema = z.object({ erp_lock_enabled: z.boolean() }).strict();

export const CalendarQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to".' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 400 * 86_400_000, { message: 'Ask for at most about a year at a time.' });

export const ScheduleItemSchema = z.strictObject({
  id: Uuid,
  supplier_id: Uuid,
  legal_name: z.string(),
  subject_type: z.string(),
  expires_on: Day,
  grace_until: Day.nullable(),
  state: z.string(),
  next_action: z.string().nullable(),
  next_action_at: Timestamp.nullable(),
});

export const AlertSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['expired', 'expiring', 'locked']),
  supplier_id: Uuid,
  legal_name: z.string(),
  subject_type: z.string().nullable(),
  expires_on: Day.nullable(),
  days: z.number().int().nullable(),
  reason: z.string().nullable(),
});

export const PaymentLockSchema = z
  .object({
    status: z.enum(PAYMENT_LOCK_STATUSES),
    reason: z.string().trim().min(1, 'Give a reason: it is kept in the audit log.').max(500),
  })
  .strict();
