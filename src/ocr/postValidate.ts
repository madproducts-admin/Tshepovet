import { assessBbbee, BbbeeAssessment, Thresholds } from '../domain/sa/bbbee';
import { LicenceCode, normaliseLicenceCode } from '../domain/sa/driverLicence';
import { parseSaId, ParsedSaId } from '../domain/sa/saId';
import type { ExpectedKind } from './extractor';
import type { Extraction } from './schemas';

/**
 * Deterministic checks on LLM output. The outcome drives the conversation:
 *   ok             accept, continue
 *   retake         likely capture problem -> ask for a better photo
 *   wrong_document the vendor sent something else
 *   needs_review   plausible fraud / inconsistency -> human queue (never auto-reject a person)
 */
export interface PostValidation {
  outcome: 'ok' | 'retake' | 'wrong_document' | 'needs_review';
  detail: string;
  flags: string[];
  identity?: { idNumber: string; parsed: ParsedSaId; surname: string | null; forenames: string | null };
  licence?: { licenceNumber: string | null; idNumber: string | null; codes: LicenceCode[]; validTo: string | null; prdpCategories: string[]; prdpValidTo: string | null };
  bbbee?: BbbeeAssessment & { evidenceType: string };
}

const CAPTURE_ISSUES = new Set(['blurry', 'glare', 'cropped', 'low_resolution', 'too_dark']);
const FRAUD_ISSUES = new Set(['photo_of_screen', 'photocopy', 'possible_tampering']);

const ACCEPTED_TYPES: Record<ExpectedKind, string[]> = {
  identity: ['sa_smart_id_card', 'sa_green_id_book', 'passport'],
  driver_licence: ['driver_licence_card', 'temporary_driver_licence'],
  bbbee: ['bbbee_eme_affidavit', 'bbbee_qse_affidavit', 'bbbee_certificate', 'cipc_eme_certificate'],
};

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export function postValidate(x: Extraction, expected: ExpectedKind, ctx: { bbbeeThresholds?: Thresholds | null; now?: Date } = {}): PostValidation {
  const flags: string[] = [];
  if (x.embedded_instructions_detected) flags.push('embedded_instructions_detected');
  for (const q of x.quality_issues) if (FRAUD_ISSUES.has(q)) flags.push(`quality_${q}`);

  if (x.document_type === 'not_a_document') return { outcome: 'wrong_document', detail: 'not a document', flags };
  if (!ACCEPTED_TYPES[expected].includes(x.document_type)) return { outcome: 'wrong_document', detail: x.document_type.replace(/_/g, ' '), flags };

  const captureProblems = x.quality_issues.filter((q) => CAPTURE_ISSUES.has(q));
  if (!x.legible || captureProblems.length) return { outcome: 'retake', detail: captureProblems.join(', ') || 'not legible', flags };

  const reviewIfFlagged = (p: PostValidation): PostValidation =>
    flags.length && p.outcome === 'ok' ? { ...p, outcome: 'needs_review', detail: flags.join(', ') } : p;

  if (expected === 'identity') {
    if (x.document_type === 'passport') {
      flags.push('foreign_national_passport');
      return { outcome: 'needs_review', detail: 'passport requires manual verification', flags };
    }
    const idRaw = digits(x.identity?.id_number);
    let parsed: ParsedSaId;
    try {
      parsed = parseSaId(idRaw, { minAge: 16, now: ctx.now });
    } catch {
      // A failed check digit on a legible image is usually a misread digit.
      return x.low_confidence_fields.some((f) => f.includes('id_number'))
        ? { outcome: 'retake', detail: 'ID number unclear', flags }
        : { outcome: 'needs_review', detail: 'ID number fails validation', flags: [...flags, 'id_number_invalid'] };
    }
    if (x.identity?.date_of_birth && x.identity.date_of_birth !== parsed.dateOfBirth) flags.push('dob_does_not_match_id_number');
    if (x.identity?.sex && x.identity.sex !== (parsed.sex === 'female' ? 'F' : 'M')) flags.push('sex_does_not_match_id_number');
    return reviewIfFlagged({
      outcome: 'ok',
      detail: '',
      flags,
      identity: { idNumber: parsed.normalised, parsed, surname: x.identity?.surname ?? null, forenames: x.identity?.forenames ?? null },
    });
  }

  if (expected === 'driver_licence') {
    const l = x.driver_licence;
    const codes = (l?.codes ?? []).map(normaliseLicenceCode).filter((c): c is LicenceCode => c !== null);
    if (!codes.length) flags.push('no_recognisable_licence_codes');
    const id = digits(l?.id_number);
    if (id) {
      try {
        parseSaId(id, { minAge: 16, now: ctx.now });
      } catch {
        flags.push('licence_id_number_invalid');
      }
    }
    if (x.document_type === 'temporary_driver_licence') flags.push('temporary_licence');
    return reviewIfFlagged({
      outcome: 'ok',
      detail: '',
      flags,
      licence: {
        licenceNumber: l?.licence_number?.replace(/\s+/g, '').toUpperCase() ?? null,
        idNumber: id || null,
        codes,
        validTo: l?.valid_to ?? null,
        prdpCategories: (l?.prdp_categories ?? []).map((c) => c.trim().toUpperCase()).filter((c) => ['G', 'P', 'D'].includes(c)),
        prdpValidTo: l?.prdp_valid_to ?? null,
      },
    });
  }

  // B-BBEE
  const b = x.bbbee;
  const evidenceType =
    x.document_type === 'bbbee_eme_affidavit'
      ? 'eme_affidavit'
      : x.document_type === 'bbbee_qse_affidavit'
        ? 'qse_affidavit'
        : x.document_type === 'cipc_eme_certificate'
          ? 'cipc_eme_certificate'
          : 'sanas_certificate';
  const assessment = assessBbbee(
    {
      evidenceType,
      annualTurnoverCents: b?.annual_turnover_rands != null ? Math.round(b.annual_turnover_rands * 100) : null,
      blackOwnershipPct: b?.black_ownership_pct ?? null,
      blackFemaleOwnershipPct: b?.black_female_ownership_pct ?? null,
      statedLevel: b?.bbbee_level ?? null,
      issuedOn: (evidenceType.endsWith('affidavit') ? b?.commissioner_of_oaths_date ?? b?.issue_date : b?.issue_date) ?? null,
      financialYearEnd: b?.financial_year_end ?? null,
      commissionerOfOathsPresent: Boolean(b?.commissioner_of_oaths_present),
      sanasAccreditationNumber: b?.sanas_accreditation_number ?? null,
      verificationAgency: b?.verification_agency ?? null,
    },
    ctx.bbbeeThresholds ?? null,
    ctx.now,
  );
  const allFlags = [...flags, ...assessment.flags];
  const outcome = assessment.decision === 'accept' && !flags.length ? 'ok' : 'needs_review';
  return { outcome, detail: allFlags.join(', '), flags: allFlags, bbbee: { ...assessment, evidenceType } };
}
