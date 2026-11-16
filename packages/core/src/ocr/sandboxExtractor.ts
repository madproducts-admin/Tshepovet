import type { ExpectedKind } from './extractor';
import type { Extraction } from './schemas';

/**
 * The sandbox stand-in for document reading (docs/PLAN.md §6). The sandbox must never hold
 * real personal data, so suppliers there choose a sample document instead of uploading one;
 * each sample is a fixed reading that goes through the same post-validation (postValidate)
 * a real extraction would, and exercises one path: accepted, retake, wrong person, expired.
 *
 * Dates are relative to "now", so the samples never go stale. The identity samples use the
 * mock bureau's directors (packages/core/src/providers/adapters/mockProvider.ts).
 */
export const SANDBOX_SAMPLES = {
  id_director: { expected: 'identity', label: 'Smart ID card of a director', outcome: 'Accepted: the ID belongs to an active director.' },
  id_other_person: { expected: 'identity', label: 'Smart ID card of someone who left the company', outcome: 'Accepted, flagged: not an active director.' },
  id_blurry: { expected: 'identity', label: 'A blurry photo of an ID card', outcome: 'Asks for a clearer photo.' },
  bbbee_eme: { expected: 'bbbee', label: 'EME affidavit, 100% black-owned', outcome: 'Accepted: Level 1.' },
  bbbee_expired: { expected: 'bbbee', label: 'EME affidavit signed 14 months ago', outcome: 'Refused: older than 12 months.' },
  bbbee_unsigned: { expected: 'bbbee', label: 'EME affidavit without a commissioner of oaths', outcome: 'Refused: not commissioned.' },
} as const satisfies Record<string, { expected: ExpectedKind; label: string; outcome: string }>;

export type SandboxSample = keyof typeof SANDBOX_SAMPLES;

const day = (now: Date, offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

const base = (document_type: Extraction['document_type']): Extraction => ({
  document_type,
  legible: true,
  quality_issues: [],
  identity: null,
  driver_licence: null,
  bbbee: null,
  low_confidence_fields: [],
  embedded_instructions_detected: false,
});

export function sandboxExtraction(sample: SandboxSample, now: Date = new Date()): Extraction {
  switch (sample) {
    case 'id_director':
      return {
        ...base('sa_smart_id_card'),
        identity: { id_number: '8001015009087', surname: 'MOKOENA', forenames: 'THANDI', date_of_birth: '1980-01-01', sex: 'M', nationality: 'RSA', country_of_birth: 'RSA', card_issue_date: '2019-06-12' },
      };
    case 'id_other_person':
      return {
        ...base('sa_smart_id_card'),
        identity: { id_number: '7506205009086', surname: 'VAN DER MERWE', forenames: 'PIETER', date_of_birth: '1975-06-20', sex: 'M', nationality: 'RSA', country_of_birth: 'RSA', card_issue_date: '2017-02-03' },
      };
    case 'id_blurry':
      return { ...base('sa_smart_id_card'), legible: false, quality_issues: ['blurry'], low_confidence_fields: ['identity.id_number'] };
    case 'bbbee_eme':
    case 'bbbee_expired':
    case 'bbbee_unsigned': {
      const signed = sample === 'bbbee_expired' ? day(now, -425) : day(now, -30);
      return {
        ...base('bbbee_eme_affidavit'),
        bbbee: {
          entity_name: 'ACME TRADING (PTY) LTD',
          registration_number: '2019/123456/07',
          sector_code: 'Generic',
          financial_year_end: sample === 'bbbee_expired' ? day(now, -500) : day(now, -120),
          annual_turnover_rands: 4_500_000,
          black_ownership_pct: 100,
          black_female_ownership_pct: 60,
          bbbee_level: 1,
          issue_date: signed,
          expiry_date: null,
          deponent_name: 'THANDI MOKOENA',
          commissioner_of_oaths_present: sample !== 'bbbee_unsigned',
          commissioner_of_oaths_name: sample === 'bbbee_unsigned' ? null : 'L. NAIDOO',
          commissioner_of_oaths_date: sample === 'bbbee_unsigned' ? null : signed,
          verification_agency: null,
          sanas_accreditation_number: null,
          certificate_number: null,
        },
      };
    }
  }
}
