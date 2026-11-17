import { Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { can, MODULES, portalOpenApi, UpdateSettingsSchema } from '@tshepovet/contracts';
import { vatRateFor, vatRegistered } from '@tshepovet/core';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { AUDIT_ACTOR_NAME, auditBy, inTenant, me } from './tenant';

const DEFAULT_PREFERENCES = {
  require_consent_for_all_checks: false,
  notify_low_balance: true,
  notify_expiries: true,
  expiry_reminder_days: [30, 14, 7],
};

const COI_PENDING = 'Waiting on the POPIA s57 prior-authorisation assessment. It opens once that is done.';

/** Public platform facts (no session), and the signed-in organisation's dashboard and settings. */
@Controller('api')
export class PlatformController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('meta')
  async meta() {
    const r = await this.c.pool.query<{ sku: string; unit_price_cents: number }>(
      `SELECT sku, unit_price_cents FROM price_book WHERE effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)`,
    );
    const price = (sku: string) => r.rows.find((x) => x.sku === sku)?.unit_price_cents ?? 0;
    return {
      sandbox: this.c.config.SANDBOX === 'true',
      currency: 'ZAR' as const,
      vat_rate: vatRateFor(this.c.config),
      vat_registered: vatRegistered(this.c.config),
      check_prices: {
        company_cents: price('COMPANY_CHECK'),
        company_live_cents: price('COMPANY_CHECK_LIVE'),
        driver_cents: price('DRIVER_LICENCE_CHECK'),
        monitoring_per_supplier_month_cents: price('MONITORING_PER_VENDOR'),
      },
      modules: MODULES.map((m) => {
        const reason = m.sku === 'MOD_COI_RADAR' && this.c.config.COI_RADAR_ENABLED !== 'true' ? COI_PENDING : null;
        return { sku: m.sku, name: m.name, description: m.description, price_cents: price(m.sku), available: reason === null, unavailable_reason: reason };
      }),
      seller: {
        legal_name: this.c.config.SELLER_LEGAL_NAME,
        trading_name: this.c.config.SELLER_TRADING_NAME,
        registration_number: this.c.config.SELLER_REGISTRATION_NUMBER ?? null,
        vat_number: this.c.config.SELLER_VAT_NUMBER ?? null,
        address: this.c.config.SELLER_ADDRESS ?? null,
        directors: (this.c.config.SELLER_DIRECTORS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
        email: this.c.config.SELLER_EMAIL ?? null,
        phone: this.c.config.SELLER_PHONE ?? null,
        website: this.c.config.APP_URL,
        information_officer: this.c.config.SELLER_INFORMATION_OFFICER ?? null,
        information_regulator_number: this.c.config.SELLER_INFORMATION_REGULATOR_NUMBER ?? null,
      },
    };
  }

  @Get('openapi.json')
  openapi() {
    return portalOpenApi();
  }
}

@Controller('api')
@UseGuards(PortalGuard)
export class OrganisationController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('overview')
  @RequirePermission('suppliers:read')
  async overview(@Req() req: Request) {
    const u = me(req);
    return inTenant(this.c, req, async (client) => {
      const checks = (
        await client.query<Record<string, number>>(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE status = 'processing') AS processing,
                  count(*) FILTER (WHERE outcome = 'verified') AS verified,
                  count(*) FILTER (WHERE outcome = 'verified_with_warnings') AS verified_with_warnings,
                  count(*) FILTER (WHERE outcome = 'failed_checks') AS failed_checks,
                  count(*) FILTER (WHERE outcome = 'not_found') AS not_found,
                  count(*) FILTER (WHERE outcome = 'unable_to_verify') AS unable_to_verify
             FROM verifications WHERE requested_at >= date_trunc('month', now())`,
        )
      ).rows[0]!;
      const finished = checks.total! - checks.processing!;
      const suppliers = (
        await client.query<Record<string, number>>(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE status = 'approved') AS approved,
                  count(*) FILTER (WHERE status IN ('invited','onboarding','pending_review')) AS in_progress,
                  count(*) FILTER (WHERE status = 'suspended' OR payment_lock_status = 'locked') AS needs_attention
             FROM tenant_vendors WHERE status NOT IN ('rejected','offboarded')`,
        )
      ).rows[0]!;
      const due = (
        await client.query<{ due: number; alerts: number }>(
          `SELECT count(*) FILTER (WHERE state = 'scheduled' AND expires_on BETWEEN current_date AND current_date + 30) AS due,
                  count(*) FILTER (WHERE state IN ('expired','locked') OR (state = 'scheduled' AND expires_on < current_date)) AS alerts
             FROM expiry_schedules`,
        )
      ).rows[0]!;
      const w = (
        await client.query<{ balance_cents: number; held_cents: number; available_cents: number; low: boolean }>(
          `SELECT balance_cents, held_cents, balance_cents - held_cents + credit_limit_cents AS available_cents,
                  (balance_cents - held_cents + credit_limit_cents) < low_balance_threshold_cents AS low
             FROM wallets WHERE tenant_id = $1`,
          [u.tenantId],
        )
      ).rows[0];
      const recent = await client.query(
        `SELECT v.id, v.verification_type AS type, v.subject_display AS subject, vv.legal_name AS supplier_name, v.status, v.outcome, v.requested_at
           FROM verifications v LEFT JOIN vendors vv ON vv.id = v.vendor_id ORDER BY v.requested_at DESC LIMIT 5`,
      );
      const activity = can(u.role, 'audit:read')
        ? (
            await client.query(
              `SELECT a.id, a.occurred_at, a.actor_type, ${AUDIT_ACTOR_NAME} AS actor_name, a.action, a.entity_type FROM audit_log a ORDER BY a.id DESC LIMIT 10`,
            )
          ).rows.map((a) => ({ id: a.id, occurred_at: a.occurred_at, actor: { type: a.actor_type, name: a.actor_name ?? null }, action: a.action, entity_type: a.entity_type }))
        : [];
      return {
        checks_this_month: checks,
        verified_rate: finished > 0 ? (checks.verified! + checks.verified_with_warnings!) / finished : null,
        suppliers,
        expiries_due_30d: due.due,
        alerts: due.alerts + (suppliers.needs_attention ?? 0),
        wallet: w
          ? { balance_cents: w.balance_cents, held_cents: w.held_cents, available_cents: w.available_cents, low_balance: w.low }
          : { balance_cents: 0, held_cents: 0, available_cents: 0, low_balance: true },
        recent_checks: recent.rows,
        recent_activity: activity,
      };
    });
  }

  private async settings(client: PoolClient, tenantId: string) {
    const t = (
      await client.query(
        `SELECT id, legal_name, cipc_enterprise_number AS registration_number, vat_number, information_officer_email::text AS information_officer_email,
                is_public_sector, data_region, status, created_at, settings
           FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0];
    const { settings, ...organisation } = t;
    const prefs = { ...DEFAULT_PREFERENCES };
    for (const k of Object.keys(DEFAULT_PREFERENCES) as Array<keyof typeof DEFAULT_PREFERENCES>) {
      if (settings?.[k] !== undefined) (prefs as Record<string, unknown>)[k] = settings[k];
    }
    return { organisation, preferences: prefs };
  }

  @Get('settings')
  async get(@Req() req: Request) {
    return inTenant(this.c, req, (client) => this.settings(client, me(req).tenantId));
  }

  @Patch('settings')
  @RequirePermission('settings:manage')
  async update(@Req() req: Request) {
    const b = UpdateSettingsSchema.parse(req.body);
    const t = me(req).tenantId;
    return inTenant(this.c, req, async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [t];
      const o = b.organisation ?? {};
      const columns: Record<string, string> = {
        legal_name: 'legal_name',
        registration_number: 'cipc_enterprise_number',
        vat_number: 'vat_number',
        information_officer_email: 'information_officer_email',
        is_public_sector: 'is_public_sector',
      };
      for (const [k, col] of Object.entries(columns)) {
        const v = (o as Record<string, unknown>)[k];
        if (v !== undefined) sets.push(`${col} = $${params.push(v)}`);
      }
      if (b.preferences) sets.push(`settings = settings || $${params.push(JSON.stringify(b.preferences))}::jsonb`);
      await client.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $1`, params);
      await auditBy(client, req, {
        action: 'settings.updated',
        entityType: 'tenant',
        entityId: t,
        details: { organisation: Object.keys(o), preferences: Object.keys(b.preferences ?? {}) },
      });
      return this.settings(client, t);
    });
  }
}
