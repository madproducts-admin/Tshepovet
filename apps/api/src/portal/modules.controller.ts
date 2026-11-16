import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { activateModule, activeModules, ApiError, cancelModule, type ModuleSku, priceFor } from '@tshepovet/core';
import { AddSpendSchema, MODULES, ModuleSkuSchema, PeriodQuerySchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { auditBy, inTenant, me, notFound, uuidParam } from './tenant';

const COI_PENDING = 'Waiting on the POPIA s57 prior-authorisation assessment. It opens once that is done.';

/**
 * Modules (monthly, paid from the wallet) and the B-BBEE spend and scorecard module.
 *
 * Scorecard method (Codes of Good Practice, preferential procurement): spend lines whose period
 * falls inside the measurement period count in full; a supplier's spend is recognised at its
 * B-BBEE level's procurement recognition percentage when its evidence was accepted and still
 * valid at the start of the period, and at 0% otherwise (flagged, so it can be chased).
 */
@Controller('api/modules')
@UseGuards(PortalGuard)
export class ModulesController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private unavailable(sku: string): string | null {
    return sku === 'MOD_COI_RADAR' && this.c.config.COI_RADAR_ENABLED !== 'true' ? COI_PENDING : null;
  }

  private async view(client: PoolClient, tenantId: string, sku: ModuleSku) {
    const m = MODULES.find((x) => x.sku === sku)!;
    const s = (
      await client.query<{ status: string; current_period_end: string; cancel_at: string | null; in_period: boolean }>(
        `SELECT status, current_period_end, cancel_at, (status = 'active' AND current_date < current_period_end) AS in_period
           FROM subscriptions WHERE sku = $1`,
        [sku],
      )
    ).rows[0];
    const on = Boolean(s?.in_period);
    const reason = this.unavailable(sku);
    return {
      sku,
      name: m.name,
      description: m.description,
      price_cents: await priceFor(client, tenantId, sku, 'live'),
      state: (on ? (s!.cancel_at ? 'ending' : 'on') : 'off') as 'off' | 'on' | 'ending',
      available: reason === null,
      unavailable_reason: reason,
      current_period_end: on ? s!.current_period_end : null,
    };
  }

  private async requireModule(client: PoolClient, sku: ModuleSku) {
    if (!(await activeModules(client)).has(sku)) {
      const name = MODULES.find((m) => m.sku === sku)!.name;
      throw new ApiError(403, 'module_off', `Turn on the ${name} module to use this.`);
    }
  }

  @Get()
  async list(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => Promise.all(MODULES.map((m) => this.view(client, me(req).tenantId, m.sku))));
  }

  // --- B-BBEE (declared before :sku so "bbbee" is never read as a module code) -------------
  @Get('bbbee/spend')
  @RequirePermission('modules:use')
  async spend(@Req() req: Request) {
    const q = PeriodQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      await this.requireModule(client, 'MOD_BBBEE');
      const r = await client.query(
        `SELECT s.id, s.tenant_vendor_id AS supplier_id, v.legal_name, s.period_start, s.period_end, s.amount_cents, s.description, s.created_at
           FROM bbbee_spend s JOIN tenant_vendors tv ON tv.id = s.tenant_vendor_id JOIN vendors v ON v.id = tv.vendor_id
          WHERE s.period_start >= $1 AND s.period_end <= $2 ORDER BY s.period_start, v.legal_name, s.id`,
        [q.from, q.to],
      );
      return r.rows;
    });
  }

  @Post('bbbee/spend')
  @HttpCode(201)
  @RequirePermission('modules:use')
  async addSpend(@Req() req: Request) {
    const b = AddSpendSchema.parse(req.body);
    const u = me(req);
    return inTenant(this.c, req, async (client) => {
      await this.requireModule(client, 'MOD_BBBEE');
      const ids = [...new Set(b.lines.map((l) => l.supplier_id))];
      const known = await client.query<{ id: string }>(`SELECT id FROM tenant_vendors WHERE id = ANY($1::uuid[])`, [ids]);
      const missing = ids.filter((id) => !known.rows.some((k) => k.id === id));
      if (missing.length) throw new ApiError(422, 'unknown_supplier', 'Some lines name a supplier that is not on your list.', { supplier_ids: missing });
      const r = await client.query(
        `WITH ins AS (
           INSERT INTO bbbee_spend (tenant_id, tenant_vendor_id, period_start, period_end, amount_cents, description, created_by)
           SELECT $1, l.supplier_id, l.period_start, l.period_end, l.amount_cents, l.description, $2
             FROM jsonb_to_recordset($3::jsonb) AS l(supplier_id uuid, period_start date, period_end date, amount_cents bigint, description text)
           RETURNING id, tenant_vendor_id, period_start, period_end, amount_cents, description, created_at)
         SELECT ins.id, ins.tenant_vendor_id AS supplier_id, v.legal_name, ins.period_start, ins.period_end, ins.amount_cents, ins.description, ins.created_at
           FROM ins JOIN tenant_vendors tv ON tv.id = ins.tenant_vendor_id JOIN vendors v ON v.id = tv.vendor_id
          ORDER BY ins.period_start, v.legal_name`,
        [u.tenantId, u.userId, JSON.stringify(b.lines)],
      );
      await auditBy(client, req, {
        action: 'bbbee.spend_recorded',
        entityType: 'bbbee_spend',
        entityId: null,
        details: { lines: r.rowCount, total_cents: b.lines.reduce((s, l) => s + l.amount_cents, 0) },
      });
      return r.rows;
    });
  }

  @Delete('bbbee/spend/:id')
  @HttpCode(204)
  @RequirePermission('modules:use')
  async deleteSpend(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That spend line');
    await inTenant(this.c, req, async (client) => {
      await this.requireModule(client, 'MOD_BBBEE');
      const r = await client.query<{ amount_cents: number }>(`DELETE FROM bbbee_spend WHERE id = $1 RETURNING amount_cents`, [id]);
      if (!r.rows[0]) throw notFound('That spend line');
      await auditBy(client, req, { action: 'bbbee.spend_deleted', entityType: 'bbbee_spend', entityId: id, details: { amount_cents: r.rows[0].amount_cents } });
    });
  }

  @Get('bbbee/scorecard')
  @RequirePermission('modules:use')
  async scorecard(@Req() req: Request) {
    const q = PeriodQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      await this.requireModule(client, 'MOD_BBBEE');
      const rows = (
        await client.query<{
          supplier_id: string;
          legal_name: string;
          spend: number;
          level: number | null;
          pct: number | null;
          valid_until: string | null;
          status: string | null;
          evidence_type: string | null;
          black_51: boolean | null;
          black_women_30: boolean | null;
          empowering: boolean | null;
        }>(
          `WITH spend AS (
             SELECT tenant_vendor_id, sum(amount_cents)::bigint AS spend FROM bbbee_spend
              WHERE period_start >= $1 AND period_end <= $2 GROUP BY tenant_vendor_id),
           prof AS (
             SELECT DISTINCT ON (vendor_id) vendor_id, bbbee_level, procurement_recognition_pct::float8 AS pct, valid_until, status, evidence_type,
                    is_51pct_black_owned, is_30pct_black_female_owned, is_empowering_supplier
               FROM vendor_bbbee_profiles
              ORDER BY vendor_id, (status = 'accepted') DESC, valid_until DESC)
           SELECT tv.id AS supplier_id, v.legal_name, sp.spend, p.bbbee_level AS level, p.pct, p.valid_until, p.status, p.evidence_type,
                  p.is_51pct_black_owned AS black_51, p.is_30pct_black_female_owned AS black_women_30, p.is_empowering_supplier AS empowering
             FROM spend sp JOIN tenant_vendors tv ON tv.id = sp.tenant_vendor_id JOIN vendors v ON v.id = tv.vendor_id
             LEFT JOIN prof p ON p.vendor_id = tv.vendor_id
            ORDER BY sp.spend DESC, v.legal_name`,
          [q.from, q.to],
        )
      ).rows;

      const t = { total: 0, recognised: 0, unverified: 0, eme: 0, qse: 0, b51: 0, bw30: 0, emp: 0 };
      const levels = new Map<number | null, { level: number | null; suppliers: number; spend_cents: number; recognised_cents: number }>();
      const suppliers = rows.map((r) => {
        const flags: Array<'no_evidence' | 'evidence_expired' | 'evidence_not_accepted'> = [];
        if (!r.status) flags.push('no_evidence');
        else if (r.status !== 'accepted') flags.push('evidence_not_accepted');
        else if (r.valid_until! < q.from) flags.push('evidence_expired');
        const valid = flags.length === 0;
        const pct = valid ? (r.pct ?? 0) : 0;
        const recognised = Math.round((r.spend * pct) / 100);
        t.total += r.spend;
        t.recognised += recognised;
        if (!valid) t.unverified += r.spend;
        else {
          if (r.evidence_type === 'eme_affidavit' || r.evidence_type === 'cipc_eme_certificate') t.eme += r.spend;
          if (r.evidence_type === 'qse_affidavit') t.qse += r.spend;
          if (r.black_51) t.b51 += r.spend;
          if (r.black_women_30) t.bw30 += r.spend;
          if (r.empowering) t.emp += r.spend;
        }
        const level = valid ? r.level : null;
        const bucket = levels.get(level) ?? { level, suppliers: 0, spend_cents: 0, recognised_cents: 0 };
        bucket.suppliers += 1;
        bucket.spend_cents += r.spend;
        bucket.recognised_cents += recognised;
        levels.set(level, bucket);
        return { supplier_id: r.supplier_id, legal_name: r.legal_name, level, recognition_pct: pct, spend_cents: r.spend, recognised_cents: recognised, valid_until: r.valid_until, flags };
      });
      return {
        period: { from: q.from, to: q.to },
        total_measured_spend_cents: t.total,
        recognised_spend_cents: t.recognised,
        unverified_spend_cents: t.unverified,
        eme_spend_cents: t.eme,
        qse_spend_cents: t.qse,
        black_owned_51_spend_cents: t.b51,
        black_women_owned_30_spend_cents: t.bw30,
        empowering_supplier_spend_cents: t.emp,
        by_level: [...levels.values()].sort((a, b) => (a.level ?? 99) - (b.level ?? 99)),
        suppliers,
      };
    });
  }

  // --- Turning modules on and off ----------------------------------------------------------
  @Post(':sku')
  @HttpCode(200)
  @RequirePermission('settings:manage')
  async activate(@Req() req: Request, @Param('sku') raw: string) {
    const sku = parseSku(raw);
    const reason = this.unavailable(sku);
    if (reason) throw new ApiError(409, 'module_unavailable', reason);
    return inTenant(this.c, req, async (client) => {
      const r = await activateModule(client, { tenantId: me(req).tenantId, sku });
      await auditBy(client, req, {
        action: r.resumed ? 'module.resumed' : 'module.activated',
        entityType: 'subscription',
        entityId: r.subscription.id,
        details: { sku, charged_cents: r.charged_cents, period_end: r.subscription.current_period_end },
      });
      return { module: await this.view(client, me(req).tenantId, sku), charged_cents: r.charged_cents };
    });
  }

  @Delete(':sku')
  @RequirePermission('settings:manage')
  async cancel(@Req() req: Request, @Param('sku') raw: string) {
    const sku = parseSku(raw);
    return inTenant(this.c, req, async (client) => {
      const s = await cancelModule(client, { tenantId: me(req).tenantId, sku });
      await auditBy(client, req, { action: 'module.cancelled', entityType: 'subscription', entityId: s.id, details: { sku, ends_on: s.cancel_at } });
      return { module: await this.view(client, me(req).tenantId, sku), charged_cents: 0 };
    });
  }
}

function parseSku(raw: string): ModuleSku {
  const r = ModuleSkuSchema.safeParse(raw);
  if (!r.success) throw notFound('That module');
  return r.data;
}
