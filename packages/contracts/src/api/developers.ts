import { z } from 'zod';
import { ListQuerySchema, pageSchema, Timestamp, Uuid } from './common';

export const API_SCOPES = ['verify:write', 'verify:read'] as const;

/** Webhook events a buyer can subscribe to (docs/05-api.md). */
export const WEBHOOK_EVENT_TYPES = [
  'verification.completed',
  'verification.failed',
  'vendor.compliance_changed',
  'document.expiring',
  'document.expired',
  'vendor.payment_locked',
  'wallet.low_balance',
] as const;

export const ApiKeySchema = z.strictObject({
  id: Uuid,
  name: z.string(),
  prefix: z.string(),
  environment: z.enum(['live', 'test']),
  scopes: z.array(z.enum(API_SCOPES)),
  created_by: z.string().nullable(),
  created_at: Timestamp,
  last_used_at: Timestamp.nullable(),
  expires_at: Timestamp.nullable(),
  revoked_at: Timestamp.nullable(),
});

export const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    environment: z.enum(['live', 'test']),
    scopes: z.array(z.enum(API_SCOPES)).min(1).default([...API_SCOPES]),
    expires_in_days: z.number().int().min(1).max(730).optional(),
  })
  .strict();

/** The secret appears here once and is never retrievable again. */
export const CreatedApiKeySchema = z.strictObject({ api_key: ApiKeySchema, secret: z.string() });

export const WebhookEndpointSchema = z.strictObject({
  id: Uuid,
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  status: z.enum(['active', 'disabled']),
  consecutive_failures: z.number().int(),
  disabled_at: Timestamp.nullable(),
  created_at: Timestamp,
  secret_rotated_at: Timestamp.nullable(),
  /** After a rotation, deliveries carry a second signature with the old secret until then. */
  previous_secret_valid_until: Timestamp.nullable(),
});

const events = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1, 'Choose at least one event.');
export const CreateWebhookSchema = z
  .object({
    url: z.string().trim().max(500),
    events,
    description: z.string().trim().max(200).optional(),
  })
  .strict();
export const UpdateWebhookSchema = z
  .object({
    url: z.string().trim().max(500).optional(),
    events: events.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });

/** The signing secret appears here once. */
export const WebhookWithSecretSchema = z.strictObject({ endpoint: WebhookEndpointSchema, secret: z.string() });

export const DeliveryQuerySchema = ListQuerySchema.pick({ page: true, page_size: true });
export const DeliverySchema = z.strictObject({
  id: Uuid,
  event_id: Uuid,
  event_type: z.string(),
  status: z.enum(['pending', 'delivering', 'succeeded', 'failed', 'dead']),
  attempts: z.number().int(),
  last_http_status: z.number().int().nullable(),
  last_error: z.string().nullable(),
  next_attempt_at: Timestamp,
  delivered_at: Timestamp.nullable(),
  event_created_at: Timestamp,
});
export const DeliveryPageSchema = pageSchema(DeliverySchema);
