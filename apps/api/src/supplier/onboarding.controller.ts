import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import {
  ApiError,
  audit,
  type AuthContext,
  enqueueMail,
  normaliseTaxReference,
  normaliseTcsPin,
  postValidate,
  SANDBOX_SAMPLES,
  type SandboxSample,
  sandboxExtraction,
  sha256,
  type Thresholds,
  tokenHash,
  withTenantTx,
} from '@tshepovet/core';
import {
  OnboardingBankSchema,
  OnboardingCompanySchema,
  OnboardingSampleSchema,
  OnboardingSkipSchema,
  OnboardingStartSchema,
  type OnboardingState,
  OnboardingSubmitSchema,
  OnboardingTaxSchema,
} from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { clientIp } from '../portal/auth.service';

/**
 * Supplier onboarding from a buyer's invitation (docs/PLAN.md M6). The invitation token is the
 * only credential: it arrives in the X-Onboarding-Token header (never a URL path, which ends
 * up in logs), onboarding_open() resolves it, and every write then runs inside the buyer's
 * tenant (RLS). Checks started here are charged to the buyer's wallet like any other check.
 *
 * The steps mirror the WhatsApp flow: consent, the company as the register knows it, an
 * identity document, then (optional) B-BBEE evidence, bank details and a tax PIN, and submit.
 *
 * Anyone can sign up as a buyer and invite an address they control, so what is entered here
 * (contact, documents, bank account, B-BBEE profile) is the inviting buyer's own (tenant_id).
 * It becomes the supplier's shared record, and the passport can go live, only through
 * onboarding_promote() at submit: when the identity document matched an active director on
 * the register (migration 0005).
 */
interface Invite {
  invite_id: string;
  tenant_id: string;
  tenant_vendor_id: string;
  vendor_id: string;
  buyer_name: string;
  email: string;
  contact_name: string | null;
  completed_at: Date | null;
}

interface Progress {
  consent_id?: string;
  contact_id?: string;
  company?: { state: OnboardingState['company']['state']; verification_id?: string };
  identity?: { state: OnboardingState['identity']['state']; document_id?: string; is_director?: boolean };
  bbbee?: { state: OnboardingState['bbbee']['state']; document_id?: string; profile_id?: string; level?: number | null; reasons?: string[] };
  bank?: { state: OnboardingState['bank']['state']; account_id?: string; last4?: string };
  tax?: { state: OnboardingState['tax']['state']; verification_id?: string; detail?: string };
}

const ONBOARDING_PURPOSES = [
  { purpose: 'kyb_company_verification', lawfulBasis: 'legitimate_interest_responsible_party' },
  { purpose: 'director_identity_verification', lawfulBasis: 'consent' },
  { purpose: 'document_ocr_processing', lawfulBasis: 'consent' },
  { purpose: 'bbbee_verification', lawfulBasis: 'consent' },
  { purpose: 'bank_account_verification', lawfulBasis: 'consent' },
  { purpose: 'tax_compliance_verification', lawfulBasis: 'consent' },
  { purpose: 'continuous_monitoring', lawfulBasis: 'consent' },
] as const;

const notFound = () => new ApiError(404, 'invite_not_found', 'This link has expired or was withdrawn. Ask your customer to send a new one.');

const BBBEE_REASONS: Record<string, string> = {
  expired: 'The affidavit is more than 12 months old.',
  affidavit_not_commissioned: 'The affidavit was not signed before a commissioner of oaths.',
  turnover_exceeds_eme_threshold: 'The turnover is too high for an EME affidavit.',
  black_female_exceeds_black: 'Black women’s ownership cannot be more than black ownership.',
  stale_financial_year: 'The financial year is too old.',
  stated_level_mismatch: 'The level on the affidavit does not match the ownership.',
};

@Controller('api/onboarding')
export class OnboardingController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private get sandbox() {
    return this.c.config.SANDBOX === 'true';
  }

  private async open(req: Request): Promise<Invite> {
    const token = req.header('x-onboarding-token') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
    const r = await this.c.pool.query<Invite>(`SELECT * FROM onboarding_open($1)`, [tokenHash(token)]);
    if (!r.rows[0]) throw notFound();
    return r.rows[0];
  }

  /** The buyer's tenant, with the invitation's progress locked for this change. */
  private async change<T>(inv: Invite, fn: (client: PoolClient, p: Progress) => Promise<T>): Promise<T> {
    return withTenantTx(this.c.pool, inv.tenant_id, async (client) => {
      const r = await client.query<{ progress: Progress; completed_at: Date | null }>(`SELECT progress, completed_at FROM vendor_invites WHERE id = $1 FOR UPDATE`, [inv.invite_id]);
      // Checked again under the row lock: a step that started before submit must not write after it.
      if (r.rows[0]!.completed_at) throw new ApiError(409, 'already_submitted', 'This onboarding was already submitted. Your customer is reviewing it.');
      const p = r.rows[0]!.progress;
      const out = await fn(client, p);
      await client.query(`UPDATE vendor_invites SET progress = $2 WHERE id = $1`, [inv.invite_id, JSON.stringify(p)]);
      return out;
    });
  }

  private auth(inv: Invite): AuthContext {
    return { tenantId: inv.tenant_id, apiKeyId: null, userId: null, environment: this.sandbox ? 'test' : 'live', chargeTestChecks: this.sandbox, scopes: [] };
  }

  private auditStep(client: PoolClient, req: Request, inv: Invite, p: Progress, action: string, details: Record<string, unknown> = {}) {
    return audit(client, {
      tenantId: inv.tenant_id,
      actorType: 'vendor_contact',
      actorId: p.contact_id ?? null,
      action,
      entityType: 'tenant_vendor',
      entityId: inv.tenant_vendor_id,
      requestId: req.requestId,
      ip: clientIp(req),
      details: { invite_id: inv.invite_id, ...details },
    });
  }

  private requireOpen(inv: Invite, p: Progress, needConsent = true) {
    if (inv.completed_at) throw new ApiError(409, 'already_submitted', 'This onboarding was already submitted. Your customer is reviewing it.');
    if (needConsent && !p.consent_id) throw new ApiError(409, 'consent_first', 'Read and agree to the notice first.');
  }

  @Get()
  async state(@Req() req: Request): Promise<OnboardingState> {
    const inv = await this.open(req);
    return withTenantTx(this.c.pool, inv.tenant_id, async (client) => {
      await client.query(`UPDATE vendor_invites SET opened_at = coalesce(opened_at, now()) WHERE id = $1`, [inv.invite_id]);
      return this.view(client, inv);
    });
  }

  private async view(client: PoolClient, inv: Invite): Promise<OnboardingState> {
    const r = await client.query<{ progress: Progress; completed_at: Date | null }>(`SELECT progress, completed_at FROM vendor_invites WHERE id = $1`, [inv.invite_id]);
    const p = r.rows[0]!.progress;
    const v = (
      await client.query<{ legal_name: string; registration_number: string | null; entity_kind: string; cipc_status: string | null }>(
        `SELECT legal_name, cipc_enterprise_number AS registration_number, entity_kind, cipc_status FROM vendors WHERE id = $1`,
        [inv.vendor_id],
      )
    ).rows[0]!;
    const contact = p.contact_id
      ? (await client.query<{ full_name: string; email: string }>(`SELECT full_name, email::text AS email FROM vendor_contacts WHERE id = $1`, [p.contact_id])).rows[0] ?? null
      : null;
    const found = p.company && ['found', 'confirmed', 'disputed'].includes(p.company.state);
    const directors = found
      ? (await client.query<{ full_name: string }>(`SELECT full_name FROM vendor_directors WHERE vendor_id = $1 AND status = 'active' ORDER BY full_name`, [inv.vendor_id])).rows.map((d) => d.full_name)
      : [];
    return {
      buyer: inv.buyer_name,
      supplier: { legal_name: v.legal_name, registration_number: v.registration_number, entity_kind: v.entity_kind },
      contact,
      invited_email: inv.email,
      sandbox: this.sandbox,
      consent_given: Boolean(p.consent_id),
      company: { state: p.company?.state ?? 'todo', legal_name: found ? v.legal_name : null, cipc_status: found ? v.cipc_status : null, directors },
      identity: { state: p.identity?.state ?? 'todo', is_director: p.identity?.is_director ?? null },
      bbbee: { state: p.bbbee?.state ?? 'todo', level: p.bbbee?.level ?? null, reasons: p.bbbee?.reasons ?? [] },
      bank: { state: p.bank?.state ?? 'todo', last4: p.bank?.last4 ?? null },
      tax: { state: p.tax?.state ?? 'todo', detail: p.tax?.detail ?? null },
      submitted_at: r.rows[0]!.completed_at?.toISOString() ?? null,
      samples: this.sandbox ? Object.entries(SANDBOX_SAMPLES).map(([id, s]) => ({ id, kind: s.expected as 'identity' | 'bbbee', label: s.label, outcome: s.outcome })) : [],
    };
  }

  /** Step 1: the notice, the supplier's agreement, who is filling this in; then the register lookup. */
  @Post('start')
  @HttpCode(200)
  async start(@Req() req: Request): Promise<OnboardingState> {
    const inv = await this.open(req);
    const b = OnboardingStartSchema.parse(req.body);
    await this.change(inv, async (client, p) => {
      this.requireOpen(inv, p, false);
      if (p.consent_id) return;
      const contact = await client.query<{ id: string }>(
        `INSERT INTO vendor_contacts (vendor_id, tenant_id, full_name, email, role, authority_basis, email_verified_at, purge_after)
         VALUES ($1, $2, $3, $4, $5, 'unverified', now(), now() + interval '5 years')
         ON CONFLICT (vendor_id, email, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE email IS NOT NULL
         DO UPDATE SET full_name = EXCLUDED.full_name, role = coalesce(EXCLUDED.role, vendor_contacts.role), email_verified_at = now()
         RETURNING id`,
        [inv.vendor_id, inv.tenant_id, b.full_name, inv.email, b.role ?? null],
      );
      p.contact_id = contact.rows[0]!.id;
      const v = await client.query<{ legal_name: string }>(`SELECT legal_name FROM vendors WHERE id = $1`, [inv.vendor_id]);
      p.consent_id = await this.c.consent.recordAttestation(client, {
        tenantId: inv.tenant_id,
        vendorId: inv.vendor_id,
        apiKeyId: null,
        userId: null,
        attestation: {
          subjectType: 'juristic_person',
          subjectRole: 'authorised_representative',
          subjectRefBidx: null,
          subjectDisplay: `${b.full_name} for ${v.rows[0]!.legal_name}`,
          onBehalfOfSubject: false,
          noticeCode: 'vendor_onboarding',
          purposes: ONBOARDING_PURPOSES.map((x) => ({ purpose: x.purpose, lawfulBasis: x.lawfulBasis })),
          capturedAt: new Date().toISOString(),
          method: 'web_checkbox',
          evidenceReference: `onboarding:${inv.invite_id}`,
          attestedBy: `vendor_contact:${p.contact_id}`,
        },
        requestMeta: { request_id: req.requestId, ip: clientIp(req) },
      });
      await client.query(`UPDATE consent_records SET given_by_contact_id = $2 WHERE id = $1`, [p.consent_id, p.contact_id]);
      // Ownership by race is special personal information: processed under the B-BBEE redress exemption.
      await client.query(`UPDATE consent_purposes SET special_pi_basis = 's29_bbbee_redress' WHERE consent_id = $1 AND purpose = 'bbbee_verification'`, [p.consent_id]);
      await client.query(`UPDATE tenant_vendors SET status = 'onboarding' WHERE id = $1 AND status = 'invited'`, [inv.tenant_vendor_id]);
      await this.auditStep(client, req, inv, p, 'onboarding.started');
    });
    await this.lookupCompany(req, inv);
    return withTenantTx(this.c.pool, inv.tenant_id, (client) => this.view(client, inv));
  }

  /** The register lookup: registration and directors, charged to the buyer as a company check. */
  private async lookupCompany(req: Request, inv: Invite) {
    const reg = (await withTenantTx(this.c.pool, inv.tenant_id, (c) => c.query<{ r: string | null }>(`SELECT cipc_enterprise_number AS r FROM vendors WHERE id = $1`, [inv.vendor_id]))).rows[0]?.r;
    let state: NonNullable<Progress['company']>['state'] = 'unavailable';
    let verificationId: string | undefined;
    if (reg) {
      try {
        const r = await this.c.company.start(
          this.auth(inv),
          { registrationNumber: reg, vatNumber: null, taxReferenceNumber: null, tcsPin: null, checks: ['registration', 'directors'], externalRef: null, consentId: null, consentAttestation: null, freshness: 'cached_ok', maxAgeSeconds: null, mode: 'sync', monitor: false },
          req.requestId,
        );
        verificationId = r.verificationId;
        const out = await withTenantTx(this.c.pool, inv.tenant_id, (c) => c.query<{ outcome: string | null }>(`SELECT outcome FROM verifications WHERE id = $1`, [r.verificationId]));
        const outcome = out.rows[0]?.outcome;
        state = outcome === 'not_found' ? 'not_found' : outcome && outcome !== 'unable_to_verify' ? 'found' : 'unavailable';
      } catch (err) {
        // An empty wallet on the buyer's side must not block the supplier: the buyer runs it later.
        if (!(err instanceof ApiError && err.code === 'insufficient_funds')) throw err;
      }
    }
    await this.change(inv, async (client, p) => {
      p.company = { state, ...(verificationId ? { verification_id: verificationId } : {}) };
      await this.auditStep(client, req, inv, p, 'onboarding.company_looked_up', { state });
    });
  }

  /** Step 2: "Is this your company?" A "no" goes to the buyer, who follows up. */
  @Post('company')
  @HttpCode(200)
  async company(@Req() req: Request) {
    const inv = await this.open(req);
    const b = OnboardingCompanySchema.parse(req.body);
    return this.change(inv, async (client, p) => {
      this.requireOpen(inv, p);
      if (p.company?.state !== 'found' && p.company?.state !== 'confirmed' && p.company?.state !== 'disputed') {
        throw new ApiError(409, 'nothing_to_confirm', 'The register lookup has not found the company yet.');
      }
      p.company.state = b.correct ? 'confirmed' : 'disputed';
      await this.auditStep(client, req, inv, p, b.correct ? 'onboarding.company_confirmed' : 'onboarding.company_disputed');
      return this.viewAfter(client, inv, p);
    });
  }

  private async viewAfter(client: PoolClient, inv: Invite, p: Progress) {
    await client.query(`UPDATE vendor_invites SET progress = $2 WHERE id = $1`, [inv.invite_id, JSON.stringify(p)]);
    return this.view(client, inv);
  }

  /** Steps 3 and 4: an identity document and B-BBEE evidence (sandbox: a sample document). */
  @Post('documents')
  @HttpCode(200)
  async document(@Req() req: Request) {
    const inv = await this.open(req);
    const b = OnboardingSampleSchema.parse(req.body);
    if (!this.sandbox) throw new ApiError(409, 'uploads_unavailable', 'Document uploads open when TshepoVet goes live.');
    const sample = SANDBOX_SAMPLES[b.sample as SandboxSample];
    if (!sample || sample.expected !== b.kind) throw new ApiError(400, 'unknown_sample', 'Choose one of the sample documents.');
    return this.change(inv, async (client, p) => {
      this.requireOpen(inv, p);
      const extraction = sandboxExtraction(b.sample as SandboxSample);
      const t = (
        await client.query<{ sector_code: string; eme: number; qse: number; verified: boolean }>(
          `SELECT sector_code, eme_max_turnover_cents AS eme, qse_max_turnover_cents AS qse, verified FROM ref_bbbee_thresholds
            WHERE sector_code = 'generic' AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)
            ORDER BY effective_from DESC LIMIT 1`,
        )
      ).rows[0];
      const thresholds: Thresholds | null = t ? { sectorCode: t.sector_code, emeMaxTurnoverCents: t.eme, qseMaxTurnoverCents: t.qse, verified: t.verified } : null;
      const v = postValidate(extraction, b.kind, { bbbeeThresholds: thresholds });

      if (v.outcome === 'retake' || v.outcome === 'wrong_document') {
        if (b.kind === 'identity') p.identity = { state: v.outcome };
        else p.bbbee = { state: v.outcome, reasons: [v.outcome === 'retake' ? 'The photo is not clear enough to read. Take it again in good light.' : 'That is not the document we asked for.'] };
        await this.auditStep(client, req, inv, p, `onboarding.${b.kind}_${v.outcome}`);
        return this.viewAfter(client, inv, p);
      }

      const docType = extraction.document_type;
      const fields = b.kind === 'identity' ? { document_type: docType } : { document_type: docType, level: v.bbbee?.level ?? null };
      const enc = await this.c.crypto.encrypt(JSON.stringify(extraction), `doc_fields:passport:${inv.vendor_id}`);
      const doc = await client.query<{ id: string }>(
        `INSERT INTO vendor_documents (vendor_id, tenant_id, document_type, sha256, mime_type, size_bytes, source_channel, issued_on, expires_on,
                                       extracted_fields, extracted_fields_enc, extraction_confidence, extraction_model, review_status,
                                       image_purge_after, record_purge_after)
         VALUES ($1, $9, $2, $3, 'application/x-sandbox-sample', 1, 'portal', $4, $5, $6, $7, 1, 'sandbox', $8,
                 now() + make_interval(days => (SELECT image_retention_days FROM ref_document_types WHERE code = $2)), now() + interval '5 years')
         RETURNING id`,
        [
          inv.vendor_id,
          docType,
          sha256(`sandbox:${b.sample}`),
          b.kind === 'bbbee' ? (v.bbbee ? extraction.bbbee?.commissioner_of_oaths_date ?? extraction.bbbee?.issue_date ?? null : null) : null,
          b.kind === 'bbbee' ? v.bbbee?.validUntil ?? null : null,
          JSON.stringify(fields),
          enc,
          v.outcome === 'ok' && (b.kind === 'identity' || v.bbbee?.decision === 'accept') ? 'auto_accepted' : v.bbbee?.decision === 'reject' ? 'rejected' : 'needs_review',
          inv.tenant_id,
        ],
      );
      const documentId = doc.rows[0]!.id;

      if (b.kind === 'identity') {
        const bidx = this.c.crypto.blindIndex('sa_id', v.identity!.idNumber);
        const d = await client.query(`SELECT 1 FROM vendor_directors WHERE vendor_id = $1 AND id_number_bidx = $2 AND status = 'active'`, [inv.vendor_id, bidx]);
        const isDirector = Boolean(d.rowCount);
        if (isDirector && p.contact_id) {
          await client.query(`UPDATE vendor_contacts SET authority_basis = 'director', is_authorised_signatory = true WHERE id = $1`, [p.contact_id]);
        }
        p.identity = { state: v.outcome === 'ok' && isDirector ? 'accepted' : 'review', document_id: documentId, is_director: isDirector };
        await this.auditStep(client, req, inv, p, 'onboarding.identity_added', { is_director: isDirector, outcome: v.outcome, flags: v.flags });
      } else {
        const a = v.bbbee!;
        const ex = extraction.bbbee!;
        const issued = ex.commissioner_of_oaths_date ?? ex.issue_date;
        let profileId: string | undefined;
        if (issued && a.validUntil && a.validUntil > issued) {
          const prof = await client.query<{ id: string }>(
            `INSERT INTO vendor_bbbee_profiles (vendor_id, tenant_id, evidence_document_id, evidence_type, sector_code, financial_year_end, annual_turnover_cents,
                                                black_ownership_pct, black_female_ownership_pct, bbbee_level, procurement_recognition_pct,
                                                is_empowering_supplier, issued_on, valid_until, commissioner_of_oaths, validation_flags, status)
             VALUES ($1, $16, $2, $3, 'generic', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [
              inv.vendor_id,
              documentId,
              a.evidenceType,
              ex.financial_year_end,
              ex.annual_turnover_rands === null ? null : Math.round(ex.annual_turnover_rands * 100),
              ex.black_ownership_pct,
              ex.black_female_ownership_pct,
              a.level,
              a.recognitionPct,
              a.isEmpoweringSupplier,
              issued,
              a.validUntil,
              JSON.stringify({ present: ex.commissioner_of_oaths_present, name: ex.commissioner_of_oaths_name, date: ex.commissioner_of_oaths_date }),
              a.flags,
              a.decision === 'accept' ? 'accepted' : a.decision === 'reject' ? 'rejected' : 'pending_review',
              inv.tenant_id,
            ],
          );
          profileId = prof.rows[0]!.id;
        }
        p.bbbee = {
          state: a.decision === 'accept' ? 'accepted' : a.decision === 'reject' ? 'refused' : 'review',
          document_id: documentId,
          ...(profileId ? { profile_id: profileId } : {}),
          level: a.decision === 'accept' ? a.level : null,
          reasons: a.flags.map((f) => BBBEE_REASONS[f]).filter((x): x is string => Boolean(x)),
        };
        await this.auditStep(client, req, inv, p, 'onboarding.bbbee_added', { decision: a.decision, level: a.level, flags: a.flags });
      }
      return this.viewAfter(client, inv, p);
    });
  }

  /** Bank details: stored encrypted; only the last four digits are ever shown. */
  @Post('bank')
  @HttpCode(200)
  async bank(@Req() req: Request) {
    const inv = await this.open(req);
    const b = OnboardingBankSchema.parse(req.body);
    const enc = await this.c.crypto.encrypt(b.account_number, `bank_account:${inv.vendor_id}`);
    return this.change(inv, async (client, p) => {
      this.requireOpen(inv, p);
      // One account per onboarding: a changed account is a conversation with the customer, not a resubmission.
      if (p.bank?.state === 'added') throw new ApiError(409, 'bank_already_added', 'Bank details were already added. Ask your customer if they need to change.');
      const acct = await client.query<{ id: string }>(
        `INSERT INTO vendor_bank_accounts (vendor_id, tenant_id, bank_name, account_number_enc, account_number_bidx, account_last4, account_type, avs_status, purge_after)
         VALUES ($1, $7, $2, $3, $4, $5, $6, 'not_checked', now() + interval '5 years') RETURNING id`,
        [inv.vendor_id, b.bank_name, enc, this.c.crypto.blindIndex('bank_account', b.account_number), b.account_number.slice(-4), b.account_type, inv.tenant_id],
      );
      p.bank = { state: 'added', account_id: acct.rows[0]!.id, last4: b.account_number.slice(-4) };
      await this.auditStep(client, req, inv, p, 'onboarding.bank_added');
      return this.viewAfter(client, inv, p);
    });
  }

  /** The tax PIN: checked with SARS at once (charged to the buyer), then kept only as long as the rules allow. */
  @Post('tax')
  @HttpCode(200)
  async tax(@Req() req: Request) {
    const inv = await this.open(req);
    const b = OnboardingTaxSchema.parse(req.body);
    const taxRef = normaliseTaxReference(b.tax_reference_number);
    if (!taxRef) throw new ApiError(400, 'invalid_tax_reference', 'Enter the 10-digit income tax reference number.');
    const pin = normaliseTcsPin(b.tcs_pin).pin;
    const pre = await withTenantTx(this.c.pool, inv.tenant_id, (c) =>
      c.query<{ progress: Progress; reg: string | null }>(
        `SELECT i.progress, v.cipc_enterprise_number AS reg FROM vendor_invites i JOIN vendors v ON v.id = $2 WHERE i.id = $1`,
        [inv.invite_id, inv.vendor_id],
      ),
    );
    const p0 = pre.rows[0]!.progress;
    this.requireOpen(inv, p0);
    if (!pre.rows[0]!.reg) throw new ApiError(409, 'no_registration', 'Tax compliance is checked against a registered company.');
    let state: NonNullable<Progress['tax']>['state'] = 'problem';
    let detail: string | undefined;
    let verificationId: string | undefined;
    try {
      const r = await this.c.company.start(
        this.auth(inv),
        { registrationNumber: pre.rows[0]!.reg, vatNumber: null, taxReferenceNumber: taxRef, tcsPin: pin, checks: ['registration', 'tcs'], externalRef: null, consentId: p0.consent_id!, consentAttestation: null, freshness: 'cached_ok', maxAgeSeconds: null, mode: 'sync', monitor: false },
        req.requestId,
      );
      verificationId = r.verificationId;
      const res = await withTenantTx(this.c.pool, inv.tenant_id, (c) => c.query<{ result: Record<string, { status: string; result: Record<string, unknown> | null }> | null }>(`SELECT result FROM verifications WHERE id = $1`, [r.verificationId]));
      const tcs = res.rows[0]?.result?.tcs;
      const status = tcs?.result?.tcs_status;
      const pinStatus = tcs?.result?.pin_status;
      if (status === 'compliant') state = 'compliant';
      else if (status === 'non_compliant') state = 'non_compliant';
      detail = pinStatus === 'expired' ? 'The PIN has expired. Ask SARS eFiling for a new one.' : pinStatus === 'revoked' ? 'The PIN was withdrawn on eFiling.' : status === 'non_compliant' ? 'SARS says the company is not tax compliant.' : undefined;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_funds') detail = 'Your customer will check the PIN later.';
      else throw err;
    }
    return this.change(inv, async (client, p) => {
      p.tax = { state, ...(verificationId ? { verification_id: verificationId } : {}), ...(detail ? { detail } : {}) };
      await this.auditStep(client, req, inv, p, 'onboarding.tax_checked', { state });
      return this.viewAfter(client, inv, p);
    });
  }

  @Post('skip')
  @HttpCode(200)
  async skip(@Req() req: Request) {
    const inv = await this.open(req);
    const b = OnboardingSkipSchema.parse(req.body);
    return this.change(inv, async (client, p) => {
      this.requireOpen(inv, p);
      p[b.step] = { state: 'skipped' };
      await this.auditStep(client, req, inv, p, `onboarding.${b.step}_skipped`);
      return this.viewAfter(client, inv, p);
    });
  }

  /** Submit: the buyer is told; the passport goes live if the supplier chose it. */
  @Post('submit')
  @HttpCode(200)
  async submit(@Req() req: Request) {
    const inv = await this.open(req);
    const b = OnboardingSubmitSchema.parse(req.body);
    return this.change(inv, async (client, p) => {
      this.requireOpen(inv, p);
      if (!p.company || !['confirmed', 'not_found', 'unavailable'].includes(p.company.state)) {
        throw new ApiError(409, 'company_first', 'Confirm your company’s details first.');
      }
      if (!p.identity || !['accepted', 'review'].includes(p.identity.state)) throw new ApiError(409, 'identity_first', 'Add your identity document first.');
      await client.query(`UPDATE tenant_vendors SET status = 'pending_review' WHERE id = $1 AND status IN ('invited','onboarding')`, [inv.tenant_vendor_id]);
      await client.query(`UPDATE vendor_invites SET completed_at = now() WHERE id = $1`, [inv.invite_id]);
      // The progress (with the ids promotion checks) is saved first; then the database decides.
      await client.query(`UPDATE vendor_invites SET progress = $2 WHERE id = $1`, [inv.invite_id, JSON.stringify(p)]);
      const pr = (await client.query<{ promoted: boolean; published: boolean }>(`SELECT * FROM onboarding_promote($1, $2)`, [inv.invite_id, b.publish_passport])).rows[0]!;
      if (pr.published) {
        await client.query(`INSERT INTO consent_purposes (consent_id, tenant_id, purpose, lawful_basis) VALUES ($1, $2, 'passport_sharing', 'consent') ON CONFLICT DO NOTHING`, [
          p.consent_id,
          inv.tenant_id,
        ]);
      }
      await this.auditStep(client, req, inv, p, 'onboarding.submitted', { shared_record_updated: pr.promoted, passport_published: pr.published });
      const admins = await client.query<{ email: string }>(`SELECT email::text AS email FROM tenant_users WHERE role IN ('owner','admin','procurement') AND disabled_at IS NULL`);
      const v = await client.query<{ legal_name: string }>(`SELECT legal_name FROM vendors WHERE id = $1`, [inv.vendor_id]);
      for (const a of admins.rows) {
        await enqueueMail(client, {
          tenantId: inv.tenant_id,
          to: a.email,
          template: 'supplier_onboarded',
          vars: { appUrl: this.c.config.APP_URL, supplier: v.rows[0]!.legal_name, link: `${this.c.config.APP_URL}/app/suppliers/${inv.tenant_vendor_id}` },
        });
      }
      inv.completed_at = new Date();
      return this.viewAfter(client, inv, p);
    });
  }
}
