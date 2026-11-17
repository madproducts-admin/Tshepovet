import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, HealthTracker, type Capability } from '@tshepovet/core';
import {
  CapabilityUpdateSchema,
  NewPriceSchema,
  ReviewDecisionSchema,
  StaffMailQuerySchema,
  StaffTenantQuerySchema,
  TenantStatusSchema,
} from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { RequireStaffRole, StaffGuard } from '../portal/guards';
import { likeTerm, pageOf, utcInstants, uuidParam } from '../portal/tenant';
import { inStaff, staffAudit } from './common';

/**
 * The staff console (/api/staff, docs/PLAN.md M8): the review queue, tenants and users, data-
 * subject requests, purge runs, bureaus and prices, and the sandbox mail outbox. Roles per
 * route are declared here and in packages/contracts/src/api/routes.ts (a test compares them).
 */
@Controller('api/staff')
@UseGuards(StaffGuard)
export class StaffConsoleController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('overview')
  async overview() {
    return inStaff(this.c, async (db) => {
      const r = (
        await db.query(
          `SELECT
             (SELECT count(*) FROM vendor_documents WHERE review_status = 'needs_review' AND purged_at IS NULL) AS documents,
             (SELECT count(*) FROM wa_conversations WHERE state = 'HUMAN_HANDOFF') AS handoffs,
             (SELECT count(*) FROM data_subject_requests WHERE status NOT IN ('completed','refused')) AS open,
             (SELECT count(*) FROM data_subject_requests WHERE status NOT IN ('completed','refused') AND due_at >= now() AND due_at < now() + interval '7 days') AS due7,
             (SELECT count(*) FROM data_subject_requests WHERE status NOT IN ('completed','refused') AND due_at < now()) AS overdue,
             (SELECT count(*) FROM tenants WHERE status = 'active') AS active,
             (SELECT count(*) FROM tenants WHERE status = 'suspended') AS suspended,
             (SELECT count(*) FROM verifications WHERE status = 'processing') AS processing,
             (SELECT count(*) FROM verifications WHERE requested_at > now() - interval '24 hours') AS last_24h,
             (SELECT count(*) FROM verifications WHERE status = 'failed' AND requested_at > now() - interval '24 hours') AS failed_24h,
             (SELECT count(*) FROM email_outbox WHERE status = 'sandbox') AS held,
             (SELECT count(*) FROM email_outbox WHERE status = 'queued') AS queued,
             (SELECT max(finished_at) FROM purge_runs) AS last_purge_at`,
        )
      ).rows[0];
      return {
        sandbox: this.c.config.SANDBOX === 'true',
        review: { documents: r.documents, handoffs: r.handoffs },
        requests: { open: r.open, due_within_7_days: r.due7, overdue: r.overdue },
        tenants: { active: r.active, suspended: r.suspended },
        verifications: { processing: r.processing, last_24h: r.last_24h, failed_24h: r.failed_24h },
        mail: { held: r.held, queued: r.queued },
        last_purge_at: r.last_purge_at,
      };
    });
  }

  // --- The review queue ----------------------------------------------------------------------
  @Get('review')
  @RequireStaffRole('reviewer', 'admin')
  async review() {
    return inStaff(this.c, async (db) => {
      const documents = await db.query(
        `SELECT d.id, t.legal_name AS tenant, v.legal_name AS supplier, d.document_type, rt.name AS document_name, d.source_channel AS source,
                d.review_flags AS flags, (d.extracted_fields->>'level')::integer AS level, d.created_at
           FROM vendor_documents d
           JOIN vendors v ON v.id = d.vendor_id
           JOIN ref_document_types rt ON rt.code = d.document_type
           LEFT JOIN tenants t ON t.id = d.tenant_id
          WHERE d.review_status = 'needs_review' AND d.purged_at IS NULL
          ORDER BY d.created_at LIMIT 200`,
      );
      const handoffs = await db.query(
        `SELECT c.id, t.legal_name AS tenant, v.legal_name AS supplier, c.updated_at AS since,
                (SELECT a.details->>'reason' FROM audit_log a
                  WHERE a.tenant_id = c.tenant_id AND a.action = 'whatsapp.handoff' AND a.entity_id = c.id::text
                  ORDER BY a.occurred_at DESC LIMIT 1) AS reason
           FROM wa_conversations c JOIN tenants t ON t.id = c.tenant_id LEFT JOIN vendors v ON v.id = c.vendor_id
          WHERE c.state = 'HUMAN_HANDOFF'
          ORDER BY c.updated_at LIMIT 200`,
      );
      return { documents: documents.rows, handoffs: handoffs.rows };
    });
  }

  @Post('review/documents/:id')
  @HttpCode(204)
  @RequireStaffRole('reviewer', 'admin')
  async decide(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const id = uuidParam(raw, 'That document');
    const b = ReviewDecisionSchema.parse(body);
    await inStaff(this.c, async (db) => {
      const d = (
        await db.query<{ tenant_id: string | null; review_status: string; document_type: string }>(
          `SELECT tenant_id, review_status, document_type FROM vendor_documents WHERE id = $1 AND purged_at IS NULL FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!d) throw new ApiError(404, 'not_found', 'That document was not found.');
      if (d.review_status !== 'needs_review') throw new ApiError(409, 'already_decided', 'Someone already decided this document.');
      await db.query(`UPDATE vendor_documents SET review_status = $2, reviewed_at = now(), reviewed_by_staff = $3, review_note = $4 WHERE id = $1`, [
        id,
        b.decision,
        req.staff!.session.subjectId,
        b.note,
      ]);
      // B-BBEE evidence: the profile read from it follows the decision.
      await db.query(`UPDATE vendor_bbbee_profiles SET status = $2 WHERE evidence_document_id = $1 AND status = 'pending_review'`, [id, b.decision]);
      await staffAudit(db, req, { tenantId: d.tenant_id, action: 'document.reviewed', entityType: 'vendor_document', entityId: id, details: { decision: b.decision, note: b.note } });
    });
  }

  // --- Tenants and users -----------------------------------------------------------------------
  @Get('tenants')
  @RequireStaffRole('support', 'admin')
  async tenants(@Req() req: Request) {
    const q = StaffTenantQuerySchema.parse(req.query);
    const { limit, offset } = pageOf(q);
    return inStaff(this.c, async (db) => {
      const r = await db.query<Record<string, unknown> & { total: number }>(
        `SELECT t.id, t.legal_name, t.status, t.created_at,
                (SELECT count(*) FROM tenant_users u WHERE u.tenant_id = t.id AND u.disabled_at IS NULL) AS users,
                (SELECT count(*) FROM tenant_vendors tv WHERE tv.tenant_id = t.id) AS suppliers,
                coalesce(w.balance_cents, 0) AS balance_cents, count(*) OVER () AS total
           FROM tenants t LEFT JOIN wallets w ON w.tenant_id = t.id
          WHERE ($1::text IS NULL OR t.legal_name ILIKE $1) AND ($2::text IS NULL OR t.status = $2)
          ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
        [q.q ? likeTerm(q.q) : null, q.status ?? null, limit, offset],
      );
      return { items: r.rows.map(({ total: _t, ...x }) => x), total: r.rows[0]?.total ?? 0, page: q.page, page_size: q.page_size };
    });
  }

  @Get('tenants/:id')
  @RequireStaffRole('support', 'admin')
  async tenant(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That tenant');
    return inStaff(this.c, async (db) => {
      const t = (
        await db.query(
          `SELECT t.id, t.legal_name, t.status, t.created_at, coalesce(w.balance_cents, 0) AS balance_cents, coalesce(w.held_cents, 0) AS held_cents,
                  (SELECT count(*) FROM tenant_vendors tv WHERE tv.tenant_id = t.id) AS suppliers,
                  (SELECT count(*) FROM monitoring_enrolments m WHERE m.tenant_id = t.id AND m.period @> now()) AS monitored,
                  (SELECT count(*) FROM verifications x WHERE x.tenant_id = t.id AND x.requested_at > now() - interval '30 days') AS verifications_30d
             FROM tenants t LEFT JOIN wallets w ON w.tenant_id = t.id WHERE t.id = $1`,
          [id],
        )
      ).rows[0];
      if (!t) throw new ApiError(404, 'not_found', 'That tenant was not found.');
      const users = await db.query(
        `SELECT id, full_name, email::text AS email, role, mfa_enrolled, CASE WHEN locked_until > now() THEN locked_until END AS locked_until,
                disabled_at IS NOT NULL AS disabled, last_login_at
           FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at`,
        [id],
      );
      const activity = await db.query(
        `SELECT action, actor_type, occurred_at FROM audit_log WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 20`,
        [id],
      );
      // A look at a tenant's records is itself on their record.
      await staffAudit(db, req, { tenantId: id, action: 'staff.support_view', entityType: 'tenant', entityId: id });
      return {
        id: t.id,
        legal_name: t.legal_name,
        status: t.status,
        created_at: t.created_at,
        balance_cents: t.balance_cents,
        held_cents: t.held_cents,
        counts: { suppliers: t.suppliers, monitored: t.monitored, verifications_30d: t.verifications_30d },
        users: users.rows,
        recent_activity: activity.rows,
      };
    });
  }

  @Post('tenants/:id/status')
  @HttpCode(204)
  @RequireStaffRole('admin')
  async status(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const id = uuidParam(raw, 'That tenant');
    const b = TenantStatusSchema.parse(body);
    await inStaff(this.c, async (db) => {
      const cur = (await db.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'That tenant was not found.');
      if (cur.status === 'closed') throw new ApiError(409, 'tenant_closed', 'This tenant is closed.');
      if (cur.status === b.status) throw new ApiError(409, 'no_change', `This tenant is already ${b.status}.`);
      await db.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [id, b.status]);
      await staffAudit(db, req, { tenantId: id, action: b.status === 'suspended' ? 'tenant.suspended' : 'tenant.reinstated', entityType: 'tenant', entityId: id, details: { reason: b.reason } });
    });
  }

  @Post('tenants/:id/verify-chain')
  @HttpCode(200)
  @RequireStaffRole('support', 'admin')
  async verifyChain(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That tenant');
    return inStaff(this.c, async (db) => {
      const r = (await db.query<{ broken: number | null; n: number }>(`SELECT verify_audit_chain($1) AS broken, (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS n`, [id])).rows[0]!;
      await staffAudit(db, req, { tenantId: id, action: 'audit.chain_verified', entityType: 'audit_log', entityId: null, details: { intact: r.broken === null, entries: r.n } });
      return { intact: r.broken === null, entries_checked: r.n, broken_at_sequence: r.broken, checked_at: new Date() };
    });
  }

  @Post('users/:id/unlock')
  @HttpCode(204)
  @RequireStaffRole('support', 'admin')
  async unlock(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That user');
    await inStaff(this.c, async (db) => {
      const r = await db.query<{ tenant_id: string }>(`UPDATE tenant_users SET failed_logins = 0, locked_until = NULL WHERE id = $1 RETURNING tenant_id`, [id]);
      if (!r.rows[0]) throw new ApiError(404, 'not_found', 'That user was not found.');
      await staffAudit(db, req, { tenantId: r.rows[0].tenant_id, action: 'user.unlocked', entityType: 'tenant_user', entityId: id });
    });
  }

  // --- Data-subject requests and purge runs -------------------------------------------------
  @Get('requests')
  @RequireStaffRole('support', 'admin')
  async requests() {
    return inStaff(this.c, async (db) =>
      (
        await db.query(
          `SELECT r.id, t.legal_name AS tenant, v.legal_name AS supplier, r.request_type, r.status, r.received_at, r.due_at,
                  ceil(extract(epoch FROM (r.due_at - now())) / 86400)::integer AS days_left
             FROM data_subject_requests r JOIN tenants t ON t.id = r.tenant_id LEFT JOIN vendors v ON v.id = r.vendor_id
            WHERE r.status NOT IN ('completed', 'refused')
            ORDER BY r.due_at LIMIT 500`,
        )
      ).rows,
    );
  }

  @Get('purge-runs')
  @RequireStaffRole('admin')
  async purgeRuns() {
    return inStaff(this.c, async (db) => (await db.query(`SELECT id, started_at, finished_at, coalesce(counts, '{}'::jsonb) AS counts FROM purge_runs ORDER BY id DESC LIMIT 50`)).rows);
  }

  // --- Bureaus and prices --------------------------------------------------------------------
  @Get('providers')
  @RequireStaffRole('admin')
  async providers() {
    const live = new HealthTracker(this.c.redis, 'tv:health:live');
    const test = new HealthTracker(this.c.redis, 'tv:health:test');
    const rows = await inStaff(this.c, async (db) => ({
      providers: (await db.query(`SELECT code, name, is_active, operator_agreement_signed_on FROM providers ORDER BY code`)).rows,
      caps: (await db.query(`SELECT provider_code, capability, unit_cost_cents, is_live_source, timeout_ms, enabled FROM provider_capabilities ORDER BY provider_code, capability`)).rows,
    }));
    return Promise.all(
      rows.providers.map(async (p) => ({
        ...p,
        capabilities: await Promise.all(
          rows.caps
            .filter((c) => c.provider_code === p.code)
            .map(async ({ provider_code: _p, ...c }) => {
              const h = await (p.code === 'mock' ? test : live).snapshot(p.code, c.capability as Capability);
              return { ...c, health: { circuit: h.circuit, success_rate: h.successRate, latency_ms: h.latencyMs, samples: h.samples } };
            }),
        ),
      })),
    );
  }

  @Patch('providers/:code/:capability')
  @HttpCode(204)
  @RequireStaffRole('admin')
  async capability(@Req() req: Request, @Param('code') code: string, @Param('capability') capability: string, @Body() body: unknown) {
    const b = CapabilityUpdateSchema.parse(body);
    await inStaff(this.c, async (db) => {
      const r = await db.query(`UPDATE provider_capabilities SET enabled = $3 WHERE provider_code = $1 AND capability = $2`, [code, capability, b.enabled]);
      if (!r.rowCount) throw new ApiError(404, 'not_found', 'That bureau capability was not found.');
      await staffAudit(db, req, { tenantId: null, action: 'provider.capability_changed', entityType: 'provider_capability', entityId: `${code}:${capability}`, details: b });
    });
  }

  @Get('prices')
  @RequireStaffRole('admin')
  async prices() {
    return inStaff(this.c, async (db) =>
      (await db.query(`SELECT sku, description, billing_type, unit_price_cents, effective_from, effective_to FROM price_book ORDER BY sku, effective_from DESC`)).rows,
    );
  }

  /** Prices change from a date, never in place: the old row ends the day before (history kept). */
  @Post('prices')
  @HttpCode(201)
  @RequireStaffRole('admin')
  async setPrice(@Req() req: Request, @Body() body: unknown) {
    const b = NewPriceSchema.parse(body);
    await inStaff(this.c, async (db) => {
      const cur = (
        await db.query<{ description: string; billing_type: string; effective_from: string; unit_price_cents: number; past: boolean }>(
          `SELECT description, billing_type, effective_from, unit_price_cents, $2::date < current_date AS past
             FROM price_book WHERE sku = $1 AND effective_to IS NULL FOR UPDATE`,
          [b.sku, b.effective_from],
        )
      ).rows[0];
      if (!cur) throw new ApiError(404, 'unknown_sku', 'There is no current price for that SKU.');
      if (cur.past) throw new ApiError(422, 'past_date', 'A new price starts today or later.');
      if (b.effective_from <= cur.effective_from) throw new ApiError(422, 'before_current', `The current price starts on ${cur.effective_from}; a new one must start after it.`);
      await db.query(`UPDATE price_book SET effective_to = $2::date - 1 WHERE sku = $1 AND effective_to IS NULL`, [b.sku, b.effective_from]);
      await db.query(`INSERT INTO price_book (sku, description, billing_type, unit_price_cents, effective_from) VALUES ($1, $2, $3, $4, $5)`, [
        b.sku,
        cur.description,
        cur.billing_type,
        b.unit_price_cents,
        b.effective_from,
      ]);
      await staffAudit(db, req, { tenantId: null, action: 'price.set', entityType: 'price_book', entityId: b.sku, details: { from_cents: cur.unit_price_cents, to_cents: b.unit_price_cents, effective_from: b.effective_from } });
    });
    return { ok: true };
  }

  // --- The sandbox mail outbox ---------------------------------------------------------------
  @Get('mail')
  @RequireStaffRole('support', 'admin')
  async mail(@Req() req: Request) {
    const q = StaffMailQuerySchema.parse(req.query);
    const { limit, offset } = pageOf(q);
    return inStaff(this.c, async (db) => {
      const r = await db.query<Record<string, unknown> & { total: number }>(
        `SELECT m.id, t.legal_name AS tenant, m.to_email::text AS to_email, m.template, m.subject, m.status, m.created_at, count(*) OVER () AS total
           FROM email_outbox m LEFT JOIN tenants t ON t.id = m.tenant_id
          WHERE ($1::text IS NULL OR m.to_email::text ILIKE $1 OR m.subject ILIKE $1) AND ($2::text IS NULL OR m.template = $2)
          ORDER BY m.created_at DESC LIMIT $3 OFFSET $4`,
        [q.q ? likeTerm(q.q) : null, q.template ?? null, limit, offset],
      );
      return { items: r.rows.map(({ total: _t, ...x }) => x), total: r.rows[0]?.total ?? 0, page: q.page, page_size: q.page_size };
    });
  }

  /**
   * A message's text holds its links (sign-in, reset). Only the sandbox, where nothing is
   * delivered, shows it, and reading one is on the record. Outside the sandbox mail reaches its
   * recipient, and a staff member must never hold a working link to someone else's account.
   */
  @Get('mail/:id')
  @RequireStaffRole('support', 'admin')
  async mailOne(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That message');
    if (this.c.config.SANDBOX !== 'true') throw new ApiError(404, 'not_found', 'Message text is only shown in the sandbox.');
    return inStaff(this.c, async (db) => {
      const m = (
        await db.query(
          `SELECT m.id, m.tenant_id, t.legal_name AS tenant, m.to_email::text AS to_email, m.template, m.subject, m.status, m.created_at, m.body_text
             FROM email_outbox m LEFT JOIN tenants t ON t.id = m.tenant_id WHERE m.id = $1`,
          [id],
        )
      ).rows[0];
      if (!m) throw new ApiError(404, 'not_found', 'That message was not found.');
      await staffAudit(db, req, { tenantId: m.tenant_id, action: 'staff.mail_viewed', entityType: 'email_outbox', entityId: id, details: { template: m.template } });
      const { tenant_id: _t, ...out } = m;
      return utcInstants(out);
    });
  }
}
