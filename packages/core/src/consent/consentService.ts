import type { PoolClient } from 'pg';
import { sha256 } from '../lib/crypto';
import { ApiError, Errors } from '../lib/errors';

/**
 * POPIA consent & lawful-basis checks.
 *
 * Not every check needs consent - POPIA s11 offers six lawful bases and
 * consent is the weakest operationally (it can be withdrawn at any time,
 * s11(2)(b)). TshepoVet's default mapping:
 *
 *   registration / vat / directors (public register)  legitimate interest (s11(1)(f)) + s18 notice
 *   tcs (SARS PIN)                                    consent - the PIN is the taxpayer's own disclosure
 *   driver licence / PrDP                             consent of the DRIVER (natural person), captured by
 *                                                     TshepoVet or attested by the employer (on_behalf_of)
 *   continuous monitoring                             consent (ongoing processing beyond the original check)
 *
 * Buyers can make consent mandatory for every check via tenant settings.
 */
export type Purpose =
  | 'kyb_company_verification'
  | 'director_identity_verification'
  | 'tax_compliance_verification'
  | 'driver_licence_verification'
  | 'bbbee_verification'
  | 'bank_account_verification'
  | 'continuous_monitoring'
  | 'passport_sharing'
  | 'conflict_of_interest_screening'
  | 'document_ocr_processing'
  | 'cross_border_processing'
  | 'whatsapp_service_messages'
  | 'direct_marketing';

export type LawfulBasis =
  | 'consent'
  | 'contract'
  | 'legal_obligation'
  | 'legitimate_interest_subject'
  | 'public_law_duty'
  | 'legitimate_interest_responsible_party';

export interface ConsentAttestation {
  subjectType: 'juristic_person' | 'natural_person';
  subjectRole: 'vendor_entity' | 'authorised_representative' | 'director' | 'beneficial_owner' | 'driver' | 'sole_proprietor';
  subjectRefBidx: Buffer | null;
  subjectDisplay: string;
  onBehalfOfSubject: boolean;
  noticeCode: string;
  purposes: Array<{ purpose: Purpose; lawfulBasis: LawfulBasis }>;
  capturedAt: string;
  /** api_attestation: the buyer's system attests over /v1. web_checkbox: a portal user ticks it. */
  method: 'api_attestation' | 'web_checkbox';
  /** Buyer's own evidence pointer (e.g. signed onboarding form id). */
  evidenceReference: string;
  attestedBy: string;
}

function canonical(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((obj as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(obj);
}

export class ConsentService {
  /** Verify a stored consent covers all purposes; returns the subject bidx for cross-checks. */
  async assertPurposes(client: PoolClient, tenantId: string, consentId: string, purposes: Purpose[]): Promise<{ subjectRefBidx: Buffer | null }> {
    const header = await client.query<{ tenant_id: string; expires_at: Date | null; subject_ref_bidx: Buffer | null }>(
      `SELECT tenant_id, expires_at, subject_ref_bidx FROM consent_records WHERE id = $1`,
      [consentId],
    );
    const h = header.rows[0];
    if (!h || h.tenant_id !== tenantId) throw new ApiError(422, 'consent_not_found', 'consent_id does not exist for this account');
    if (h.expires_at && h.expires_at < new Date()) throw new ApiError(422, 'consent_expired', 'The referenced consent has expired');

    const r = await client.query<{ purpose: Purpose }>(
      `SELECT purpose FROM consent_purposes WHERE consent_id = $1 AND withdrawn_at IS NULL AND purpose = ANY($2::text[])`,
      [consentId, purposes],
    );
    const have = new Set(r.rows.map((x) => x.purpose));
    const missing = purposes.filter((p) => !have.has(p));
    if (missing.length) throw Errors.consentRequired(missing);
    return { subjectRefBidx: h.subject_ref_bidx };
  }

  async recordAttestation(
    client: PoolClient,
    args: {
      tenantId: string;
      vendorId: string | null;
      apiKeyId: string | null;
      userId?: string | null;
      attestation: ConsentAttestation;
      requestMeta: Record<string, unknown>;
    },
  ): Promise<string> {
    const a = args.attestation;
    // The notice the subject was shown: the web version for a portal checkbox, else the API one.
    const channel = a.method === 'web_checkbox' ? 'web' : 'api';
    const notice = await client.query<{ id: string; body_sha256: Buffer }>(
      `SELECT id, body_sha256 FROM privacy_notices
        WHERE code = $1 AND channel = $2 AND language = 'en' AND effective_from <= now() AND retired_at IS NULL
        ORDER BY version DESC LIMIT 1`,
      [a.noticeCode, channel],
    );
    if (!notice.rows[0]) throw new ApiError(422, 'notice_not_found', `No active privacy notice '${a.noticeCode}'`);

    const evidence = {
      method: a.method,
      evidence_reference: a.evidenceReference,
      attested_by: a.attestedBy,
      captured_at: a.capturedAt,
      on_behalf_of_subject: a.onBehalfOfSubject,
      purposes: a.purposes,
      request: args.requestMeta,
    };
    const evidenceHash = sha256(Buffer.concat([Buffer.from(canonical(evidence)), notice.rows[0].body_sha256]));

    const c = await client.query<{ id: string }>(
      `INSERT INTO consent_records (tenant_id, vendor_id, subject_type, subject_role, subject_ref_bidx, subject_display,
                                    on_behalf_of_subject, notice_id, capture_method, evidence, evidence_sha256,
                                    captured_by_api_key, captured_by_user, granted_at, purge_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now() + interval '5 years')
       RETURNING id`,
      [
        args.tenantId,
        args.vendorId,
        a.subjectType,
        a.subjectRole,
        a.subjectRefBidx,
        a.subjectDisplay,
        a.onBehalfOfSubject,
        notice.rows[0].id,
        a.method,
        JSON.stringify(evidence),
        evidenceHash,
        args.apiKeyId,
        args.userId ?? null,
        a.capturedAt,
      ],
    );
    const consentId = c.rows[0]!.id;
    for (const p of a.purposes) {
      await client.query(
        `INSERT INTO consent_purposes (consent_id, tenant_id, purpose, lawful_basis) VALUES ($1, $2, $3, $4)`,
        [consentId, args.tenantId, p.purpose, p.lawfulBasis],
      );
    }
    return consentId;
  }

  async withdraw(client: PoolClient, consentId: string, purposes: Purpose[] | 'all', channel: string): Promise<number> {
    const r = await client.query(
      `UPDATE consent_purposes SET withdrawn_at = now(), withdrawal_channel = $3
        WHERE consent_id = $1 AND withdrawn_at IS NULL AND ($2::text[] IS NULL OR purpose = ANY($2::text[]))`,
      [consentId, purposes === 'all' ? null : purposes, channel],
    );
    return r.rowCount ?? 0;
  }
}
