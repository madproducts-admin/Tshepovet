import { RequestHandler, Response, Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { LICENCE_CODES, PRDP_CATEGORIES } from '../domain/sa/driverLicence';
import { normaliseTaxReference, normaliseTcsPin, normaliseVatNumber } from '../domain/sa/tax';
import { withTenantTx } from '../lib/db';
import { ApiError, Errors } from '../lib/errors';
import type { CompanyVerificationService } from '../services/companyVerification';
import type { DriverLicenceVerificationService } from '../services/driverLicenceVerification';
import { loadVerification, presentVerification } from '../services/lifecycle';

const PURPOSES = [
  'kyb_company_verification',
  'director_identity_verification',
  'tax_compliance_verification',
  'driver_licence_verification',
  'continuous_monitoring',
] as const;

const ConsentAttestationSchema = z.object({
  notice_code: z.enum(['company_verification', 'driver_verification']),
  subject_display: z.string().min(1).max(120),
  subject_role: z.enum(['vendor_entity', 'authorised_representative', 'director', 'driver', 'sole_proprietor']),
  on_behalf_of_subject: z.boolean().default(false),
  purposes: z.array(z.enum(PURPOSES)).min(1),
  captured_at: z.string().datetime({ offset: true }),
  evidence_reference: z.string().min(1).max(200),
  attested_by: z.string().min(1).max(200),
});

const freshness = z.enum(['cached_ok', 'live']).default('cached_ok');
const mode = z.enum(['sync', 'async']).default('sync');

export const CompanyRequestSchema = z
  .object({
    registration_number: z.string().min(10).max(20),
    vat_number: z.string().max(14).optional(),
    tax_reference_number: z.string().max(14).optional(),
    tcs_pin: z.string().max(30).optional(),
    checks: z.array(z.enum(['registration', 'directors', 'vat', 'tcs'])).min(1).default(['registration', 'directors']),
    external_ref: z.string().max(100).optional(),
    consent_id: z.string().uuid().optional(),
    consent: ConsentAttestationSchema.optional(),
    freshness,
    max_age_seconds: z.number().int().min(60).max(30 * 86_400).optional(),
    mode,
    monitor: z.boolean().default(false),
  })
  .strict();

export const DriverRequestSchema = z
  .object({
    id_number: z.string().min(13).max(15),
    licence_number: z.string().regex(/^[A-Za-z0-9]{6,20}$/).optional(),
    surname: z.string().min(1).max(80).optional(),
    required_codes: z.array(z.enum(LICENCE_CODES)).default([]),
    required_prdp: z.array(z.enum(PRDP_CATEGORIES)).default([]),
    vendor_id: z.string().uuid().optional(),
    external_ref: z.string().max(100).optional(),
    consent_id: z.string().uuid().optional(),
    consent: ConsentAttestationSchema.optional(),
    freshness,
    mode,
    monitor: z.boolean().default(false),
  })
  .strict();

function toAttestation(c: z.infer<typeof ConsentAttestationSchema> | undefined, subjectType: 'juristic_person' | 'natural_person') {
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

export function verifyRouter(deps: { pool: Pool; company: CompanyVerificationService; driver: DriverLicenceVerificationService }) {
  const r = Router();

  /**
   * POST /v1/verify/company
   * 200 completed within the sync deadline, 202 still processing (webhook +
   * GET /v1/verifications/{id} deliver the result). Funds are reserved before
   * any bureau call and captured only for billable outcomes.
   */
  r.post('/verify/company', async (req, res, next) => {
    try {
      const body = CompanyRequestSchema.parse(req.body);
      if (body.consent_id && body.consent) throw new ApiError(400, 'consent_ambiguous', 'Send either consent_id or consent, not both');

      const vat = body.vat_number ? normaliseVatNumber(body.vat_number) : null;
      if (body.vat_number && !vat) throw Errors.validation({ vat_number: 'SA VAT numbers are 10 digits starting with 4' });
      const taxRef = body.tax_reference_number ? normaliseTaxReference(body.tax_reference_number) : null;
      if (body.tax_reference_number && !taxRef) throw Errors.validation({ tax_reference_number: 'Tax reference numbers are 10 digits' });
      const pin = body.tcs_pin ? normaliseTcsPin(body.tcs_pin).pin : null;

      const { verificationId, done } = await deps.company.start(
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
      await respond(deps.pool, req.auth!.tenantId, verificationId, done, res);
    } catch (err) {
      next(err);
    }
  });

  /** POST /v1/verify/driver-license (alias: /driver-licence) */
  const driverHandler: RequestHandler = async (req, res, next) => {
    try {
      const body = DriverRequestSchema.parse(req.body);
      if (body.consent_id && body.consent) throw new ApiError(400, 'consent_ambiguous', 'Send either consent_id or consent, not both');
      if (!body.consent_id && !body.consent) throw new ApiError(422, 'consent_required', 'Driver consent is required', { missing_purposes: ['driver_licence_verification'] });
      const { verificationId, done } = await deps.driver.start(
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
      await respond(deps.pool, req.auth!.tenantId, verificationId, done, res);
    } catch (err) {
      next(err);
    }
  };
  r.post('/verify/driver-license', driverHandler);
  r.post('/verify/driver-licence', driverHandler);

  return r;
}

export function verificationsRouter(pool: Pool) {
  const r = Router();
  r.get('/verifications/:id', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const row = await loadVerification(pool, req.auth!.tenantId, id);
      if (!row) throw Errors.notFound('Verification');
      res.json(presentVerification(row));
    } catch (err) {
      next(err);
    }
  });
  return r;
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
