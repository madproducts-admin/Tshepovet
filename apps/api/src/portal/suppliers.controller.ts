import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError, enqueueMail, newOpaqueToken, parseEnterpriseNumber } from '@tshepovet/core';
import {
  AddSupplierSchema,
  AuditQuerySchema,
  CreateSavedViewSchema,
  InviteSupplierSchema,
  SUPPLIER_SORTS,
  type SupplierListQuery,
  SupplierListQuerySchema,
  SupplierStatusChangeSchema,
  UpdateSupplierSchema,
} from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { AUDIT_ACTOR_NAME, auditBy, canViewSpecialPi, inTenant, isUniqueViolation, likeTerm, me, notFound, orderBy, pageOf, sendCsv, uuidParam, Where } from './tenant';

/** The list row of a supplier, built the same way for the list, one supplier and the CSV. */
const SUPPLIER_SELECT = `
  SELECT tv.id, tv.vendor_id, v.legal_name, v.trading_name, v.cipc_enterprise_number AS registration_number, v.entity_kind,
         tv.status, tv.risk_rating, tv.external_ref, v.cipc_status, v.passport_status,
         lv.completed_at AS last_verified_at, lv.outcome AS last_outcome,
         EXISTS (SELECT 1 FROM monitoring_enrolments m WHERE m.tenant_vendor_id = tv.id AND m.period @> now()) AS monitored,
         tv.payment_lock_status,
         (SELECT min(e.expires_on) FROM expiry_schedules e WHERE e.tenant_vendor_id = tv.id AND e.state IN ('scheduled','expired','locked')) AS next_expiry_on,
         tv.created_at
    FROM tenant_vendors tv
    JOIN vendors v ON v.id = tv.vendor_id
    LEFT JOIN LATERAL (
      SELECT x.completed_at, x.outcome FROM verifications x
       WHERE x.tenant_vendor_id = tv.id AND x.status = 'completed'
       ORDER BY x.completed_at DESC LIMIT 1
    ) lv ON true`;

const SORT_COLUMNS: Record<(typeof SUPPLIER_SORTS)[number], string> = {
  legal_name: 's.legal_name',
  status: 's.status',
  risk_rating: 's.risk_rating',
  last_verified_at: 's.last_verified_at',
  next_expiry_on: 's.next_expiry_on',
  created_at: 's.created_at',
};

function filters(q: SupplierListQuery): Where {
  const w = new Where();
  if (q.q) {
    const t = likeTerm(q.q);
    w.add(`(s.legal_name ILIKE ? OR s.trading_name ILIKE ? OR s.registration_number ILIKE ? OR s.external_ref ILIKE ?)`, t, t, t, t);
  }
  if (q.status) w.add(`s.status = ?`, q.status);
  if (q.risk) w.add(`s.risk_rating = ?`, q.risk);
  if (q.monitored !== undefined) w.add(`s.monitored = ?`, q.monitored);
  return w;
}

export async function supplierRow(client: PoolClient, id: string) {
  const r = await client.query(`SELECT * FROM (${SUPPLIER_SELECT}) s WHERE s.id = $1`, [id]);
  if (!r.rows[0]) throw notFound('That supplier');
  return r.rows[0];
}

const STATUS_ACTIONS: Record<string, string> = {
  pending_review: 'supplier.sent_for_review',
  approved: 'supplier.approved',
  rejected: 'supplier.rejected',
  suspended: 'supplier.suspended',
  offboarded: 'supplier.offboarded',
};

/**
 * Suppliers: the organisation's relationships with vendors (tenant_vendors). A vendor's
 * passport is shared across the platform; what one organisation records about its supplier
 * (status, risk, reference, lock) is its own.
 */
@Controller('api')
@UseGuards(PortalGuard)
export class SuppliersController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('suppliers')
  @RequirePermission('suppliers:read')
  async list(@Req() req: Request) {
    const q = SupplierListQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const w = filters(q);
      const { limit, offset } = pageOf(q);
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n FROM (${SUPPLIER_SELECT}) s ${w.sql}`, w.params);
      const rows = await client.query(
        `SELECT * FROM (${SUPPLIER_SELECT}) s ${w.sql} ORDER BY ${orderBy(q, SORT_COLUMNS, 'created_at', 's.id')} LIMIT ${w.bind(limit)} OFFSET ${w.bind(offset)}`,
        w.params,
      );
      return { items: rows.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
    });
  }

  @Get('suppliers/export.csv')
  @RequirePermission('suppliers:read')
  async exportCsv(@Req() req: Request, @Res() res: Response) {
    const q = SupplierListQuerySchema.parse(req.query);
    const rows = await inTenant(this.c, req, async (client) => {
      const w = filters(q);
      return (await client.query(`SELECT * FROM (${SUPPLIER_SELECT}) s ${w.sql} ORDER BY ${orderBy(q, SORT_COLUMNS, 'created_at', 's.id')} LIMIT 10000`, w.params)).rows;
    });
    sendCsv(
      res,
      'suppliers.csv',
      ['Legal name', 'Trading name', 'Registration number', 'Status', 'Risk', 'Your reference', 'CIPC status', 'Passport', 'Last verified', 'Last outcome', 'Monitored', 'Payments', 'Next expiry', 'Added'],
      rows.map((s) => [
        s.legal_name,
        s.trading_name,
        s.registration_number,
        s.status,
        s.risk_rating,
        s.external_ref,
        s.cipc_status,
        s.passport_status,
        s.last_verified_at,
        s.last_outcome,
        s.monitored ? 'yes' : 'no',
        s.payment_lock_status,
        s.next_expiry_on,
        s.created_at,
      ]),
    );
  }

  @Post('suppliers')
  @HttpCode(201)
  @RequirePermission('suppliers:write')
  async add(@Req() req: Request) {
    const b = AddSupplierSchema.parse(req.body);
    const parsed = parseEnterpriseNumber(b.registration_number);
    return inTenant(this.c, req, async (client) => {
      const vendor = await client.query<{ id: string }>(`SELECT resolve_vendor_by_cipc($1, $2, $3, NULL) AS id`, [
        parsed.normalised,
        parsed.typeName ? parsed.typeCode : null,
        parsed.entityKind,
      ]);
      const vendorId = vendor.rows[0]!.id;
      const existing = await client.query<{ id: string }>(`SELECT id FROM tenant_vendors WHERE vendor_id = $1`, [vendorId]);
      if (existing.rows[0]) {
        throw new ApiError(409, 'already_added', 'This supplier is already on your list.', { supplier_id: existing.rows[0].id });
      }
      let id: string;
      try {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO tenant_vendors (tenant_id, vendor_id, external_ref, onboarding_channel, status, industry_profile)
           VALUES ($1, $2, $3, 'portal', 'onboarding', $4) RETURNING id`,
          [me(req).tenantId, vendorId, b.external_ref ?? null, b.industry_profile ?? null],
        );
        id = ins.rows[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'external_ref_in_use', 'Another supplier already has that reference.');
        throw err;
      }
      await auditBy(client, req, { action: 'supplier.added', entityType: 'tenant_vendor', entityId: id, details: { vendor_id: vendorId, channel: 'portal' } });
      return supplierRow(client, id);
    });
  }

  @Get('suppliers/:id')
  @RequirePermission('suppliers:read')
  async detail(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That supplier');
    return inTenant(this.c, req, async (client) => {
      const rel = (
        await client.query(
          `SELECT tv.id, tv.vendor_id, tv.status, tv.risk_rating, tv.external_ref, tv.industry_profile, tv.onboarding_channel, tv.approved_at,
                  u.full_name AS approved_by, tv.payment_lock_status, tv.payment_lock_reason, tv.relationship_ended_at, tv.created_at, tv.updated_at
             FROM tenant_vendors tv LEFT JOIN tenant_users u ON u.id = tv.approved_by
            WHERE tv.id = $1`,
          [id],
        )
      ).rows[0];
      if (!rel) throw notFound('That supplier');
      const vendorId: string = rel.vendor_id;
      delete rel.vendor_id;

      const vendor = (
        await client.query(
          `SELECT id, legal_name, trading_name, entity_kind, cipc_enterprise_number AS registration_number, cipc_status, cipc_status_raw,
                  incorporation_date, annual_return_due_date, vat_number, csd_supplier_number, passport_status, passport_last_verified_at
             FROM vendors WHERE id = $1`,
          [vendorId],
        )
      ).rows[0];
      const directors = await client.query(
        `SELECT full_name, role, status, appointed_on, resigned_on, as_of FROM vendor_directors
          WHERE vendor_id = $1 ORDER BY (status = 'active') DESC, full_name`,
        [vendorId],
      );
      const owners = await client.query(
        `SELECT full_name, ownership_pct::float8 AS ownership_pct, control_type, source, declared_at FROM vendor_beneficial_owners
          WHERE vendor_id = $1 ORDER BY ownership_pct DESC NULLS LAST, full_name`,
        [vendorId],
      );
      const banks = await client.query(
        `SELECT bank_name, account_type, account_last4, avs_status, avs_checked_at FROM vendor_bank_accounts
          WHERE vendor_id = $1 ORDER BY created_at DESC`,
        [vendorId],
      );
      const special = await canViewSpecialPi(client, me(req).userId);
      const b = (
        await client.query(
          `SELECT bbbee_level AS level, procurement_recognition_pct::float8 AS procurement_recognition_pct, evidence_type, issued_on, valid_until,
                  status, is_empowering_supplier, black_ownership_pct::float8 AS black_ownership_pct,
                  black_female_ownership_pct::float8 AS black_female_ownership_pct, designated_group_ownership_pct::float8 AS designated_group_ownership_pct
             FROM vendor_bbbee_profiles WHERE vendor_id = $1
            ORDER BY (status = 'accepted') DESC, valid_until DESC LIMIT 1`,
          [vendorId],
        )
      ).rows[0];
      const bbbee = b
        ? {
            level: b.level,
            procurement_recognition_pct: b.procurement_recognition_pct,
            evidence_type: b.evidence_type,
            issued_on: b.issued_on,
            valid_until: b.valid_until,
            status: b.status,
            is_empowering_supplier: b.is_empowering_supplier,
            ownership: special
              ? { black_ownership_pct: b.black_ownership_pct, black_female_ownership_pct: b.black_female_ownership_pct, designated_group_ownership_pct: b.designated_group_ownership_pct }
              : null,
          }
        : null;
      const credentials = await client.query(
        `SELECT id, credential_type, holder_display, reference_number, issuer, status, valid_until, verified_at
           FROM vendor_credentials WHERE vendor_id = $1 ORDER BY valid_until DESC NULLS LAST`,
        [vendorId],
      );
      const documents = await client.query(
        `SELECT d.id, d.document_type, coalesce(t.name, d.document_type) AS document_name, d.review_status, d.source_channel, d.issued_on, d.expires_on,
                (d.storage_key IS NOT NULL) AS image_available, d.created_at
           FROM vendor_documents d LEFT JOIN ref_document_types t ON t.code = d.document_type
          WHERE d.vendor_id = $1 AND d.superseded_by IS NULL ORDER BY d.created_at DESC`,
        [vendorId],
      );
      const enrol = (
        await client.query<{ since: Date; erp_lock_enabled: boolean }>(
          `SELECT lower(period) AS since, erp_lock_enabled FROM monitoring_enrolments WHERE tenant_vendor_id = $1 AND period @> now()`,
          [id],
        )
      ).rows[0];
      const schedules = await client.query(
        `SELECT id, subject_type, expires_on, grace_until, state, next_action, next_action_at FROM expiry_schedules
          WHERE tenant_vendor_id = $1 ORDER BY expires_on`,
        [id],
      );
      const checks = await client.query(
        `SELECT id, verification_type AS type, status, outcome, risk_flags, price_cents, charged, requested_at, completed_at
           FROM verifications WHERE tenant_vendor_id = $1 ORDER BY requested_at DESC LIMIT 20`,
        [id],
      );
      return {
        relationship: rel,
        vendor,
        directors: directors.rows,
        beneficial_owners: owners.rows,
        bank_accounts: banks.rows,
        bbbee,
        credentials: credentials.rows,
        documents: documents.rows,
        monitoring: { enrolled: Boolean(enrol), since: enrol?.since ?? null, erp_lock_enabled: enrol?.erp_lock_enabled ?? false, schedules: schedules.rows },
        checks: checks.rows,
        permissions: { can_view_special_pi: special },
      };
    });
  }

  @Patch('suppliers/:id')
  @RequirePermission('suppliers:write')
  async update(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That supplier');
    const b = UpdateSupplierSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const k of ['external_ref', 'risk_rating', 'industry_profile'] as const) {
        if (b[k] !== undefined) sets.push(`${k} = $${params.push(b[k])}`);
      }
      let n: number;
      try {
        n = (await client.query(`UPDATE tenant_vendors SET ${sets.join(', ')} WHERE id = $1`, params)).rowCount ?? 0;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'external_ref_in_use', 'Another supplier already has that reference.');
        throw err;
      }
      if (!n) throw notFound('That supplier');
      await auditBy(client, req, { action: 'supplier.updated', entityType: 'tenant_vendor', entityId: id, details: { fields: Object.keys(b) } });
      return supplierRow(client, id);
    });
  }

  @Post('suppliers/:id/status')
  @HttpCode(200)
  @RequirePermission('suppliers:write')
  async setStatus(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That supplier');
    const b = SupplierStatusChangeSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      const cur = (await client.query<{ status: string }>(`SELECT status FROM tenant_vendors WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('That supplier');
      if (cur.status === b.status) throw new ApiError(409, 'no_change', `This supplier is already ${b.status.replace('_', ' ')}.`);
      await client.query(
        `UPDATE tenant_vendors
            SET status = $2,
                approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END,
                approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
                relationship_ended_at = CASE WHEN $2 = 'offboarded' THEN now() ELSE NULL END
          WHERE id = $1`,
        [id, b.status, me(req).userId],
      );
      await auditBy(client, req, {
        action: STATUS_ACTIONS[b.status]!,
        entityType: 'tenant_vendor',
        entityId: id,
        details: { from: cur.status, to: b.status, ...(b.reason ? { reason: b.reason } : {}) },
      });
      return supplierRow(client, id);
    });
  }

  @Get('suppliers/:id/audit')
  @RequirePermission('audit:read')
  async auditTrail(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That supplier');
    const q = AuditQuerySchema.pick({ before_id: true, limit: true }).parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const tv = await client.query(`SELECT 1 FROM tenant_vendors WHERE id = $1`, [id]);
      if (!tv.rowCount) throw notFound('That supplier');
      // The relationship's own entries, and those of the checks run on it.
      const rows = await client.query(
        `SELECT a.id, a.occurred_at, a.actor_type, ${AUDIT_ACTOR_NAME} AS actor_name, a.action, a.entity_type, a.entity_id, a.request_id, a.ip::text AS ip, a.details
           FROM audit_log a
          WHERE (a.entity_id = $1 OR a.entity_id IN (SELECT v.id::text FROM verifications v WHERE v.tenant_vendor_id = $2))
            AND ($3::bigint IS NULL OR a.id < $3)
          ORDER BY a.id DESC LIMIT $4`,
        [id, id, q.before_id ?? null, q.limit + 1],
      );
      return auditPage(rows.rows, q.limit);
    });
  }

  // --- Onboarding invitations ---------------------------------------------------------------
  @Get('suppliers/:id/invitations')
  @RequirePermission('suppliers:read')
  async invitations(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That supplier');
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `SELECT id, email::text AS email, contact_name, created_at, expires_at, opened_at, completed_at, revoked_at
           FROM vendor_invites WHERE tenant_vendor_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return r.rows;
    });
  }

  /** Sends the supplier a link to onboard themselves (14 days; only its hash is stored). */
  @Post('suppliers/:id/invitations')
  @HttpCode(201)
  @RequirePermission('suppliers:write')
  async invite(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That supplier');
    const b = InviteSupplierSchema.parse(req.body);
    const u = me(req);
    const { token, hash } = newOpaqueToken();
    return inTenant(this.c, req, async (client) => {
      const tv = (
        await client.query<{ status: string; legal_name: string; buyer: string }>(
          `SELECT tv.status, v.legal_name, t.legal_name AS buyer FROM tenant_vendors tv JOIN vendors v ON v.id = tv.vendor_id JOIN tenants t ON t.id = tv.tenant_id WHERE tv.id = $1`,
          [id],
        )
      ).rows[0];
      if (!tv) throw notFound('That supplier');
      if (['rejected', 'offboarded'].includes(tv.status)) throw new ApiError(409, 'supplier_inactive', 'This supplier is rejected or offboarded. Change its status first.');
      // Only the newest link works.
      await client.query(`UPDATE vendor_invites SET revoked_at = now() WHERE tenant_vendor_id = $1 AND completed_at IS NULL AND revoked_at IS NULL`, [id]);
      const r = await client.query(
        `INSERT INTO vendor_invites (tenant_id, tenant_vendor_id, email, contact_name, token_hash, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '14 days')
         RETURNING id, email::text AS email, contact_name, created_at, expires_at, opened_at, completed_at, revoked_at`,
        [u.tenantId, id, b.email, b.contact_name ?? null, hash, u.userId],
      );
      await client.query(`UPDATE tenant_vendors SET status = 'invited' WHERE id = $1 AND status = 'onboarding'`, [id]);
      await enqueueMail(client, {
        tenantId: u.tenantId,
        to: b.email,
        template: 'vendor_invite',
        vars: { appUrl: this.c.config.APP_URL, name: b.contact_name ?? null, org: tv.buyer, supplier: tv.legal_name, link: `${this.c.config.APP_URL}/onboard#token=${token}` },
      });
      await auditBy(client, req, { action: 'supplier.invited', entityType: 'tenant_vendor', entityId: id, details: { invite_id: r.rows[0].id } });
      return r.rows[0];
    });
  }

  @Delete('suppliers/:id/invitations/:inviteId')
  @HttpCode(204)
  @RequirePermission('suppliers:write')
  async revokeInvite(@Req() req: Request, @Param('id') rawId: string, @Param('inviteId') rawInvite: string) {
    const id = uuidParam(rawId, 'That supplier');
    const inviteId = uuidParam(rawInvite, 'That invitation');
    await inTenant(this.c, req, async (client) => {
      const r = await client.query(`UPDATE vendor_invites SET revoked_at = now() WHERE id = $1 AND tenant_vendor_id = $2 AND completed_at IS NULL AND revoked_at IS NULL`, [inviteId, id]);
      if (!r.rowCount) throw notFound('An open invitation with that id');
      await auditBy(client, req, { action: 'supplier.invitation_withdrawn', entityType: 'tenant_vendor', entityId: id, details: { invite_id: inviteId } });
    });
  }

  // --- Saved views ------------------------------------------------------------------------
  @Get('saved-views')
  @RequirePermission('suppliers:read')
  async views(@Req() req: Request) {
    const { scope } = z.object({ scope: z.enum(['suppliers', 'checks']) }).parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(`SELECT id, scope, name, query, created_at FROM saved_views WHERE user_id = $1 AND scope = $2 ORDER BY name`, [me(req).userId, scope]);
      return r.rows;
    });
  }

  @Post('saved-views')
  @HttpCode(201)
  @RequirePermission('suppliers:read')
  async saveView(@Req() req: Request) {
    const b = CreateSavedViewSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      const n = await client.query<{ n: number }>(`SELECT count(*) AS n FROM saved_views WHERE user_id = $1`, [me(req).userId]);
      if (n.rows[0]!.n >= 50) throw new ApiError(409, 'too_many_views', 'You have 50 saved views. Delete one first.');
      try {
        const r = await client.query(
          `INSERT INTO saved_views (tenant_id, user_id, scope, name, query) VALUES ($1, $2, $3, $4, $5) RETURNING id, scope, name, query, created_at`,
          [me(req).tenantId, me(req).userId, b.scope, b.name, JSON.stringify(b.query)],
        );
        return r.rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'name_in_use', 'You already have a view with that name.');
        throw err;
      }
    });
  }

  @Delete('saved-views/:id')
  @HttpCode(204)
  @RequirePermission('suppliers:read')
  async deleteView(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That view');
    const n = await inTenant(this.c, req, async (client) => (await client.query(`DELETE FROM saved_views WHERE id = $1 AND user_id = $2`, [id, me(req).userId])).rowCount);
    if (!n) throw notFound('That view');
  }
}

/** Shapes audit rows for the API and works out the next page's cursor. */
export function auditPage(rows: Array<Record<string, unknown>>, limit: number) {
  const items = rows.slice(0, limit).map((a) => ({
    id: a.id as number,
    occurred_at: a.occurred_at,
    actor: { type: a.actor_type, name: (a.actor_name as string | null) ?? null },
    action: a.action,
    entity_type: a.entity_type,
    entity_id: a.entity_id ?? null,
    request_id: a.request_id ?? null,
    ip: a.ip ?? null,
    details: a.details ?? {},
  }));
  return { items, next_before_id: rows.length > limit ? (items[items.length - 1]!.id as number) : null };
}
