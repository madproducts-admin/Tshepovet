/**
 * B-BBEE evidence rules (Amended Codes of Good Practice, 2013; B-BBEE Act s9).
 *
 *   EME  turnover <= EME threshold (generic: R10m)  -> sworn affidavit OK
 *        Level 1 if 100% black-owned, Level 2 if >= 51%, else Level 4
 *   QSE  turnover <= QSE threshold (generic: R50m)
 *        affidavit only if >= 51% black-owned (Level 1 at 100%, Level 2 at >= 51%);
 *        otherwise a SANAS-accredited verification certificate is required
 *   Generic (> QSE threshold) -> SANAS certificate only
 *
 * Affidavits must be on the dtic template, deposed by a director/member and
 * commissioned by a Commissioner of Oaths. Affidavits and certificates are
 * valid for 12 months. Sector codes have different thresholds - they are
 * passed in from ref_bbbee_thresholds, never hard-coded.
 *
 * "Black people" = Africans, Coloureds and Indians who are SA citizens by
 * birth/descent, or naturalised before 27 April 1994 (or who would have been
 * entitled to be). Ownership percentages are special personal information
 * (POPIA s26) processed under the s29(b) redress exemption.
 */
export interface Thresholds {
  sectorCode: string;
  emeMaxTurnoverCents: number;
  qseMaxTurnoverCents: number;
  verified: boolean;
}

export type EnterpriseSize = 'EME' | 'QSE' | 'GENERIC';
export type EvidenceType = 'eme_affidavit' | 'qse_affidavit' | 'sanas_certificate' | 'cipc_eme_certificate';

export const RECOGNITION: Record<number, number> = { 1: 135, 2: 125, 3: 110, 4: 100, 5: 80, 6: 60, 7: 50, 8: 10, 0: 0 };

export function classifySize(turnoverCents: number, t: Thresholds): EnterpriseSize {
  if (turnoverCents <= t.emeMaxTurnoverCents) return 'EME';
  if (turnoverCents <= t.qseMaxTurnoverCents) return 'QSE';
  return 'GENERIC';
}

export interface BbbeeEvidence {
  evidenceType: EvidenceType;
  annualTurnoverCents: number | null;
  blackOwnershipPct: number | null;
  blackFemaleOwnershipPct: number | null;
  statedLevel: number | null;               // level printed on certificate/affidavit
  issuedOn: string | null;                  // ISO date (affidavit: commissioning date)
  financialYearEnd: string | null;
  commissionerOfOathsPresent: boolean;
  sanasAccreditationNumber: string | null;  // certificates
  verificationAgency: string | null;
}

export interface BbbeeAssessment {
  size: EnterpriseSize | null;
  level: number | null;
  recognitionPct: number | null;
  validUntil: string | null;
  isEmpoweringSupplier: boolean | null;
  flags: string[];
  decision: 'accept' | 'reject' | 'manual_review';
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function assessBbbee(e: BbbeeEvidence, t: Thresholds | null, now: Date = new Date()): BbbeeAssessment {
  const flags: string[] = [];
  const today = now.toISOString().slice(0, 10);

  if (!e.issuedOn) flags.push('missing_issue_date');
  const validUntil = e.issuedOn ? addMonths(e.issuedOn, 12) : null;
  if (validUntil && validUntil < today) flags.push('expired');
  if (e.issuedOn && e.issuedOn > today) flags.push('issue_date_in_future');

  const black = e.blackOwnershipPct;
  const blackFemale = e.blackFemaleOwnershipPct;
  if (black !== null && (black < 0 || black > 100)) flags.push('ownership_out_of_range');
  if (black !== null && blackFemale !== null && blackFemale > black) flags.push('black_female_exceeds_black');

  if (!t || !t.verified) flags.push('sector_thresholds_unverified');
  const size = e.annualTurnoverCents !== null && t ? classifySize(e.annualTurnoverCents, t) : null;

  let level: number | null = null;
  const isAffidavit = e.evidenceType === 'eme_affidavit' || e.evidenceType === 'qse_affidavit';

  if (isAffidavit) {
    if (!e.commissionerOfOathsPresent) flags.push('affidavit_not_commissioned');
    if (e.annualTurnoverCents === null) flags.push('missing_turnover');
    if (black === null) flags.push('missing_black_ownership');
    if (e.financialYearEnd && e.issuedOn) {
      // Turnover must relate to the most recent financial year.
      const fyeAgeDays = (Date.parse(e.issuedOn) - Date.parse(e.financialYearEnd)) / 86_400_000;
      if (fyeAgeDays > 548) flags.push('stale_financial_year');
      if (fyeAgeDays < 0) flags.push('financial_year_after_affidavit');
    }
    if (e.evidenceType === 'eme_affidavit' && size && size !== 'EME') flags.push('turnover_exceeds_eme_threshold');
    if (e.evidenceType === 'qse_affidavit') {
      if (size === 'GENERIC') flags.push('turnover_exceeds_qse_threshold');
      if (size === 'EME') flags.push('qse_affidavit_for_eme_turnover');
      if (black !== null && black < 51) flags.push('qse_affidavit_requires_51pct_black_ownership');
    }
    if (black !== null) {
      if (e.evidenceType === 'eme_affidavit') level = black >= 100 ? 1 : black >= 51 ? 2 : 4;
      else if (black >= 51) level = black >= 100 ? 1 : 2;
    }
    if (e.statedLevel !== null && level !== null && e.statedLevel !== level) flags.push('stated_level_mismatch');
  } else if (e.evidenceType === 'sanas_certificate') {
    if (!e.sanasAccreditationNumber) flags.push('missing_sanas_accreditation_number');
    else if (!/^BVA\s?\d{3,4}$/i.test(e.sanasAccreditationNumber.trim())) flags.push('unrecognised_accreditation_format');
    if (!e.verificationAgency) flags.push('missing_verification_agency');
    level = e.statedLevel;
    if (level === null) flags.push('missing_level');
  } else {
    // CIPC-issued EME certificate
    level = e.statedLevel;
    if (level === null) flags.push('missing_level');
  }

  const hardFail = flags.some((f) =>
    [
      'expired',
      'black_female_exceeds_black',
      'ownership_out_of_range',
      'turnover_exceeds_eme_threshold',
      'turnover_exceeds_qse_threshold',
      'qse_affidavit_requires_51pct_black_ownership',
      'affidavit_not_commissioned',
      'issue_date_in_future',
    ].includes(f),
  );
  const soft = flags.length > 0;

  return {
    size,
    level: hardFail ? null : level,
    recognitionPct: hardFail || level === null ? null : RECOGNITION[level] ?? null,
    validUntil,
    // EMEs meet the Empowering Supplier test automatically; others must state it.
    isEmpoweringSupplier: size === 'EME' ? true : null,
    flags,
    decision: hardFail ? 'reject' : soft ? 'manual_review' : 'accept',
  };
}
