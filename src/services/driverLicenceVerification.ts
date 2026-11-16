import type { Pool, PoolClient } from 'pg';
import type { ConsentAttestation, ConsentService } from '../consent/consentService';
import {
  GracePeriod,
  LicenceCode,
  licenceCovers,
  normaliseLicenceCode,
  PrdpCategory,
  prdpCovers,
  validityState,
} from '../domain/sa/driverLicence';
import { parseSaId } from '../domain/sa/saId';
import { withTenantTx } from '../lib/db';
import { type Crypto, mask } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import type { Capability, LicenceRecord } from '../providers/types';
import type { Attempt } from '../waterfall/engine';
import type { CheckResolver, ResolvedCheck } from './checkResolver';
import { AuthContext, CheckRecord, createVerification, deriveOutcome, finalizeVerification } from './lifecycle';

export interface DriverLicenceInput {
  idNumber: string;
  licenceNumber: string | null;
  surname: string | null;
  requiredCodes: LicenceCode[];
  requiredPrdp: PrdpCategory[];
  vendorId: string | null;
  externalRef: string | null;
  consentId: string | null;
  consentAttestation: ConsentAttestation | null;
  freshness: 'cached_ok' | 'live';
  mode: 'sync' | 'async';
  monitor: boolean;
}

export interface DriverServiceDeps {
  pool: Pool;
  crypto: Crypto;
  resolvers: { live: CheckResolver; test: CheckResolver };
  consent: ConsentService;
  log: Logger;
  syncDeadlineMs: number;
  costCeilingCents: number;
  prdpImplies?: Partial<Record<PrdpCategory, PrdpCategory[]>>;
}

export class DriverLicenceVerificationService {
  constructor(private readonly d: DriverServiceDeps) {}

  async start(auth: AuthContext, input: DriverLicenceInput, requestId: string): Promise<{ verificationId: string; done: boolean }> {
    // Professional drivers are adults; resolves the YY century ambiguity.
    const id = parseSaId(input.idNumber, { minAge: 16 });
    const subjectBidx = this.d.crypto.blindIndex('sa_id', id.normalised);
    const subjectFingerprint = this.d.crypto.blindIndex('subject', `driver|${id.normalised}|${input.licenceNumber ?? ''}`, auth.tenantId);
    const subjectDisplay = `${input.surname ? input.surname.charAt(0).toUpperCase() + '. ' : ''}(${mask(id.normalised, 4)})`;

    const created = await withTenantTx(this.d.pool, auth.tenantId, async (client) => {
      let tenantVendorId: string | null = null;
      if (input.vendorId) {
        const tv = await client.query<{ id: string }>(`SELECT id FROM tenant_vendors WHERE tenant_id = $1 AND vendor_id = $2`, [auth.tenantId, input.vendorId]);
        if (!tv.rows[0]) throw new ApiError(404, 'vendor_not_found', 'vendor_id is not linked to this account');
        tenantVendorId = tv.rows[0].id;
      }

      // The driver is a natural person who is not party to the buyer's
      // contract: consent (direct, or attested by the employer on the
      // driver's behalf with evidence) is always required.
      let consentId = input.consentId;
      if (!consentId && input.consentAttestation) {
        consentId = await this.d.consent.recordAttestation(client, {
          tenantId: auth.tenantId,
          vendorId: input.vendorId,
          apiKeyId: auth.apiKeyId,
          attestation: { ...input.consentAttestation, subjectRefBidx: subjectBidx },
          requestMeta: { request_id: requestId },
        });
      }
      if (!consentId) throw new ApiError(422, 'consent_required', 'Driver consent is required', { missing_purposes: ['driver_licence_verification'] });
      const purposes: Array<'driver_licence_verification' | 'continuous_monitoring'> = ['driver_licence_verification'];
      if (input.monitor) purposes.push('continuous_monitoring');
      const consent = await this.d.consent.assertPurposes(client, auth.tenantId, consentId, purposes);
      if (consent.subjectRefBidx && !consent.subjectRefBidx.equals(subjectBidx)) {
        throw new ApiError(422, 'consent_subject_mismatch', 'The consent was given by a different person');
      }

      const graces = await client.query<{ expired_from: string; expired_to: string; valid_until: string; gazette_reference: string }>(
        `SELECT expired_from::text, expired_to::text, valid_until::text, gazette_reference FROM ref_regulatory_grace_periods
          WHERE document_type IN ('driver_licence_card','prdp') AND valid_until >= current_date`,
      );

      const v = await createVerification(client, {
        auth,
        requestId,
        type: 'driver_licence',
        sku: 'DRIVER_LICENCE_CHECK',
        subjectFingerprint,
        subjectDisplay,
        checksRequested: ['licence', 'prdp'],
        vendorId: input.vendorId,
        tenantVendorId,
        consentId,
      });
      return {
        ...v,
        tenantVendorId,
        graces: graces.rows.map((g) => ({ expiredFrom: g.expired_from, expiredTo: g.expired_to, validUntil: g.valid_until, gazetteReference: g.gazette_reference })),
      };
    });

    const job = this.process(auth, input, id.normalised, id.ageYears, subjectBidx, subjectFingerprint, created, requestId).catch(async (err) => {
      this.d.log.error({ err, verificationId: created.verificationId }, 'driver verification crashed');
      await finalizeVerification(this.d.pool, this.d.crypto, {
        tenantId: auth.tenantId,
        verificationId: created.verificationId,
        holdId: created.holdId,
        requestId,
        billable: false,
        outcome: 'unable_to_verify',
        status: 'failed',
        checks: [],
        riskFlags: ['internal_error'],
        attempts: [],
        subjectFingerprint,
        webhookData: { type: 'driver_licence', vendor_id: input.vendorId, external_ref: input.externalRef },
      }).catch((e) => this.d.log.error({ err: e }, 'failed to finalise crashed verification'));
    });

    if (input.mode === 'async') return { verificationId: created.verificationId, done: false };
    const done = await Promise.race([job.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), this.d.syncDeadlineMs))]);
    return { verificationId: created.verificationId, done };
  }

  private async process(
    auth: AuthContext,
    input: DriverLicenceInput,
    idNumber: string,
    ageYears: number,
    subjectBidx: Buffer,
    subjectFingerprint: Buffer,
    created: { verificationId: string; holdId: string | null; tenantVendorId: string | null; graces: GracePeriod[] },
    requestId: string,
  ) {
    const resolver = this.d.resolvers[auth.environment];
    const r = await resolver.resolve(
      'driver_licence',
      `${idNumber}|${input.licenceNumber ?? ''}`,
      { idNumber, licenceNumber: input.licenceNumber, surname: input.surname },
      {
        tenantId: auth.tenantId,
        freshness: input.freshness,
        deadlineAt: Date.now() + Math.max(this.d.syncDeadlineMs * 3, 20_000),
        costCeilingCents: this.d.costCeilingCents,
      },
    );

    const flags = new Set<string>();
    const records = this.evaluate(r, input, idNumber, ageYears, created.graces, flags);
    const outcome = deriveOutcome(records, 'licence');
    const billable = !['error', 'pending'].includes(records[0]!.status);
    const attempts: Array<Attempt & { capability: Capability }> = r.attempts.map((a) => ({ ...a, capability: 'driver_licence' as const }));

    await finalizeVerification(this.d.pool, this.d.crypto, {
      tenantId: auth.tenantId,
      verificationId: created.verificationId,
      holdId: created.holdId,
      requestId,
      billable,
      outcome,
      status: 'completed',
      checks: records,
      riskFlags: [...flags],
      attempts,
      subjectFingerprint,
      webhookData: { type: 'driver_licence', vendor_id: input.vendorId, external_ref: input.externalRef },
      persist: (client) => this.persist(client, auth, input, r, subjectBidx, created),
    });
  }

  private evaluate(
    r: ResolvedCheck<'driver_licence'>,
    input: DriverLicenceInput,
    idNumber: string,
    ageYears: number,
    graces: GracePeriod[],
    flags: Set<string>,
  ): CheckRecord[] {
    const base = { source: r.source, dataAsOf: r.dataAsOf, stale: false };
    if (r.status === 'unavailable') {
      return [
        { ...base, checkType: 'licence', status: 'error', result: null, errorCode: r.unavailableReason },
        { ...base, checkType: 'prdp', status: 'skipped', result: null },
      ];
    }
    if (r.status === 'not_found') {
      flags.add('licence_not_found');
      return [
        { ...base, checkType: 'licence', status: 'not_found', result: null },
        { ...base, checkType: 'prdp', status: 'skipped', result: null },
      ];
    }

    const l: LicenceRecord = r.data!;
    const licenceWarnings: string[] = [];
    let licenceStatus: CheckRecord['status'] = 'passed';

    if (l.idNumber !== idNumber) {
      flags.add('licence_id_number_mismatch');
      licenceStatus = 'failed';
    }
    const codes = l.codes.map(normaliseLicenceCode).filter((c): c is LicenceCode => c !== null);
    const missingCodes = input.requiredCodes.filter((req) => !licenceCovers(codes, req));
    if (missingCodes.length) {
      flags.add('licence_code_insufficient');
      licenceStatus = 'failed';
    }
    let validity: ReturnType<typeof validityState> | null = null;
    if (l.status === 'suspended' || l.status === 'cancelled') {
      flags.add(`licence_${l.status}`);
      licenceStatus = 'failed';
    } else if (l.expiresOn) {
      validity = validityState(l.expiresOn, { graces });
      if (validity.state === 'expired' || l.status === 'expired') {
        flags.add('licence_expired');
        licenceStatus = 'failed';
      } else if (validity.state === 'grace_period') {
        flags.add('licence_in_gazetted_grace_period');
        licenceWarnings.push('licence_in_gazetted_grace_period');
        if (licenceStatus === 'passed') licenceStatus = 'warning';
      } else if (validity.state === 'expiring_soon') {
        licenceWarnings.push('licence_expires_within_30_days');
        if (licenceStatus === 'passed') licenceStatus = 'warning';
      }
    } else {
      licenceWarnings.push('licence_expiry_unknown');
      if (licenceStatus === 'passed') licenceStatus = 'warning';
    }

    const licence: CheckRecord = {
      ...base,
      checkType: 'licence',
      status: licenceStatus,
      warnings: licenceWarnings,
      result: {
        codes,
        required_codes: input.requiredCodes,
        missing_codes: missingCodes,
        status: l.status,
        expires_on: l.expiresOn,
        days_remaining: validity?.daysRemaining ?? null,
        grace_reference: validity?.graceReference ?? null,
        restrictions: l.restrictions,
        licence_number_last4: l.licenceNumber ? l.licenceNumber.slice(-4) : null,
      },
    };

    // PrDP
    const prdpWarnings: string[] = [];
    let prdpStatus: CheckRecord['status'] = 'passed';
    const held = (l.prdp?.categories ?? []).filter((c): c is PrdpCategory => ['G', 'P', 'D'].includes(c));
    const missingPrdp = input.requiredPrdp.filter((req) => !prdpCovers(held, req, this.d.prdpImplies));
    const prdpValidity = l.prdp?.expiresOn ? validityState(l.prdp.expiresOn, { graces }) : null;

    if (!l.prdp) {
      prdpStatus = input.requiredPrdp.length ? 'failed' : 'skipped';
      if (input.requiredPrdp.length) flags.add('prdp_missing');
    } else {
      if (missingPrdp.length) {
        flags.add('prdp_category_insufficient');
        prdpStatus = 'failed';
      }
      if (prdpValidity?.state === 'expired') {
        flags.add('prdp_expired');
        prdpStatus = input.requiredPrdp.length ? 'failed' : 'warning';
        if (!input.requiredPrdp.length) prdpWarnings.push('prdp_expired');
      } else if (prdpValidity?.state === 'expiring_soon' && prdpStatus === 'passed') {
        prdpWarnings.push('prdp_expires_within_30_days');
        prdpStatus = 'warning';
      }
      if (held.includes('D') && ageYears < 25) {
        flags.add('prdp_d_holder_under_25');
        prdpWarnings.push('prdp_d_holder_under_25');
        if (prdpStatus === 'passed') prdpStatus = 'warning';
      }
    }

    const prdp: CheckRecord = {
      ...base,
      checkType: 'prdp',
      status: prdpStatus,
      warnings: prdpWarnings,
      result: l.prdp
        ? { categories: held, required_categories: input.requiredPrdp, missing_categories: missingPrdp, expires_on: l.prdp.expiresOn, days_remaining: prdpValidity?.daysRemaining ?? null }
        : null,
    };
    return [licence, prdp];
  }

  private async persist(
    client: PoolClient,
    auth: AuthContext,
    input: DriverLicenceInput,
    r: ResolvedCheck<'driver_licence'>,
    subjectBidx: Buffer,
    created: { tenantVendorId: string | null },
  ) {
    if (!input.vendorId || r.status !== 'found' || !r.data) return;
    const l = r.data;
    const holder = `${input.surname ? input.surname.charAt(0).toUpperCase() + '.' : ''} (${mask(l.idNumber, 4)})`;
    const lic = await client.query<{ id: string }>(
      `INSERT INTO vendor_credentials (vendor_id, tenant_id, credential_type, holder_display, holder_id_bidx, attributes, issuer, valid_from, valid_until, status, verified_at, purge_after)
       VALUES ($1, $2, 'driver_licence', $3, $4, $5, 'RTMC/eNaTIS', $6, $7, $8, now(), now() + interval '5 years') RETURNING id`,
      [input.vendorId, auth.tenantId, holder, subjectBidx, JSON.stringify({ codes: l.codes, restrictions: l.restrictions }), l.issuedOn, l.expiresOn, l.status === 'valid' ? 'valid' : l.status === 'expired' ? 'expired' : 'suspended'],
    );
    let prdpId: string | null = null;
    if (l.prdp) {
      const p = await client.query<{ id: string }>(
        `INSERT INTO vendor_credentials (vendor_id, tenant_id, credential_type, holder_display, holder_id_bidx, attributes, issuer, valid_until, status, verified_at, purge_after)
         VALUES ($1, $2, 'prdp', $3, $4, $5, 'RTMC/eNaTIS', $6, $7, now(), now() + interval '5 years') RETURNING id`,
        [input.vendorId, auth.tenantId, holder, subjectBidx, JSON.stringify({ categories: l.prdp.categories }), l.prdp.expiresOn, l.prdp.expiresOn && l.prdp.expiresOn < new Date().toISOString().slice(0, 10) ? 'expired' : 'valid'],
      );
      prdpId = p.rows[0]!.id;
    }
    if (input.monitor && created.tenantVendorId) {
      for (const [id, exp] of [[lic.rows[0]!.id, l.expiresOn], [prdpId, l.prdp?.expiresOn ?? null]] as const) {
        if (!id || !exp) continue;
        await client.query(
          `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, next_action_at, next_action)
           VALUES ($1, $2, 'credential', $3, $4, GREATEST(now(), ($4::date - 60)::timestamptz), 'remind')
           ON CONFLICT (tenant_vendor_id, subject_type, subject_id) DO NOTHING`,
          [auth.tenantId, created.tenantVendorId, id, exp],
        );
      }
    }
  }
}
