import { Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import {
  type AuthContext,
  availableBalance,
  type ConsentAttestation,
  Errors,
  normaliseTaxReference,
  normaliseTcsPin,
  normaliseVatNumber,
  presentVerification,
  priceFor,
} from '@tshepovet/core';
import { CHECK_SORTS, CheckListQuerySchema, PortalCompanyCheckSchema, PortalDriverCheckSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { inTenant, likeTerm, me, notFound, orderBy, pageOf, uuidParam, Where } from './tenant';

const REQUESTER = `
  CASE WHEN v.requested_by_user IS NOT NULL THEN 'user' WHEN v.requested_by_api_key IS NOT NULL THEN 'api_key' ELSE 'system' END AS actor_type,
  coalesce(u.full_name, k.name) AS actor_name`;
const JOINS = `
  LEFT JOIN tenant_vendors tv ON tv.id = v.tenant_vendor_id
  LEFT JOIN vendors vv ON vv.id = v.vendor_id
  LEFT JOIN tenant_users u ON u.id = v.requested_by_user
  LEFT JOIN api_keys k ON k.id = v.requested_by_api_key`;

const SORTS: Record<(typeof CHECK_SORTS)[number], string> = {
  requested_at: 'v.requested_at',
  completed_at: 'v.completed_at',
  outcome: 'v.outcome',
  price_cents: 'v.price_cents',
};

async function loadCheck(client: PoolClient, id: string) {
  const r = await client.query(`SELECT v.*, tv.external_ref, vv.legal_name AS supplier_name, ${REQUESTER} FROM verifications v ${JOINS} WHERE v.id = $1`, [id]);
  return r.rows[0];
}

function present(row: Record<string, unknown>, balance?: number | null) {
  return {
    ...presentVerification(row as never, { wallet_balance_cents: balance ?? null }),
    supplier_id: (row.tenant_vendor_id as string | null) ?? null,
    supplier_name: (row.supplier_name as string | null) ?? null,
    requested_by: { type: row.actor_type, name: row.actor_name ?? null },
  };
}

/**
 * Checks from the portal: the same services, ledger and audit as /v1, with the signed-in user
 * as the requester and consent ticked on the form. In the sandbox the mock bureau answers
 * (deterministic magic values, docs/05-api.md) but the price book applies, so the wallet,
 * holds and ledger behave exactly as they will in production.
 */
@Controller('api/checks')
@UseGuards(PortalGuard)
export class ChecksController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private auth(req: Request): AuthContext {
    const u = me(req);
    const sandbox = this.c.config.SANDBOX === 'true';
    return { tenantId: u.tenantId, apiKeyId: null, userId: u.userId, environment: sandbox ? 'test' : 'live', chargeTestChecks: sandbox, scopes: [] };
  }

  @Get('prices')
  @RequirePermission('checks:run')
  async prices(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => {
      const t = me(req).tenantId;
      const settings = await client.query<{ settings: { require_consent_for_all_checks?: boolean } }>(`SELECT settings FROM tenants WHERE id = $1`, [t]);
      return {
        company: { sku: 'COMPANY_CHECK', price_cents: await priceFor(client, t, 'COMPANY_CHECK', 'live') },
        company_live: { sku: 'COMPANY_CHECK_LIVE', price_cents: await priceFor(client, t, 'COMPANY_CHECK_LIVE', 'live') },
        driver: { sku: 'DRIVER_LICENCE_CHECK', price_cents: await priceFor(client, t, 'DRIVER_LICENCE_CHECK', 'live') },
        available_cents: await availableBalance(client, t),
        sandbox: this.c.config.SANDBOX === 'true',
        consent_always_required: Boolean(settings.rows[0]?.settings?.require_consent_for_all_checks),
      };
    });
  }

  @Post('company')
  @RequirePermission('checks:run')
  async company(@Req() req: Request, @Res() res: Response) {
    const b = PortalCompanyCheckSchema.parse(req.body);
    const vat = b.vat_number ? normaliseVatNumber(b.vat_number) : null;
    if (b.vat_number && !vat) throw Errors.validation({ issues: [{ path: 'vat_number', message: 'SA VAT numbers are 10 digits starting with 4.' }] });
    const taxRef = b.tax_reference_number ? normaliseTaxReference(b.tax_reference_number) : null;
    if (b.tax_reference_number && !taxRef) throw Errors.validation({ issues: [{ path: 'tax_reference_number', message: 'Tax reference numbers are 10 digits.' }] });
    const pin = b.tcs_pin ? normaliseTcsPin(b.tcs_pin).pin : null;
    const u = me(req);

    let attestation: ConsentAttestation | null = null;
    if (b.consent) {
      attestation = {
        subjectType: 'juristic_person',
        subjectRole: 'vendor_entity',
        subjectRefBidx: null,
        subjectDisplay: b.registration_number,
        onBehalfOfSubject: false,
        noticeCode: 'company_verification',
        purposes: [
          { purpose: 'kyb_company_verification', lawfulBasis: 'legitimate_interest_responsible_party' },
          ...(b.checks.includes('tcs') ? [{ purpose: 'tax_compliance_verification' as const, lawfulBasis: 'consent' as const }] : []),
          ...(b.monitor ? [{ purpose: 'continuous_monitoring' as const, lawfulBasis: 'consent' as const }] : []),
        ],
        capturedAt: new Date().toISOString(),
        method: 'web_checkbox',
        evidenceReference: b.consent.evidence_reference,
        attestedBy: `user:${u.userId}`,
      };
    }
    const { verificationId, done } = await this.c.company.start(
      this.auth(req),
      {
        registrationNumber: b.registration_number,
        vatNumber: vat,
        taxReferenceNumber: taxRef,
        tcsPin: pin,
        checks: b.checks,
        externalRef: b.external_ref ?? null,
        consentId: null,
        consentAttestation: attestation,
        freshness: b.freshness,
        maxAgeSeconds: null,
        mode: 'sync',
        monitor: b.monitor,
      },
      req.requestId,
    );
    await this.respond(req, res, verificationId, done);
  }

  @Post('driver')
  @RequirePermission('checks:run')
  async driver(@Req() req: Request, @Res() res: Response) {
    const b = PortalDriverCheckSchema.parse(req.body);
    const u = me(req);
    let vendorId: string | null = null;
    if (b.supplier_id) {
      vendorId = await inTenant(this.c, req, async (client) => {
        const r = await client.query<{ vendor_id: string }>(`SELECT vendor_id FROM tenant_vendors WHERE id = $1`, [b.supplier_id]);
        if (!r.rows[0]) throw notFound('That supplier');
        return r.rows[0].vendor_id;
      });
    }
    const { verificationId, done } = await this.c.driver.start(
      this.auth(req),
      {
        idNumber: b.id_number,
        licenceNumber: b.licence_number?.toUpperCase() ?? null,
        surname: b.surname ?? null,
        requiredCodes: b.required_codes,
        requiredPrdp: b.required_prdp,
        vendorId,
        externalRef: b.external_ref ?? null,
        consentId: null,
        consentAttestation: {
          subjectType: 'natural_person',
          subjectRole: 'driver',
          subjectRefBidx: null,
          subjectDisplay: b.surname ? `Driver ${b.surname}` : 'Driver',
          onBehalfOfSubject: b.consent.on_behalf_of_subject,
          noticeCode: 'driver_verification',
          purposes: [{ purpose: 'driver_licence_verification', lawfulBasis: 'consent' }],
          capturedAt: new Date().toISOString(),
          method: 'web_checkbox',
          evidenceReference: b.consent.evidence_reference,
          attestedBy: `user:${u.userId}`,
        },
        freshness: 'cached_ok',
        mode: 'sync',
        monitor: false,
      },
      req.requestId,
    );
    await this.respond(req, res, verificationId, done);
  }

  @Get()
  @RequirePermission('suppliers:read')
  async list(@Req() req: Request) {
    const q = CheckListQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const w = new Where();
      if (q.q) {
        const t = likeTerm(q.q);
        w.add(`(v.subject_display ILIKE ? OR vv.legal_name ILIKE ? OR tv.external_ref ILIKE ?)`, t, t, t);
      }
      if (q.type) w.add(`v.verification_type = ?`, q.type);
      if (q.status) w.add(`v.status = ?`, q.status);
      if (q.outcome) w.add(`v.outcome = ?`, q.outcome);
      if (q.supplier_id) w.add(`v.tenant_vendor_id = ?`, q.supplier_id);
      const { limit, offset } = pageOf(q);
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n FROM verifications v ${JOINS} ${w.sql}`, w.params);
      const rows = await client.query(
        `SELECT v.id, v.verification_type AS type, v.subject_display AS subject, v.tenant_vendor_id AS supplier_id, vv.legal_name AS supplier_name,
                v.status, v.outcome, v.risk_flags, v.price_cents, v.charged, ${REQUESTER}, v.requested_at, v.completed_at
           FROM verifications v ${JOINS} ${w.sql}
          ORDER BY ${orderBy(q, SORTS, 'requested_at', 'v.id')} LIMIT ${w.bind(limit)} OFFSET ${w.bind(offset)}`,
        w.params,
      );
      return {
        items: rows.rows.map(({ actor_type, actor_name, ...r }) => ({ ...r, requested_by: { type: actor_type, name: actor_name ?? null } })),
        total: total.rows[0]!.n,
        page: q.page,
        page_size: q.page_size,
      };
    });
  }

  @Get(':id')
  @RequirePermission('suppliers:read')
  async one(@Req() req: Request, @Param('id') rawId: string) {
    const id = uuidParam(rawId, 'That check');
    return inTenant(this.c, req, async (client) => {
      const row = await loadCheck(client, id);
      if (!row) throw notFound('That check');
      return present(row);
    });
  }

  /** 200 with the result when the check finished in time, else 202 and the client polls GET /api/checks/{id}. */
  private async respond(req: Request, res: Response, id: string, done: boolean) {
    // wallet_balance_cents means what it means on /v1: the balance after this check's charge.
    const { row, balance } = await inTenant(this.c, req, async (client) => ({
      row: await loadCheck(client, id),
      balance: (await client.query<{ b: number }>(`SELECT balance_cents AS b FROM wallets WHERE tenant_id = $1`, [me(req).tenantId])).rows[0]?.b ?? null,
    }));
    if (!row) throw notFound('That check');
    const finished = done && row.status !== 'processing';
    res.setHeader('location', `/api/checks/${id}`);
    res.status(finished ? 200 : 202).json(present(row, finished ? balance : null));
  }
}
