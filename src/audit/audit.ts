import type { PoolClient } from 'pg';

export interface AuditEvent {
  tenantId: string | null;
  actorType: 'user' | 'api_key' | 'system' | 'vendor_contact' | 'tshepovet_staff';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId?: string | null;
  ip?: string | null;
  /** References and statuses only - never raw identifiers. */
  details?: Record<string, unknown>;
}

/** Append to the tenant's hash-chained audit log (chain computed by DB trigger). */
export async function audit(client: PoolClient, e: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, request_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.tenantId, e.actorType, e.actorId, e.action, e.entityType, e.entityId, e.requestId ?? null, e.ip ?? null, JSON.stringify(e.details ?? {})],
  );
}
