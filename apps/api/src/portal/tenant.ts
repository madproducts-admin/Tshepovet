import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError, audit, type AuditEvent, withTenantTx } from '@tshepovet/core';
import type { ListQuery } from '@tshepovet/contracts';
import type { Container } from '../container';
import { clientIp } from './auth.service';

/**
 * Helpers shared by the portal controllers. Every portal query runs in a transaction scoped to
 * the caller's tenant (RLS), so a WHERE tenant_id = ... is never what keeps tenants apart.
 */

/** The signed-in portal user (after PortalGuard). */
export function me(req: Request) {
  const s = req.portal?.session;
  if (!s?.tenantId) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  return { tenantId: s.tenantId, userId: s.subjectId, role: s.role };
}

/** Runs fn in a transaction scoped (RLS) to the caller's tenant. */
export function inTenant<T>(c: Container, req: Request, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTx(c.pool, me(req).tenantId, fn);
}

/** An audit entry by the signed-in user, in the same transaction as the change. */
export function auditBy(client: PoolClient, req: Request, e: Pick<AuditEvent, 'action' | 'entityType' | 'entityId' | 'details'>) {
  const u = me(req);
  return audit(client, { tenantId: u.tenantId, actorType: 'user', actorId: u.userId, requestId: req.requestId, ip: clientIp(req), ...e });
}

const UuidSchema = z.uuid();
/** A path id that must be a UUID: anything else is a 404, as an unknown id would be. */
export function uuidParam(v: string, what = 'That record'): string {
  const r = UuidSchema.safeParse(v);
  if (!r.success) throw new ApiError(404, 'not_found', `${what} was not found.`);
  return r.data;
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} was not found.`);

/** ORDER BY for a list: only columns in the allowlist, with a stable tie-breaker. */
export function orderBy(q: Pick<ListQuery, 'sort' | 'order'>, allowed: Record<string, string>, fallback: string, tieBreaker = 'id'): string {
  const col = (q.sort && allowed[q.sort]) || allowed[fallback]!;
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  return `${col} ${dir} NULLS LAST, ${tieBreaker} ${dir}`;
}

export function pageOf(q: Pick<ListQuery, 'page' | 'page_size'>) {
  return { limit: q.page_size, offset: (q.page - 1) * q.page_size };
}

/** "%term%" for ILIKE, with the LIKE wildcards in the user's text escaped. */
export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Collects AND-ed conditions with numbered parameters. */
export class Where {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];

  /** Adds a condition; each `?` in it becomes the next $n, bound to the next value. */
  add(sql: string, ...values: unknown[]): this {
    let i = 0;
    this.parts.push(sql.replace(/\?/g, () => `$${this.params.push(values[i++])}`));
    return this;
  }

  /** The value's placeholder, for SQL outside the WHERE (LIMIT, OFFSET). */
  bind(value: unknown): string {
    return `$${this.params.push(value)}`;
  }

  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}

/** Who did something, as { type, name }: the SQL that resolves a user's or an API key's name. */
export function actorView(type: string | null, name: string | null) {
  return type ? { type: type as 'user' | 'api_key' | 'system' | 'vendor_contact' | 'tshepovet_staff', name } : null;
}
export const AUDIT_ACTOR_NAME = `CASE a.actor_type
    WHEN 'user' THEN (SELECT u.full_name FROM tenant_users u WHERE u.id::text = a.actor_id)
    WHEN 'api_key' THEN (SELECT k.name FROM api_keys k WHERE k.id::text = a.actor_id)
    WHEN 'system' THEN 'TshepoVet'
    WHEN 'tshepovet_staff' THEN 'TshepoVet support'
  END`;

/** True when Postgres refused the statement for a unique constraint (optionally a given one). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}

/**
 * A CSV download: UTF-8 with a BOM (Excel), RFC 4180 quoting, and spreadsheet formula
 * injection neutralised - a cell a supplier controls (a trading name, say) that starts with
 * = + - @ or a control character is prefixed with an apostrophe, so it opens as text.
 */
export function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(' ') : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${body}\r\n`);
}

/** Whether the user may see special personal information (B-BBEE ownership, POPIA s26). */
export async function canViewSpecialPi(client: PoolClient, userId: string): Promise<boolean> {
  const r = await client.query<{ v: boolean }>(`SELECT can_view_special_pi AS v FROM tenant_users WHERE id = $1`, [userId]);
  return r.rows[0]?.v ?? false;
}
