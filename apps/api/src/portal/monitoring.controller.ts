import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { ApiError, enqueueWebhook } from '@tshepovet/core';
import { CalendarQuerySchema, EnrolSchema, PaymentLockSchema, UpdateEnrolmentSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { supplierRow } from './suppliers.controller';
import { auditBy, inTenant, me, notFound, uuidParam } from './tenant';

const ENROLMENT_SELECT = `
  SELECT tv.id AS supplier_id, v.legal_name, lower(m.period) AS since, m.erp_lock_enabled, tv.payment_lock_status, tv.payment_lock_reason,
         (SELECT min(e.expires_on) FROM expiry_schedules e WHERE e.tenant_vendor_id = tv.id AND e.state IN ('scheduled','expired','locked')) AS next_expiry_on
    FROM monitoring_enrolments m
    JOIN tenant_vendors tv ON tv.id = m.tenant_vendor_id
    JOIN vendors v ON v.id = tv.vendor_id
   WHERE m.period @> now()`;

/** Whether the supplier has consented to continuous monitoring (and not withdrawn it). */
async function hasMonitoringConsent(client: PoolClient, vendorId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM consent_records cr JOIN consent_purposes cp ON cp.consent_id = cr.id
      WHERE cr.vendor_id = $1 AND cp.purpose = 'continuous_monitoring' AND cp.withdrawn_at IS NULL
        AND (cr.expires_at IS NULL OR cr.expires_at > now()) LIMIT 1`,
    [vendorId],
  );
  return Boolean(r.rowCount);
}

/**
 * Continuous monitoring: which suppliers are watched, what expires when, and the payment lock
 * the accounting-system webhook acts on. Monitoring is ongoing processing beyond the original
 * check, so it needs the supplier's consent (POPIA s11; docs/03 §3.3A).
 */
@Controller('api/monitoring')
@UseGuards(PortalGuard)
export class MonitoringController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get()
  @RequirePermission('suppliers:read')
  async overview(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => {
      const enrolments = await client.query(`${ENROLMENT_SELECT} ORDER BY v.legal_name`);
      const counts = await client.query<{ locked: number; expiring_30d: number; expired: number }>(
        `SELECT (SELECT count(*) FROM tenant_vendors WHERE payment_lock_status = 'locked') AS locked,
                (SELECT count(*) FROM expiry_schedules WHERE state = 'scheduled' AND expires_on BETWEEN current_date AND current_date + 30) AS expiring_30d,
                (SELECT count(*) FROM expiry_schedules WHERE state IN ('expired','locked') OR (state = 'scheduled' AND expires_on < current_date)) AS expired`,
      );
      return { counts: { enrolled: enrolments.rowCount ?? 0, ...counts.rows[0]! }, enrolments: enrolments.rows };
    });
  }

  @Get('calendar')
  @RequirePermission('suppliers:read')
  async calendar(@Req() req: Request) {
    const q = CalendarQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `SELECT e.id, tv.id AS supplier_id, v.legal_name, e.subject_type, e.expires_on, e.grace_until, e.state, e.next_action, e.next_action_at
           FROM expiry_schedules e JOIN tenant_vendors tv ON tv.id = e.tenant_vendor_id JOIN vendors v ON v.id = tv.vendor_id
          WHERE e.expires_on BETWEEN $1 AND $2 AND e.state <> 'cancelled'
          ORDER BY e.expires_on, v.legal_name`,
        [q.from, q.to],
      );
      return r.rows;
    });
  }

  @Get('alerts')
  @RequirePermission('suppliers:read')
  async alerts(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `SELECT 'expiry:' || e.id AS id,
                CASE WHEN e.state = 'locked' THEN 'locked' WHEN e.state = 'expired' OR e.expires_on < current_date THEN 'expired' ELSE 'expiring' END AS kind,
                tv.id AS supplier_id, v.legal_name, e.subject_type, e.expires_on, (e.expires_on - current_date) AS days, NULL::text AS reason
           FROM expiry_schedules e JOIN tenant_vendors tv ON tv.id = e.tenant_vendor_id JOIN vendors v ON v.id = tv.vendor_id
          WHERE e.state IN ('scheduled','expired','locked') AND e.expires_on <= current_date + 30
         UNION ALL
         SELECT 'lock:' || tv.id, 'locked', tv.id, v.legal_name, NULL, NULL, NULL, tv.payment_lock_reason
           FROM tenant_vendors tv JOIN vendors v ON v.id = tv.vendor_id
          WHERE tv.payment_lock_status = 'locked'
          ORDER BY days NULLS FIRST, legal_name`,
      );
      return r.rows;
    });
  }

  @Post(':supplierId')
  @HttpCode(201)
  @RequirePermission('monitoring:manage')
  async enrol(@Req() req: Request, @Param('supplierId') raw: string) {
    const id = uuidParam(raw, 'That supplier');
    const b = EnrolSchema.parse(req.body ?? {});
    const u = me(req);
    return inTenant(this.c, req, async (client) => {
      const tv = (await client.query<{ vendor_id: string; status: string }>(`SELECT vendor_id, status FROM tenant_vendors WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!tv) throw notFound('That supplier');
      if (['rejected', 'offboarded'].includes(tv.status)) throw new ApiError(409, 'supplier_inactive', 'Monitoring is for current suppliers. This one is rejected or offboarded.');
      const active = await client.query(`SELECT 1 FROM monitoring_enrolments WHERE tenant_vendor_id = $1 AND period @> now()`, [id]);
      if (active.rowCount) throw new ApiError(409, 'already_monitored', 'This supplier is already monitored.');

      if (!(await hasMonitoringConsent(client, tv.vendor_id))) {
        if (!b.consent) throw new ApiError(422, 'consent_required', 'Monitoring needs the supplier’s consent.', { missing_purposes: ['continuous_monitoring'] });
        const vendor = await client.query<{ legal_name: string }>(`SELECT legal_name FROM vendors WHERE id = $1`, [tv.vendor_id]);
        await this.c.consent.recordAttestation(client, {
          tenantId: u.tenantId,
          vendorId: tv.vendor_id,
          apiKeyId: null,
          userId: u.userId,
          attestation: {
            subjectType: 'juristic_person',
            subjectRole: 'vendor_entity',
            subjectRefBidx: null,
            subjectDisplay: vendor.rows[0]?.legal_name ?? 'Supplier',
            onBehalfOfSubject: false,
            noticeCode: 'company_verification',
            purposes: [{ purpose: 'continuous_monitoring', lawfulBasis: 'consent' }],
            capturedAt: new Date().toISOString(),
            method: 'web_checkbox',
            evidenceReference: b.consent.evidence_reference,
            attestedBy: `user:${u.userId}`,
          },
          requestMeta: { request_id: req.requestId },
        });
      }
      await client.query(`INSERT INTO monitoring_enrolments (tenant_id, tenant_vendor_id, period, erp_lock_enabled) VALUES ($1, $2, tstzrange(now(), NULL), $3)`, [
        u.tenantId,
        id,
        b.erp_lock_enabled,
      ]);
      await auditBy(client, req, { action: 'monitoring.enrolled', entityType: 'tenant_vendor', entityId: id, details: { erp_lock_enabled: b.erp_lock_enabled } });
      return (await client.query(`${ENROLMENT_SELECT} AND tv.id = $1`, [id])).rows[0];
    });
  }

  @Patch(':supplierId')
  @RequirePermission('monitoring:manage')
  async update(@Req() req: Request, @Param('supplierId') raw: string) {
    const id = uuidParam(raw, 'That supplier');
    const b = UpdateEnrolmentSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(`UPDATE monitoring_enrolments SET erp_lock_enabled = $2 WHERE tenant_vendor_id = $1 AND period @> now()`, [id, b.erp_lock_enabled]);
      if (!r.rowCount) throw notFound('A monitoring enrolment for that supplier');
      await auditBy(client, req, { action: 'monitoring.updated', entityType: 'tenant_vendor', entityId: id, details: b });
      return (await client.query(`${ENROLMENT_SELECT} AND tv.id = $1`, [id])).rows[0];
    });
  }

  @Delete(':supplierId')
  @HttpCode(204)
  @RequirePermission('monitoring:manage')
  async end(@Req() req: Request, @Param('supplierId') raw: string) {
    const id = uuidParam(raw, 'That supplier');
    await inTenant(this.c, req, async (client) => {
      const r = await endMonitoring(client, id);
      if (!r) throw notFound('A monitoring enrolment for that supplier');
      await auditBy(client, req, { action: 'monitoring.ended', entityType: 'tenant_vendor', entityId: id });
    });
  }

  @Post(':supplierId/payment-lock')
  @HttpCode(200)
  @RequirePermission('monitoring:manage')
  async paymentLock(@Req() req: Request, @Param('supplierId') raw: string) {
    const id = uuidParam(raw, 'That supplier');
    const b = PaymentLockSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      const cur = (
        await client.query<{ payment_lock_status: string; vendor_id: string; external_ref: string | null }>(
          `SELECT payment_lock_status, vendor_id, external_ref FROM tenant_vendors WHERE id = $1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!cur) throw notFound('That supplier');
      if (cur.payment_lock_status === b.status) throw new ApiError(409, 'no_change', `Payments are already ${b.status === 'override' ? 'overridden' : b.status}.`);
      await client.query(`UPDATE tenant_vendors SET payment_lock_status = $2, payment_lock_reason = $3 WHERE id = $1`, [id, b.status, b.reason]);
      await auditBy(client, req, { action: `payments.${b.status}`, entityType: 'tenant_vendor', entityId: id, details: { from: cur.payment_lock_status, reason: b.reason } });
      // The accounting system hears about a lock through the buyer's own webhook endpoint.
      if (b.status === 'locked') {
        await enqueueWebhook(client, me(req).tenantId, 'vendor.payment_locked', id, {
          supplier_id: id,
          vendor_id: cur.vendor_id,
          external_ref: cur.external_ref,
          reason: b.reason,
          source: 'manual',
        });
      }
      return supplierRow(client, id);
    });
  }
}

/** Closes a supplier's open monitoring enrolment. Returns whether there was one. */
export async function endMonitoring(client: PoolClient, tenantVendorId: string): Promise<boolean> {
  const r = await client.query(`UPDATE monitoring_enrolments SET period = tstzrange(lower(period), now()) WHERE tenant_vendor_id = $1 AND period @> now()`, [
    tenantVendorId,
  ]);
  return Boolean(r.rowCount);
}
