import { describe, expect, it } from 'vitest';
import { assessBbbee, Thresholds } from '../src/domain/sa/bbbee';
import { EnterpriseNumberError, normaliseCipcStatus, parseEnterpriseNumber } from '../src/domain/sa/cipc';
import { licenceCovers, normaliseLicenceCode, prdpCovers, validityState } from '../src/domain/sa/driverLicence';
import { parseSaId, SaIdError } from '../src/domain/sa/saId';
import { normaliseTaxReference, normaliseTcsPin, normaliseVatNumber } from '../src/domain/sa/tax';

const NOW = new Date('2026-11-14T10:00:00Z');

describe('CIPC enterprise numbers', () => {
  it.each([
    ['2019/123456/07', '2019/123456/07', []],
    ['2019-123456-07', '2019/123456/07', []],
    ['201912345607', '2019/123456/07', ['added_delimiters']],
    ['CK1998/012345/23', '1998/012345/23', ['stripped_ck_prefix']],
    ['K2019/123456/07', '2019/123456/07', ['stripped_k_prefix']],
    ['1998/12345/23', '1998/012345/23', ['zero_padded_sequence']],
  ])('normalises %s', (input, expected, warnings) => {
    const p = parseEnterpriseNumber(input, NOW);
    expect(p.normalised).toBe(expected);
    for (const w of warnings) expect(p.warnings).toContain(w);
  });

  it('maps type codes to entity kinds', () => {
    expect(parseEnterpriseNumber('2019/123456/07', NOW).entityKind).toBe('private_company');
    expect(parseEnterpriseNumber('2001/123456/23', NOW).entityKind).toBe('close_corporation');
    expect(parseEnterpriseNumber('2015/123456/30', NOW).entityKind).toBe('state_owned_company');
    expect(parseEnterpriseNumber('2015/123456/99', NOW).warnings).toContain('unknown_entity_type_code');
  });

  it('flags close corporations numbered after 2011', () => {
    expect(parseEnterpriseNumber('2015/123456/23', NOW).warnings).toContain('close_corporation_after_2011');
  });

  it('rejects future years and garbage', () => {
    expect(() => parseEnterpriseNumber('2027/123456/07', NOW)).toThrow(EnterpriseNumberError);
    expect(() => parseEnterpriseNumber('hello', NOW)).toThrow(EnterpriseNumberError);
  });

  it('normalises CIPC status strings', () => {
    expect(normaliseCipcStatus('In Business')).toEqual({ status: 'in_business', risk: 'low' });
    expect(normaliseCipcStatus('AR Deregistration Process').status).toBe('deregistration_process');
    expect(normaliseCipcStatus('AR Final Deregistration')).toEqual({ status: 'deregistered', risk: 'critical' });
    expect(normaliseCipcStatus('Voluntary Liquidation').status).toBe('voluntary_liquidation');
    expect(normaliseCipcStatus('Business Rescue').risk).toBe('high');
    expect(normaliseCipcStatus('something new').status).toBe('unknown');
  });
});

describe('SA ID numbers', () => {
  it('parses a valid ID', () => {
    const id = parseSaId('8001015009087', { now: NOW });
    expect(id.dateOfBirth).toBe('1980-01-01');
    expect(id.sex).toBe('male');
    expect(id.citizenship).toBe('citizen');
    expect(id.ageYears).toBe(46);
  });

  it('rejects a bad check digit', () => {
    expect(() => parseSaId('8001015009088', { now: NOW })).toThrow(SaIdError);
  });

  it('resolves century using a minimum age', () => {
    // 25-01-01: 2025 (age 1) vs 1925 (age 101) -> adult role picks 1925
    const digits = '250101500908';
    let id = '';
    for (let c = 0; c < 10; c++) {
      try {
        parseSaId(digits + c, { now: NOW });
        id = digits + c;
        break;
      } catch {
        /* next */
      }
    }
    expect(parseSaId(id, { now: NOW, minAge: 16 }).dateOfBirth).toBe('1925-01-01');
    expect(parseSaId(id, { now: NOW }).dateOfBirth).toBe('2025-01-01');
  });
});

describe('SARS identifiers', () => {
  it('validates VAT and tax reference formats', () => {
    expect(normaliseVatNumber('4123 456 789')).toBe('4123456789');
    expect(normaliseVatNumber('1123456789')).toBeNull();
    expect(normaliseTaxReference('9123456789')).toBe('9123456789');
    expect(normaliseTaxReference('4123456789')).toBeNull();
  });

  it('flags a pasted tax number as a probable PIN mistake', () => {
    expect(normaliseTcsPin('9123456789').looksLikeTaxNumber).toBe(true);
    expect(normaliseTcsPin(' ab12-cd34ef ')).toEqual({ pin: 'AB12CD34EF', looksLikeTaxNumber: false });
  });
});

describe('Driving licences', () => {
  it('applies code hierarchy', () => {
    expect(licenceCovers(['EC'], 'C1')).toBe(true);
    expect(licenceCovers(['EC1'], 'C')).toBe(false);
    expect(licenceCovers(['C1'], 'B')).toBe(true);
    expect(normaliseLicenceCode('code 10')).toBe(null);
    expect(normaliseLicenceCode('10')).toBe('C1');
  });

  it('requires exact PrDP categories unless configured otherwise', () => {
    expect(prdpCovers(['D'], 'G')).toBe(false);
    expect(prdpCovers(['D'], 'G', { D: ['G', 'P'] })).toBe(true);
  });

  it('honours gazetted grace periods', () => {
    const graces = [{ expiredFrom: '2026-01-01', expiredTo: '2026-10-31', validUntil: '2027-03-31', gazetteReference: 'GG test' }];
    expect(validityState('2026-06-30', { now: NOW, graces }).state).toBe('grace_period');
    expect(validityState('2026-11-01', { now: NOW, graces }).state).toBe('expired');
    expect(validityState('2026-11-30', { now: NOW }).state).toBe('expiring_soon');
  });
});

describe('B-BBEE evidence', () => {
  const generic: Thresholds = { sectorCode: 'generic', emeMaxTurnoverCents: 10_000_000_00, qseMaxTurnoverCents: 50_000_000_00, verified: true };
  const base = {
    evidenceType: 'eme_affidavit' as const,
    annualTurnoverCents: 4_500_000_00,
    blackOwnershipPct: 100,
    blackFemaleOwnershipPct: 60,
    statedLevel: 1,
    issuedOn: '2026-05-01',
    financialYearEnd: '2026-02-28',
    commissionerOfOathsPresent: true,
    sanasAccreditationNumber: null,
    verificationAgency: null,
  };

  it('EME 100% black-owned affidavit -> Level 1, 135%', () => {
    const a = assessBbbee(base, generic, NOW);
    expect(a).toMatchObject({ size: 'EME', level: 1, recognitionPct: 135, decision: 'accept', validUntil: '2027-05-01', isEmpoweringSupplier: true });
  });

  it('EME with 30% black ownership -> Level 4', () => {
    expect(assessBbbee({ ...base, blackOwnershipPct: 30, blackFemaleOwnershipPct: 10, statedLevel: 4 }, generic, NOW).level).toBe(4);
  });

  it('QSE affidavit needs >= 51% black ownership', () => {
    const a = assessBbbee({ ...base, evidenceType: 'qse_affidavit', annualTurnoverCents: 20_000_000_00, blackOwnershipPct: 40, blackFemaleOwnershipPct: 10, statedLevel: null }, generic, NOW);
    expect(a.decision).toBe('reject');
    expect(a.flags).toContain('qse_affidavit_requires_51pct_black_ownership');
  });

  it('EME affidavit with turnover above threshold is rejected', () => {
    const a = assessBbbee({ ...base, annualTurnoverCents: 12_000_000_00 }, generic, NOW);
    expect(a.flags).toContain('turnover_exceeds_eme_threshold');
    expect(a.decision).toBe('reject');
  });

  it('rejects expired, uncommissioned or inconsistent affidavits', () => {
    expect(assessBbbee({ ...base, issuedOn: '2025-10-01' }, generic, NOW).flags).toContain('expired');
    expect(assessBbbee({ ...base, commissionerOfOathsPresent: false }, generic, NOW).decision).toBe('reject');
    expect(assessBbbee({ ...base, blackFemaleOwnershipPct: 100, blackOwnershipPct: 60 }, generic, NOW).flags).toContain('black_female_exceeds_black');
  });

  it('routes unverified sector thresholds to manual review', () => {
    expect(assessBbbee(base, { ...generic, sectorCode: 'tourism', verified: false }, NOW).decision).toBe('manual_review');
  });

  it('checks SANAS accreditation on certificates', () => {
    const cert = { ...base, evidenceType: 'sanas_certificate' as const, statedLevel: 2, verificationAgency: 'Acme Verifications', sanasAccreditationNumber: 'BVA123' };
    expect(assessBbbee(cert, generic, NOW).decision).toBe('accept');
    expect(assessBbbee({ ...cert, sanasAccreditationNumber: null }, generic, NOW).flags).toContain('missing_sanas_accreditation_number');
  });
});
