import type { Pool, PoolClient } from 'pg';
import { audit } from '../audit/audit';
import { ConsentService, Purpose } from '../consent/consentService';
import { isRecentlyRegistered, normaliseCipcStatus, parseEnterpriseNumber, ParsedEnterpriseNumber } from '../domain/sa/cipc';
import { parseSaId } from '../domain/sa/saId';
import { daysUntil } from '../domain/sa/tax';
import { withTenantTx } from '../lib/db';
import { type Crypto, mask } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import type { CompanyRecord, VatRecord } from '../providers/types';
import type { TcsResult } from '../domain/sa/tax';
import type { CheckResolver, ResolvedCheck } from './checkResolver';
import { AuthContext, CheckRecord, createVerification, deriveOutcome, finalizeVerification } from './lifecycle';
import type { Attempt } from '../waterfall/engine';
import type { Capability } from '../providers/types';

export interface CompanyVerificationInput {
  registrationNumber: string;
  vatNumber: string | null;
  taxReferenceNumber: string | null;
  tcsPin: string | null;
  checks: Array<'registration' | 'directors' | 'vat' | 'tcs'>;
  externalRef: string | null;
  consentId: string | null;
  consentAttestation: import('../consent/consentService').ConsentAttestation | null;
  freshness: 'cached_ok' | 'live';
  maxAgeSeconds: number | null;
  mode: 'sync' | 'async';
  monitor: boolean;
}

export interface CompanyServiceDeps {
  pool: Pool;
  crypto: Crypto;
  resolvers: { live: CheckResolver; test: CheckResolver };
  consent: ConsentService;
  log: Logger;
  syncDeadlineMs: number;
  costCeilingCents: number;
}

const LEGAL_SUFFIXES = /\b(PROPRIETARY|PTY|LIMITED|LTD|CC|CLOSE CORPORATION|INCORPORATED|INC|NPC|SOC|RF|THE)\b/g;

export function normaliseCompanyName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[()&.,'"-]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function namesMatch(a: string, b: string): boolean {
  const na = normaliseCompanyName(a);
  const nb = normaliseCompanyName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / new Set([...ta, ...tb]).size >= 0.6;
}

export class CompanyVerificationService {
  constructor(private readonly d: CompanyServiceDeps) {}

  /**
   * Validates, links the vendor, records consent, reserves funds, then runs
   * the checks. Returns as soon as the checks finish or the sync deadline
   * passes (in which case the verification continues in the background and a
   * webhook reports completion).
   */
  async start(auth: AuthContext, input: CompanyVerificationInput, requestId: string): Promise<{ verificationId: string; done: boolean }> {
    const parsed = parseEnterpriseNumber(input.registrationNumber);
    const checks = [...new Set(input.checks)];
    if (checks.includes('vat') && !input.vatNumber) throw new ApiError(400, 'vat_number_required', 'checks includes "vat" but vat_number is missing');
    if (checks.includes('tcs') && (!input.taxReferenceNumber || !input.tcsPin)) {
      throw new ApiError(400, 'tcs_inputs_required', 'checks includes "tcs" but tax_reference_number or tcs_pin is missing');
    }
    if (input.tcsPin && input.taxReferenceNumber && input.tcsPin === input.taxReferenceNumber) {
      throw new ApiError(400, 'tcs_pin_is_tax_reference', 'tcs_pin equals the tax reference number; ask the supplier for the PIN issued on eFiling');
    }

    const purposes: Purpose[] = [];
    if (checks.includes('tcs')) purposes.push('tax_compliance_verification');
    if (input.monitor) purposes.push('continuous_monitoring');

    const subjectFingerprint = this.d.crypto.blindIndex('subject', `company|${parsed.normalised}`, auth.tenantId);
    const sku = input.freshness === 'live' ? 'COMPANY_CHECK_LIVE' : 'COMPANY_CHECK';

    const created = await withTenantTx(this.d.pool, auth.tenantId, async (client) => {
      const settings = await client.query<{ settings: { require_consent_for_all_checks?: boolean } }>(`SELECT settings FROM tenants WHERE id = $1`, [auth.tenantId]);
      if (settings.rows[0]?.settings?.require_consent_for_all_checks) purposes.push('kyb_company_verification');

      const vendorId = await this.resolveVendor(client, parsed);
      const tv = await client.query<{ id: string }>(
        `INSERT INTO tenant_vendors (tenant_id, vendor_id, external_ref, onboarding_channel, status)
         VALUES ($1, $2, $3, 'api', 'onboarding')
         ON CONFLICT (tenant_id, vendor_id) DO UPDATE SET external_ref = coalesce(EXCLUDED.external_ref, tenant_vendors.external_ref)
         RETURNING id`,
        [auth.tenantId, vendorId, input.externalRef],
      );
      const tenantVendorId = tv.rows[0]!.id;

      let consentId = input.consentId;
      if (!consentId && input.consentAttestation) {
        consentId = await this.d.consent.recordAttestation(client, {
          tenantId: auth.tenantId,
          vendorId,
          apiKeyId: auth.apiKeyId,
          attestation: input.consentAttestation,
          requestMeta: { request_id: requestId },
        });
      }
      if (purposes.length) {
        if (!consentId) throw new ApiError(422, 'consent_required', 'This request needs consent', { missing_purposes: purposes });
        await this.d.consent.assertPurposes(client, auth.tenantId, consentId, purposes);
      }

      const v = await createVerification(client, {
        auth,
        requestId,
        type: 'company',
        sku,
        subjectFingerprint,
        subjectDisplay: parsed.normalised,
        checksRequested: checks,
        vendorId,
        tenantVendorId,
        consentId,
      });
      return { ...v, vendorId, tenantVendorId };
    });

    const job = this.process(auth, input, parsed, checks, created, subjectFingerprint, requestId).catch(async (err) => {
      this.d.log.error({ err, verificationId: created.verificationId }, 'company verification crashed');
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
        webhookData: { type: 'company', vendor_id: created.vendorId, external_ref: input.externalRef },
      }).catch((e) => this.d.log.error({ err: e }, 'failed to finalise crashed verification'));
    });

    if (input.mode === 'async') return { verificationId: created.verificationId, done: false };
    const done = await Promise.race([job.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), this.d.syncDeadlineMs))]);
    return { verificationId: created.verificationId, done };
  }

  private async resolveVendor(client: PoolClient, parsed: ParsedEnterpriseNumber): Promise<string> {
    const r = await client.query<{ id: string }>(`SELECT resolve_vendor_by_cipc($1, $2, $3, NULL) AS id`, [
      parsed.normalised,
      parsed.typeName ? parsed.typeCode : null,
      parsed.entityKind,
    ]);
    return r.rows[0]!.id;
  }

  private async process(
    auth: AuthContext,
    input: CompanyVerificationInput,
    parsed: ParsedEnterpriseNumber,
    checks: CompanyVerificationInput['checks'],
    created: { verificationId: string; holdId: string | null; vendorId: string; tenantVendorId: string; priceCents: number },
    subjectFingerprint: Buffer,
    requestId: string,
  ) {
    const resolver = this.d.resolvers[auth.environment];
    // Background completion gets a longer deadline than the sync response.
    const deadlineAt = Date.now() + Math.max(this.d.syncDeadlineMs * 3, 20_000);
    const ceiling = input.freshness === 'live' ? this.d.costCeilingCents * 2 : this.d.costCeilingCents;
    const base = { tenantId: auth.tenantId, freshness: input.freshness, maxAgeSeconds: input.maxAgeSeconds ?? undefined, deadlineAt };
    const recent = isRecentlyRegistered(parsed);

    const needCompany = checks.includes('registration') || checks.includes('directors');
    const pinFingerprint = input.tcsPin ? this.d.crypto.blindIndex('tcs_pin', input.tcsPin, auth.tenantId).toString('hex') : null;

    const [company, vat, tcs] = await Promise.all([
      needCompany
        ? resolver.resolve('company_registration', parsed.normalised, { enterpriseNumber: parsed.normalised }, {
            ...base,
            costCeilingCents: Math.round(ceiling * 0.65),
            confirmNotFoundWithLiveSource: recent,
            preferLiveSource: recent,
          })
        : null,
      checks.includes('vat') && input.vatNumber
        ? resolver.resolve('vat_status', input.vatNumber, { vatNumber: input.vatNumber }, { ...base, costCeilingCents: Math.round(ceiling * 0.2) })
        : null,
      checks.includes('tcs') && input.taxReferenceNumber && input.tcsPin
        ? resolver.resolve(
            'tax_compliance_status',
            `${input.taxReferenceNumber}|${pinFingerprint}`,
            { taxReference: input.taxReferenceNumber, pin: input.tcsPin },
            { ...base, costCeilingCents: Math.round(ceiling * 0.15) },
          )
        : null,
    ]);

    const records: CheckRecord[] = [];
    const riskFlags = new Set<string>(parsed.warnings.filter((w) => w === 'close_corporation_after_2011' || w === 'unknown_entity_type_code'));

    if (company && checks.includes('registration')) records.push(this.evaluateRegistration(company, riskFlags));
    if (company && checks.includes('directors')) records.push(this.evaluateDirectors(company, riskFlags));
    if (vat) records.push(this.evaluateVat(vat, company?.data?.legalName ?? null, riskFlags));
    if (tcs) records.push(this.evaluateTcs(tcs, company?.data?.legalName ?? null, riskFlags));

    const primary = records.find((r) => r.checkType === 'registration') ? 'registration' : records[0]?.checkType ?? 'registration';
    const outcome = deriveOutcome(records, primary);
    // Billing policy: the buyer pays when we deliver a definitive registry
    // answer (including "no such company"); provider outages are free.
    const primaryRecord = records.find((r) => r.checkType === primary);
    const billable = Boolean(primaryRecord && !['error', 'pending'].includes(primaryRecord.status));

    const attempts: Array<Attempt & { capability: Capability }> = [
      ...(company?.attempts ?? []).map((a) => ({ ...a, capability: 'company_registration' as const })),
      ...(vat?.attempts ?? []).map((a) => ({ ...a, capability: 'vat_status' as const })),
      ...(tcs?.attempts ?? []).map((a) => ({ ...a, capability: 'tax_compliance_status' as const })),
    ];

    await finalizeVerification(this.d.pool, this.d.crypto, {
      tenantId: auth.tenantId,
      verificationId: created.verificationId,
      holdId: created.holdId,
      requestId,
      billable,
      outcome,
      status: 'completed',
      checks: records,
      riskFlags: [...riskFlags],
      attempts,
      subjectFingerprint,
      webhookData: { type: 'company', vendor_id: created.vendorId, external_ref: input.externalRef },
      persist: (client) => this.persistVendorData(client, auth, input, created, company, vat, tcs, requestId),
    });
  }

  // ------------------------------------------------------------------ evaluation

  private evaluateRegistration(r: ResolvedCheck<'company_registration'>, flags: Set<string>): CheckRecord {
    const base = { checkType: 'registration' as const, source: r.source, dataAsOf: r.dataAsOf, stale: r.stale };
    if (r.status === 'unavailable') return { ...base, status: 'error', result: null, errorCode: r.unavailableReason ?? 'unavailable' };
    if (r.status === 'not_found') {
      if (!r.authoritative) flags.add('not_found_in_cached_registry_copy');
      return { ...base, status: 'not_found', result: null };
    }
    const c = r.data!;
    const { status, risk } = normaliseCipcStatus(c.statusRaw);
    const warnings: string[] = [];
    if (risk === 'high' || risk === 'review') warnings.push(`cipc_status_${status}`);
    if (risk === 'critical') flags.add(`cipc_status_${status}`);
    if (risk === 'high') flags.add(`cipc_status_${status}`);
    if (c.incorporationDate) {
      const ageDays = (Date.now() - Date.parse(c.incorporationDate)) / 86_400_000;
      if (ageDays < 183) {
        flags.add('company_younger_than_6_months');
        warnings.push('company_younger_than_6_months');
      }
    }
    if (r.stale) warnings.push('served_from_stale_cache');
    return {
      ...base,
      status: risk === 'critical' ? 'failed' : warnings.length ? 'warning' : 'passed',
      warnings,
      result: {
        legal_name: c.legalName,
        cipc_status: status,
        cipc_status_raw: c.statusRaw,
        incorporation_date: c.incorporationDate,
        entity_type: c.entityTypeDescription,
      },
    };
  }

  private evaluateDirectors(r: ResolvedCheck<'company_registration'>, flags: Set<string>): CheckRecord {
    const base = { checkType: 'directors' as const, source: r.source, dataAsOf: r.dataAsOf, stale: r.stale };
    if (r.status !== 'found') return { ...base, status: r.status === 'not_found' ? 'not_found' : 'error', result: null, errorCode: r.unavailableReason };
    const directors = r.data!.directors;
    const active = directors.filter((d) => d.status === 'active');
    const warnings: string[] = [];
    if (active.length === 0) {
      flags.add('no_active_directors');
      warnings.push('no_active_directors');
    }
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    for (const d of active) {
      if (d.appointedOn && Date.parse(d.appointedOn) > thirtyDaysAgo) {
        flags.add('director_appointed_within_30_days');
        warnings.push('director_appointed_within_30_days');
      }
      if (d.idType === 'sa_id' && d.idNumber) {
        try {
          parseSaId(d.idNumber, { minAge: 16 });
        } catch {
          flags.add('director_id_number_invalid');
          warnings.push('director_id_number_invalid');
        }
      }
    }
    return {
      ...base,
      status: warnings.length ? 'warning' : 'passed',
      warnings: [...new Set(warnings)],
      result: {
        active: active.map((d) => ({
          full_name: d.fullName,
          role: d.role,
          appointed_on: d.appointedOn,
          // Data minimisation: buyers get the last 4 digits; full IDs stay encrypted at rest for COI matching.
          id_number_last4: d.idNumber ? d.idNumber.slice(-4) : null,
        })),
        resigned_count: directors.filter((d) => d.status === 'resigned').length,
      },
    };
  }

  private evaluateVat(r: ResolvedCheck<'vat_status'>, legalName: string | null, flags: Set<string>): CheckRecord {
    const base = { checkType: 'vat' as const, source: r.source, dataAsOf: r.dataAsOf, stale: r.stale };
    if (r.status === 'unavailable') return { ...base, status: 'error', result: null, errorCode: r.unavailableReason };
    if (r.status === 'not_found' || !r.data?.registered) {
      flags.add('vat_number_not_registered');
      return { ...base, status: 'failed', result: { registered: false } };
    }
    const v: VatRecord = r.data;
    const warnings: string[] = [];
    const nameOk = legalName && v.vendorName ? namesMatch(legalName, v.vendorName) || (v.tradingName ? namesMatch(legalName, v.tradingName) : false) : null;
    if (nameOk === false) {
      flags.add('vat_number_registered_to_different_name');
      warnings.push('vat_vendor_name_mismatch');
    }
    return {
      ...base,
      status: nameOk === false ? 'warning' : 'passed',
      warnings,
      result: { registered: true, vendor_name: v.vendorName, trading_name: v.tradingName, name_matches_cipc: nameOk, effective_date: v.effectiveDate },
    };
  }

  private evaluateTcs(r: ResolvedCheck<'tax_compliance_status'>, legalName: string | null, flags: Set<string>): CheckRecord {
    const base = { checkType: 'tcs' as const, source: r.source, dataAsOf: r.dataAsOf, stale: false };
    if (r.status === 'unavailable') return { ...base, status: 'error', result: null, errorCode: r.unavailableReason };
    if (r.status === 'not_found') {
      flags.add('tcs_pin_not_recognised');
      return { ...base, status: 'failed', result: { tcs_status: 'unknown', pin_status: 'invalid' } };
    }
    const t: TcsResult = r.data!;
    const warnings: string[] = [];
    let status: CheckRecord['status'] = 'passed';
    if (t.pinStatus !== 'active') {
      flags.add(`tcs_pin_${t.pinStatus}`);
      status = 'failed';
    } else if (t.status === 'non_compliant') {
      flags.add('sars_non_compliant');
      status = 'failed';
    } else if (t.status === 'unknown') {
      status = 'warning';
      warnings.push('tcs_status_unknown');
    }
    if (status === 'passed' && t.pinExpiresOn && daysUntil(t.pinExpiresOn) <= 30) {
      warnings.push('tcs_pin_expires_within_30_days');
      status = 'warning';
    }
    if (legalName && t.taxpayerName && !namesMatch(legalName, t.taxpayerName)) {
      flags.add('tcs_taxpayer_name_mismatch');
      warnings.push('tcs_taxpayer_name_mismatch');
      if (status === 'passed') status = 'warning';
    }
    return {
      ...base,
      status,
      warnings,
      // The PIN itself is never returned or stored in results.
      result: { tcs_status: t.status, pin_status: t.pinStatus, pin_expires_on: t.pinExpiresOn, checked_at: t.checkedAt },
    };
  }

  // ------------------------------------------------------------------ persistence

  private async persistVendorData(
    client: PoolClient,
    auth: AuthContext,
    input: CompanyVerificationInput,
    created: { verificationId: string; vendorId: string; tenantVendorId: string },
    company: ResolvedCheck<'company_registration'> | null,
    vat: ResolvedCheck<'vat_status'> | null,
    tcs: ResolvedCheck<'tax_compliance_status'> | null,
    requestId: string,
  ) {
    const vendorId = created.vendorId;
    if (company?.status === 'found' && company.data) {
      const c: CompanyRecord = company.data;
      const { status } = normaliseCipcStatus(c.statusRaw);
      await client.query(
        `UPDATE vendors SET legal_name = $2, cipc_status = $3, cipc_status_raw = $4, incorporation_date = coalesce($5::date, incorporation_date),
                            vat_number = coalesce($6, vat_number), passport_last_verified_at = now()
          WHERE id = $1`,
        [vendorId, c.legalName, status, c.statusRaw, c.incorporationDate, vat?.status === 'found' && vat.data?.registered ? input.vatNumber : null],
      );
      // Replace the director snapshot (public-register data, versioned via as_of).
      await client.query(`DELETE FROM vendor_directors WHERE vendor_id = $1`, [vendorId]);
      for (const d of c.directors) {
        await client.query(
          `INSERT INTO vendor_directors (vendor_id, full_name, id_number_enc, id_number_bidx, id_type, role, status,
                                         appointed_on, resigned_on, source_provider, as_of, purge_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + interval '5 years')`,
          [
            vendorId,
            d.fullName,
            d.idNumber ? await this.d.crypto.encrypt(d.idNumber, `director_id:${vendorId}`) : null,
            d.idNumber ? this.d.crypto.blindIndex('sa_id', d.idNumber) : null,
            d.idType,
            d.role,
            d.status,
            d.appointedOn,
            d.resignedOn,
            company.source,
            company.dataAsOf ?? new Date().toISOString(),
          ],
        );
      }
    }

    if (tcs?.status === 'found' && tcs.data && input.tcsPin && input.taxReferenceNumber) {
      const t = tcs.data;
      const keepPin = input.monitor && t.pinStatus === 'active';
      const purgeAfter = keepPin && t.pinExpiresOn ? `${t.pinExpiresOn}T23:59:59Z` : new Date().toISOString();
      const aad = `tcs_pin:${auth.tenantId}:${vendorId}`;
      const pin = await client.query<{ id: string }>(
        `INSERT INTO tax_compliance_pins (vendor_id, tenant_id, tax_reference_enc, tax_reference_bidx, pin_enc, pin_fingerprint,
                                          key_version, tcs_type, pin_expires_on, status, last_tcs_status, last_verified_at,
                                          verification_method, purge_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'unknown', $8, $9, $10, now(), 'bureau', $11)
         ON CONFLICT (tenant_id, pin_fingerprint) DO UPDATE
           SET status = EXCLUDED.status, last_tcs_status = EXCLUDED.last_tcs_status, last_verified_at = now(),
               pin_expires_on = EXCLUDED.pin_expires_on,
               pin_enc = CASE WHEN EXCLUDED.pin_enc IS NULL THEN tax_compliance_pins.pin_enc ELSE EXCLUDED.pin_enc END,
               purge_after = GREATEST(tax_compliance_pins.purge_after, EXCLUDED.purge_after)
         RETURNING id`,
        [
          vendorId,
          auth.tenantId,
          await this.d.crypto.encrypt(input.taxReferenceNumber, `tax_ref:${auth.tenantId}:${vendorId}`),
          this.d.crypto.blindIndex('tax_reference', input.taxReferenceNumber),
          // Without monitoring we never persist the bearer credential.
          keepPin ? await this.d.crypto.encrypt(input.tcsPin, aad) : null,
          this.d.crypto.blindIndex('tcs_pin', input.tcsPin, auth.tenantId),
          this.d.crypto.keyVersion,
          t.pinExpiresOn,
          t.pinStatus === 'active' ? 'active' : t.pinStatus,
          t.status,
          purgeAfter,
        ],
      );
      if (keepPin && t.pinExpiresOn) {
        await client.query(
          `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, next_action_at, next_action)
           VALUES ($1, $2, 'tcs_pin', $3, $4, GREATEST(now(), ($4::date - 30)::timestamptz), 'remind')
           ON CONFLICT (tenant_vendor_id, subject_type, subject_id) DO UPDATE SET expires_on = EXCLUDED.expires_on, next_action_at = EXCLUDED.next_action_at`,
          [auth.tenantId, created.tenantVendorId, pin.rows[0]!.id, t.pinExpiresOn],
        );
      }
      if (keepPin) {
        await audit(client, {
          tenantId: auth.tenantId,
          actorType: 'system',
          actorId: 'verification_engine',
          action: 'tcs_pin.stored',
          entityType: 'tax_compliance_pin',
          entityId: pin.rows[0]!.id,
          requestId,
          details: { expires_on: t.pinExpiresOn, reason: 'continuous_monitoring', pin_masked: mask(input.tcsPin, 2) },
        });
      }
    }

    if (input.monitor) {
      await client.query(
        `INSERT INTO monitoring_enrolments (tenant_id, tenant_vendor_id, period) VALUES ($1, $2, tstzrange(now(), NULL))
         ON CONFLICT DO NOTHING`,
        [auth.tenantId, created.tenantVendorId],
      );
    }
  }
}
