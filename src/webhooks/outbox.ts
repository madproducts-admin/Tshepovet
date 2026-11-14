import type { PoolClient } from 'pg';

export type WebhookEventType =
  | 'verification.completed'
  | 'verification.failed'
  | 'vendor.compliance_changed'
  | 'document.expiring'
  | 'document.expired'
  | 'vendor.payment_locked'
  | 'wallet.low_balance';

/**
 * Transactional outbox: the event and its per-endpoint deliveries are written
 * in the SAME transaction as the state change, so a crash can never produce
 * "charged but never notified" or "notified but rolled back". The dispatcher
 * worker delivers them asynchronously.
 */
export async function enqueueWebhook(
  client: PoolClient,
  tenantId: string,
  eventType: WebhookEventType,
  aggregateId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const ev = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO webhook_events (tenant_id, event_type, aggregate_id, payload) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id, created_at`,
    [tenantId, eventType, aggregateId],
  );
  const { id, created_at } = ev.rows[0]!;
  const envelope = { id, type: eventType, created_at: created_at.toISOString(), api_version: '2026-11-01', data };
  await client.query(`UPDATE webhook_events SET payload = $2 WHERE id = $1`, [id, JSON.stringify(envelope)]);
  await client.query(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id, tenant_id)
     SELECT $1, w.id, w.tenant_id FROM webhook_endpoints w
      WHERE w.tenant_id = $2 AND w.status = 'active' AND $3 = ANY(w.events)`,
    [id, tenantId, eventType],
  );
  return id;
}
