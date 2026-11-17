import { Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { ApiError } from '@tshepovet/core';
import { AuditQuerySchema, ConsentListQuerySchema, CreateDsrSchema, DsrListQuerySchema, UpdateDsrSchema, WithdrawConsentSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { endMonitoring } from './monitoring.controller';
import { auditPage } from './suppliers.controller';
import { AUDIT_ACTOR_NAME, actorView, auditBy, inTenant, likeTerm, me, notFound, pageOf, uuidParam, Where } from './tenant';

const CONSENT_FROM = `
  FROM consent_records cr
  JOIN privacy_notices n ON n.id = cr.notice_id
  LEFT JOIN vendors v ON v.id = cr.vendor_id
  LEFT JOIN tenant_vendors tv ON tv.vendor_id = cr.vendor_id
  LEFT JOIN tenant_users u ON u.id = cr.captured_by_user
  LEFT JOIN api_keys k ON k.id = cr.captured_by_api_key`;
const CONSENT_SELECT = `
  SELECT cr.id, tv.id AS supplier_id, v.legal_name AS supplier_name, cr.subject_display, cr.subject_type, cr.subject_role, cr.on_behalf_of_subject,
         cr.capture_method, n.id AS notice_id, n.code AS notice_code, n.version AS notice_version, n.channel AS notice_channel,
         CASE WHEN cr.captured_by_user IS NOT NULL THEN 'user' WHEN cr.captured_by_api_key IS NOT NULL THEN 'api_key' END AS actor_type,
         coalesce(u.full_name, k.name) AS actor_name, cr.granted_at, cr.expires_at
  ${CONSENT_FROM}`;

async function withPurposes(client: PoolClient, rows: Array<Record<string, unknown>>) {
  const ids = rows.map((r) => r.id as string);
  const p = ids.length
    ? (
        await client.query<{ consent_id: string; purpose: string; lawful_basis: string; special_pi_basis: string | null; withdrawn_at: Date | null }>(
          `SELECT consent_id, purpose, lawful_basis, special_pi_basis, withdrawn_at FROM consent_purposes WHERE consent_id = ANY($1::uuid[]) ORDER BY purpose`,
          [ids],
        )
      ).rows
    : [];
  return rows.map((r) => ({
    id: r.id,
    supplier_id: r.supplier_id ?? null,
    supplier_name: r.supplier_name ?? null,
    subject_display: r.subject_display,
    subject_type: r.subject_type,
    subject_role: r.subject_role,
    on_behalf_of_subject: r.on_behalf_of_subject,
    capture_method: r.capture_method,
    notice: { id: r.notice_id, code: r.notice_code, version: r.notice_version, channel: r.notice_channel },
    captured_by: actorView(r.actor_type as string | null, (r.actor_name as string | null) ?? null),
    granted_at: r.granted_at,
    expires_at: r.expires_at ?? null,
    purposes: p.filter((x) => x.consent_id === r.id).map(({ consent_id: _, ...x }) => x),
  }));
}

const DSR_SELECT = `
  SELECT d.id, d.request_type, d.requester_display, tv.id AS supplier_id, v.legal_name AS supplier_name, d.identity_verified, d.status,
         d.received_at, d.due_at, d.completed_at, d.outcome_notes,
         CASE WHEN d.completed_at IS NULL THEN (d.due_at::date - current_date) END AS days_left
    FROM data_subject_requests d
    LEFT JOIN vendors v ON v.id = d.vendor_id
    LEFT JOIN tenant_vendors tv ON tv.vendor_id = d.vendor_id`;
const CLOSED = ['completed', 'refused'];

/**
 * POPIA compliance: consent records (and their withdrawal), the privacy notices, the record of
 * processing activities, data-subject requests on the 30-day clock, and the hash-chained audit log.
 */
@Controller('api')
@UseGuards(PortalGuard)
export class ComplianceController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('compliance/consents')
  @RequirePermission('compliance:read')
  async consents(@Req() req: Request) {
    const q = ConsentListQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const w = new Where();
      if (q.q) {
        const t = likeTerm(q.q);
        w.add(`(cr.subject_display ILIKE ? OR v.legal_name ILIKE ?)`, t, t);
      }
      if (q.supplier_id) w.add(`tv.id = ?`, q.supplier_id);
      if (q.purpose) w.add(`EXISTS (SELECT 1 FROM consent_purposes p WHERE p.consent_id = cr.id AND p.purpose = ?)`, q.purpose);
      if (q.state === 'active') w.add(`EXISTS (SELECT 1 FROM consent_purposes p WHERE p.consent_id = cr.id AND p.withdrawn_at IS NULL)`);
      if (q.state === 'withdrawn') w.add(`NOT EXISTS (SELECT 1 FROM consent_purposes p WHERE p.consent_id = cr.id AND p.withdrawn_at IS NULL)`);
      const { limit, offset } = pageOf(q);
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n ${CONSENT_FROM} ${w.sql}`, w.params);
      const rows = await client.query(`${CONSENT_SELECT} ${w.sql} ORDER BY cr.granted_at ${q.order === 'asc' ? 'ASC' : 'DESC'}, cr.id LIMIT ${w.bind(limit)} OFFSET ${w.bind(offset)}`, w.params);
      return { items: await withPurposes(client, rows.rows), total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
    });
  }

  @Post('compliance/consents/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  async withdraw(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That consent record');
    const b = WithdrawConsentSchema.parse(req.body ?? {});
    return inTenant(this.c, req, async (client) => {
      const cr = (await client.query<{ vendor_id: string | null }>(`SELECT vendor_id FROM consent_records WHERE id = $1`, [id])).rows[0];
      if (!cr) throw notFound('That consent record');
      const n = await this.c.consent.withdraw(client, id, b.purposes ?? 'all', b.channel);
      if (!n) throw new ApiError(409, 'already_withdrawn', 'Nothing to withdraw: those purposes are already withdrawn.');
      // Monitoring rests on consent: without it, it stops.
      const monitoringGone = await client.query(
        `SELECT 1 FROM consent_purposes WHERE consent_id = $1 AND purpose = 'continuous_monitoring' AND withdrawn_at IS NOT NULL`,
        [id],
      );
      let monitoringEnded = false;
      if (monitoringGone.rowCount && cr.vendor_id) {
        const tv = await client.query<{ id: string }>(`SELECT id FROM tenant_vendors WHERE vendor_id = $1`, [cr.vendor_id]);
        const stillConsented = await client.query(
          `SELECT 1 FROM consent_records r JOIN consent_purposes p ON p.consent_id = r.id
            WHERE r.vendor_id = $1 AND p.purpose = 'continuous_monitoring' AND p.withdrawn_at IS NULL LIMIT 1`,
          [cr.vendor_id],
        );
        if (tv.rows[0] && !stillConsented.rowCount) monitoringEnded = await endMonitoring(client, tv.rows[0].id);
      }
      await auditBy(client, req, {
        action: 'consent.withdrawn',
        entityType: 'consent_record',
        entityId: id,
        details: { purposes: b.purposes ?? 'all', channel: b.channel, purposes_withdrawn: n, monitoring_ended: monitoringEnded },
      });
      const row = (await client.query(`${CONSENT_SELECT} WHERE cr.id = $1`, [id])).rows;
      return (await withPurposes(client, row))[0];
    });
  }

  @Get('compliance/notices')
  @RequirePermission('compliance:read')
  async notices(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `SELECT id, code, version, language, channel, body, effective_from, retired_at FROM privacy_notices ORDER BY code, channel, language, version DESC`,
      );
      return r.rows;
    });
  }

  @Get('compliance/processing')
  @RequirePermission('compliance:read')
  async processing(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `SELECT pa.code, pa.description, pa.purpose, pa.lawful_basis, pa.data_categories, pa.special_pi, pa.cross_border, rp.retention_days
           FROM processing_activities pa LEFT JOIN ref_retention_policies rp ON rp.data_category = pa.retention_category
          ORDER BY pa.code`,
      );
      return r.rows;
    });
  }

  // --- Data-subject requests -----------------------------------------------------------------
  @Get('compliance/requests')
  @RequirePermission('compliance:read')
  async requests(@Req() req: Request) {
    const q = DsrListQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const w = new Where();
      if (q.q) {
        const t = likeTerm(q.q);
        w.add(`(d.requester_display ILIKE ? OR v.legal_name ILIKE ?)`, t, t);
      }
      if (q.status) w.add(`d.status = ?`, q.status);
      if (q.open === 'true') w.add(`d.completed_at IS NULL`);
      if (q.open === 'false') w.add(`d.completed_at IS NOT NULL`);
      const { limit, offset } = pageOf(q);
      const base = `FROM data_subject_requests d LEFT JOIN vendors v ON v.id = d.vendor_id LEFT JOIN tenant_vendors tv ON tv.vendor_id = d.vendor_id`;
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n ${base} ${w.sql}`, w.params);
      // Open requests first, the most urgent at the top.
      const rows = await client.query(
        `${DSR_SELECT} ${w.sql} ORDER BY (d.completed_at IS NULL) DESC, d.due_at ASC, d.id LIMIT ${w.bind(limit)} OFFSET ${w.bind(offset)}`,
        w.params,
      );
      return { items: rows.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
    });
  }

  @Post('compliance/requests')
  @HttpCode(201)
  @RequirePermission('compliance:manage')
  async createRequest(@Req() req: Request) {
    const b = CreateDsrSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      let vendorId: string | null = null;
      if (b.supplier_id) {
        const tv = await client.query<{ vendor_id: string }>(`SELECT vendor_id FROM tenant_vendors WHERE id = $1`, [b.supplier_id]);
        if (!tv.rows[0]) throw notFound('That supplier');
        vendorId = tv.rows[0].vendor_id;
      }
      const ins = await client.query<{ id: string }>(
        `INSERT INTO data_subject_requests (tenant_id, vendor_id, request_type, requester_display, received_at, due_at, outcome_notes)
         VALUES ($1, $2, $3, $4, coalesce($5::date::timestamptz, now()), coalesce($5::date::timestamptz, now()) + interval '30 days', $6)
         RETURNING id`,
        [me(req).tenantId, vendorId, b.request_type, b.requester_display, b.received_on ?? null, b.notes ?? null],
      );
      const id = ins.rows[0]!.id;
      await auditBy(client, req, { action: 'dsr.received', entityType: 'data_subject_request', entityId: id, details: { request_type: b.request_type } });
      return (await client.query(`${DSR_SELECT} WHERE d.id = $1`, [id])).rows[0];
    });
  }

  @Patch('compliance/requests/:id')
  @RequirePermission('compliance:manage')
  async updateRequest(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That request');
    const b = UpdateDsrSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      const cur = (await client.query<{ status: string }>(`SELECT status FROM data_subject_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('That request');
      const sets: string[] = [];
      const params: unknown[] = [id];
      if (b.status !== undefined) {
        sets.push(`status = $${params.push(b.status)}`);
        sets.push(CLOSED.includes(b.status) ? `completed_at = coalesce(completed_at, now())` : `completed_at = NULL`);
      }
      if (b.identity_verified !== undefined) sets.push(`identity_verified = $${params.push(b.identity_verified)}`);
      if (b.outcome_notes !== undefined) sets.push(`outcome_notes = $${params.push(b.outcome_notes)}`);
      await client.query(`UPDATE data_subject_requests SET ${sets.join(', ')} WHERE id = $1`, params);
      await auditBy(client, req, {
        action: b.status && b.status !== cur.status ? `dsr.${b.status}` : 'dsr.updated',
        entityType: 'data_subject_request',
        entityId: id,
        details: { from: cur.status, ...(b.status ? { to: b.status } : {}), ...(b.identity_verified !== undefined ? { identity_verified: b.identity_verified } : {}) },
      });
      return (await client.query(`${DSR_SELECT} WHERE d.id = $1`, [id])).rows[0];
    });
  }

  // --- Audit log -------------------------------------------------------------------------------
  @Get('audit')
  @RequirePermission('audit:read')
  async audit(@Req() req: Request) {
    const q = AuditQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const w = new Where();
      if (q.action) w.add(`a.action LIKE ?`, `${q.action.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      if (q.actor_type) w.add(`a.actor_type = ?`, q.actor_type);
      if (q.entity_type) w.add(`a.entity_type = ?`, q.entity_type);
      if (q.entity_id) w.add(`a.entity_id = ?`, q.entity_id);
      if (q.from) w.add(`a.occurred_at >= ?::date`, q.from);
      if (q.to) w.add(`a.occurred_at < ?::date + 1`, q.to);
      if (q.before_id) w.add(`a.id < ?`, q.before_id);
      const rows = await client.query(
        `SELECT a.id, a.occurred_at, a.actor_type, ${AUDIT_ACTOR_NAME} AS actor_name, a.action, a.entity_type, a.entity_id, a.request_id, a.ip::text AS ip, a.details
           FROM audit_log a ${w.sql} ORDER BY a.id DESC LIMIT ${w.bind(q.limit + 1)}`,
        w.params,
      );
      return auditPage(rows.rows, q.limit);
    });
  }

  /** Re-computes every entry's hash in order; any edit, deletion or insertion breaks the chain. */
  @Post('audit/verify')
  @HttpCode(200)
  @RequirePermission('audit:read')
  async verify(@Req() req: Request) {
    const t = me(req).tenantId;
    return inTenant(this.c, req, async (client) => {
      const r = await client.query<{ broken: number | null; n: number }>(
        `SELECT verify_audit_chain($1) AS broken, (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS n`,
        [t],
      );
      const { broken, n } = r.rows[0]!;
      await auditBy(client, req, { action: 'audit.chain_verified', entityType: 'audit_log', entityId: null, details: { intact: broken === null, entries: n } });
      return { intact: broken === null, entries_checked: n, broken_at_sequence: broken, checked_at: new Date() };
    });
  }
}
