import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { ApiError, audit } from '@tshepovet/core';
import type { Container } from '../container';
import { clientIp } from '../portal/auth.service';

/**
 * Helpers for the staff console (docs/PLAN.md M8). Staff work across tenants, so their queries
 * run on the staff connection (BYPASSRLS) and every query names the tenant it touches. Every
 * change, and every look at a tenant's data, is written to the tenant's audit chain as a
 * 'tshepovet_staff' action (the tenant sees "TshepoVet support"), or to the platform chain.
 */
export function staffMe(req: Request) {
  const s = req.staff?.session;
  if (!s) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  return { id: s.subjectId, role: s.role };
}

/** Runs fn in a transaction on the staff connection. */
export async function inStaff<T>(c: Container, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!c.staffPool) throw new ApiError(503, 'staff_unavailable', 'The staff console is not configured on this server.');
  const client = await c.staffPool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function staffAudit(
  client: PoolClient,
  req: Request,
  e: { tenantId: string | null; action: string; entityType: string; entityId: string | null; details?: Record<string, unknown> },
) {
  return audit(client, { ...e, actorType: 'tshepovet_staff', actorId: staffMe(req).id, requestId: req.requestId, ip: clientIp(req) });
}

/**
 * Every staff response goes through its strict contract (security review, M9): staff queries run
 * on a BYPASSRLS connection, so a column added to a query later must fail loudly here rather
 * than reach a browser. The round trip through JSON gives the schema what the client would see.
 */
export function strict<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}
