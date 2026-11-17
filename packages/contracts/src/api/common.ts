import { z } from 'zod';

/**
 * Building blocks for the portal API (/api) contracts.
 *
 * Requests are parsed with these schemas in the controllers. Responses are described with
 * strict objects: the integration tests parse every response with them, so an endpoint that
 * starts returning a field nobody declared (an internal id, an encrypted column) fails a test
 * instead of reaching a browser.
 */
export const Uuid = z.uuid();
/** Timestamps are ISO 8601 in UTC (what JSON makes of a JS Date). */
export const Timestamp = z.iso.datetime();
/** Calendar days: YYYY-MM-DD. */
export const Day = z.iso.date();
/** Money is always integer cents (ZAR, VAT-exclusive unless the field says otherwise). */
export const Cents = z.number().int();
export type Cents = number;

export const ListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), total: z.number().int(), page: z.number().int(), page_size: z.number().int() });
}

/** Boolean query parameters arrive as text. */
export const QueryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** The person or key behind an action, resolved to a display name. */
export const ActorSchema = z.strictObject({
  type: z.enum(['user', 'api_key', 'system', 'vendor_contact', 'tshepovet_staff']),
  name: z.string().nullable(),
});

/** Consent ticked in the portal: the user attests the subject agreed, with their own evidence. */
export const PortalConsentSchema = z
  .object({
    confirmed: z.literal(true, { message: 'Confirm that the supplier agreed before you continue.' }),
    evidence_reference: z.string().trim().min(1, 'Say where the evidence of consent is kept.').max(200),
  })
  .strict();
export type PortalConsent = z.infer<typeof PortalConsentSchema>;
