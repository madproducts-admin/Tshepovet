import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ApiError,
  Errors,
  loadVerification,
  normaliseTaxReference,
  normaliseTcsPin,
  normaliseVatNumber,
  presentVerification,
  withTenantTx,
} from '@tshepovet/core';
import { CompanyRequestSchema, type ConsentAttestation, DriverRequestSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';

/**
 * The public /v1 API. Authentication, rate limiting and idempotency run before these handlers
 * as Express middleware mounted on /v1/verify and /v1/verifications (create-http-app.ts),
 * exactly as before the NestJS port, so request handling and responses are unchanged.
 */
@Controller('v1')
export class V1Controller {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  /**
   * POST /v1/verify/company
   * 200 completed within the sync deadline, 202 still processing (webhook +
   * GET /v1/verifications/{id} deliver the result). Funds are reserved before
   * any bureau call and captured only for billable outcomes.
   */
  @Post('verify/company')
  async company(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body = CompanyRequestSchema.parse(req.body);
    if (body.consent_id && body.consent) throw new ApiError(400, 'consent_ambiguous', 'Send either consent_id or consent, not both');

    const vat = body.vat_number ? normaliseVatNumber(body.vat_number) : null;
    if (body.vat_number && !vat) throw Errors.validation({ vat_number: 'SA VAT numbers are 10 digits starting with 4' });
    const taxRef = body.tax_reference_number ? normaliseTaxReference(body.tax_reference_number) : null;
    if (body.tax_reference_number && !taxRef) throw Errors.validation({ tax_reference_number: 'Tax reference numbers are 10 digits' });
    const pin = body.tcs_pin ? normaliseTcsPin(body.tcs_pin).pin : null;

    const { verificationId, done } = await this.c.company.start(
      req.auth!,
      {
        registrationNumber: body.registration_number,
        vatNumber: vat,
        taxReferenceNumber: taxRef,
        tcsPin: pin,
        checks: body.checks,
        externalRef: body.external_ref ?? null,
        consentId: body.consent_id ?? null,
        consentAttestation: toAttestation(body.consent, 'juristic_person'),
        freshness: body.freshness,
        maxAgeSeconds: body.max_age_seconds ?? null,
        mode: body.mode,
        monitor: body.monitor,
      },
      req.requestId,
    );
    await respond(this.c.pool, req.auth!.tenantId, verificationId, done, res);
  }

  /** POST /v1/verify/driver-license (alias: /driver-licence) */
  @Post(['verify/driver-license', 'verify/driver-licence'])
  async driver(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body = DriverRequestSchema.parse(req.body);
    if (body.consent_id && body.consent) throw new ApiError(400, 'consent_ambiguous', 'Send either consent_id or consent, not both');
    if (!body.consent_id && !body.consent) {
      throw new ApiError(422, 'consent_required', 'Driver consent is required', { missing_purposes: ['driver_licence_verification'] });
    }
    const { verificationId, done } = await this.c.driver.start(
      req.auth!,
      {
        idNumber: body.id_number,
        licenceNumber: body.licence_number?.toUpperCase() ?? null,
        surname: body.surname ?? null,
        requiredCodes: body.required_codes,
        requiredPrdp: body.required_prdp,
        vendorId: body.vendor_id ?? null,
        externalRef: body.external_ref ?? null,
        consentId: body.consent_id ?? null,
        consentAttestation: toAttestation(body.consent, 'natural_person'),
        freshness: body.freshness,
        mode: body.mode,
        monitor: body.monitor,
      },
      req.requestId,
    );
    await respond(this.c.pool, req.auth!.tenantId, verificationId, done, res);
  }

  /** GET /v1/verifications/{id} */
  @Get('verifications/:id')
  async verification(@Req() req: Request, @Res() res: Response): Promise<void> {
    const id = z.string().uuid().parse(req.params.id);
    const row = await loadVerification(this.c.pool, req.auth!.tenantId, id);
    if (!row) throw Errors.notFound('Verification');
    res.json(presentVerification(row));
  }
}

function toAttestation(c: ConsentAttestation | undefined, subjectType: 'juristic_person' | 'natural_person') {
  if (!c) return null;
  return {
    subjectType,
    subjectRole: c.subject_role,
    subjectRefBidx: null,
    subjectDisplay: c.subject_display,
    onBehalfOfSubject: c.on_behalf_of_subject,
    noticeCode: c.notice_code,
    purposes: c.purposes.map((purpose) => ({
      purpose,
      lawfulBasis: purpose === 'kyb_company_verification' ? ('legitimate_interest_responsible_party' as const) : ('consent' as const),
    })),
    capturedAt: c.captured_at,
    method: 'api_attestation' as const,
    evidenceReference: c.evidence_reference,
    attestedBy: c.attested_by,
  };
}

async function respond(pool: Pool, tenantId: string, verificationId: string, done: boolean, res: Response) {
  const { row, balance } = await withTenantTx(pool, tenantId, async (c) => {
    const v = await c.query(
      `SELECT v.*, tv.external_ref FROM verifications v LEFT JOIN tenant_vendors tv ON tv.id = v.tenant_vendor_id WHERE v.id = $1`,
      [verificationId],
    );
    const w = await c.query<{ balance_cents: string }>(`SELECT balance_cents FROM wallets WHERE tenant_id = $1`, [tenantId]);
    return { row: v.rows[0], balance: w.rows[0] ? Number(w.rows[0].balance_cents) : null };
  });
  if (!row) throw Errors.notFound('Verification');
  const finished = done && row.status !== 'processing';
  res.setHeader('location', `/v1/verifications/${verificationId}`);
  res.status(finished ? 200 : 202).json(presentVerification(row, { wallet_balance_cents: finished ? balance : null }));
}
