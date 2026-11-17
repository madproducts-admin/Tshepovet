/**
 * CIPC enterprise (registration) numbers: YYYY/NNNNNN/TT
 *   YYYY   - year the application was CAPTURED (not necessarily incorporation;
 *            see CIPC Notice 1 of 2026 - a 2025 number can have a 2026
 *            incorporation date). Never derive company age from it.
 *   NNNNNN - sequence
 *   TT     - entity type suffix (07 = (Pty) Ltd, 23 = CC, ...)
 *
 * Real-world inputs we normalise:
 *   "2019/123456/07", "2019-123456-07", "2019 123456 07", "201912345607",
 *   "CK2001/012345/23" (CC prefix), "K2019/123456/07" (BizPortal style),
 *   "1998/12345/23" (dropped leading zero in the sequence - padded + warned).
 */
export type EntityKind =
  | 'public_company'
  | 'private_company'
  | 'non_profit_company'
  | 'personal_liability_company'
  | 'state_owned_company'
  | 'external_company'
  | 'close_corporation'
  | 'cooperative'
  | 'statutory_body'
  | 'other';

export const CIPC_TYPE_CODES: Record<string, { name: string; kind: EntityKind; hasDirectors: boolean }> = {
  '06': { name: 'Public Company', kind: 'public_company', hasDirectors: true },
  '07': { name: 'Private Company', kind: 'private_company', hasDirectors: true },
  '08': { name: 'Non-Profit Company', kind: 'non_profit_company', hasDirectors: true },
  '09': { name: 'Company Limited by Guarantee', kind: 'other', hasDirectors: true },
  '10': { name: 'External Company', kind: 'external_company', hasDirectors: true },
  '21': { name: 'Personal Liability Company', kind: 'personal_liability_company', hasDirectors: true },
  '22': { name: 'Unlimited Company', kind: 'other', hasDirectors: true },
  '23': { name: 'Close Corporation', kind: 'close_corporation', hasDirectors: false },
  '24': { name: 'Primary Co-operative', kind: 'cooperative', hasDirectors: true },
  '25': { name: 'Secondary Co-operative', kind: 'cooperative', hasDirectors: true },
  '26': { name: 'Tertiary Co-operative', kind: 'cooperative', hasDirectors: true },
  '30': { name: 'State-Owned Company', kind: 'state_owned_company', hasDirectors: true },
  '31': { name: 'Statutory Body', kind: 'statutory_body', hasDirectors: true },
};

export interface ParsedEnterpriseNumber {
  normalised: string;
  year: number;
  sequence: string;
  typeCode: string;
  entityKind: EntityKind;
  typeName: string | null;
  warnings: string[];
}

export class EnterpriseNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnterpriseNumberError';
  }
}

export function parseEnterpriseNumber(input: string, now: Date = new Date()): ParsedEnterpriseNumber {
  const warnings: string[] = [];
  let s = input.trim().toUpperCase();
  if (s.startsWith('CK')) {
    s = s.slice(2);
    warnings.push('stripped_ck_prefix');
  } else if (s.startsWith('K')) {
    s = s.slice(1);
    warnings.push('stripped_k_prefix');
  }
  s = s.replace(/\s+/g, '');

  let year: string, seq: string, type: string;
  const delimited = /^(\d{4})[/\-.](\d{1,6})[/\-.](\d{2})$/.exec(s);
  const compact = /^(\d{4})(\d{6})(\d{2})$/.exec(s);
  if (delimited) {
    [, year, seq, type] = delimited as unknown as [string, string, string, string];
  } else if (compact) {
    [, year, seq, type] = compact as unknown as [string, string, string, string];
    warnings.push('added_delimiters');
  } else {
    throw new EnterpriseNumberError('Enterprise number must look like YYYY/NNNNNN/TT');
  }

  if (seq.length < 6) {
    seq = seq.padStart(6, '0');
    warnings.push('zero_padded_sequence');
  }

  const y = Number(year);
  // Companies registered under earlier Acts carry pre-1950 years; the year can
  // never be in the future because it is the capture year.
  if (y < 1900 || y > now.getUTCFullYear()) {
    throw new EnterpriseNumberError(`Implausible registration year ${y}`);
  }

  const meta = CIPC_TYPE_CODES[type];
  if (!meta) warnings.push('unknown_entity_type_code');
  if (type === '23' && y > 2011) {
    // No new CCs after the Companies Act 71 of 2008 took effect (1 May 2011).
    warnings.push('close_corporation_after_2011');
  }

  return {
    normalised: `${year}/${seq}/${type}`,
    year: y,
    sequence: seq,
    typeCode: type,
    entityKind: meta?.kind ?? 'other',
    typeName: meta?.name ?? null,
    warnings,
  };
}

/** A number captured this year or last may not yet be in bureau-cached CIPC copies. */
export function isRecentlyRegistered(parsed: ParsedEnterpriseNumber, now: Date = new Date()): boolean {
  return parsed.year >= now.getUTCFullYear() - 1;
}

// ---------------------------------------------------------------------------
// Company status normalisation
// ---------------------------------------------------------------------------

export type CipcStatus =
  | 'in_business'
  | 'deregistration_process'
  | 'deregistered'
  | 'in_liquidation'
  | 'voluntary_liquidation'
  | 'business_rescue'
  | 'reinstatement_process'
  | 'ar_restoration'
  | 'converted'
  | 'dissolved'
  | 'unknown';

export type StatusRisk = 'low' | 'review' | 'high' | 'critical';

const STATUS_RULES: Array<[RegExp, CipcStatus, StatusRisk]> = [
  [/^in business$|^active$/i, 'in_business', 'low'],
  [/re-?instate/i, 'reinstatement_process', 'high'],
  [/restoration/i, 'ar_restoration', 'high'],
  [/deregistration process/i, 'deregistration_process', 'high'],
  [/final deregist|deregistered/i, 'deregistered', 'critical'],
  [/voluntary liquidation/i, 'voluntary_liquidation', 'critical'],
  [/liquidat/i, 'in_liquidation', 'critical'],
  [/business rescue/i, 'business_rescue', 'high'],
  [/conver/i, 'converted', 'review'],
  [/dissolv/i, 'dissolved', 'critical'],
];

/**
 * Map the free-text statuses bureaus return (they relay CIPC strings with
 * varying casing/prefixes such as "AR Final Deregistration") to our enum.
 */
export function normaliseCipcStatus(raw: string | null | undefined): { status: CipcStatus; risk: StatusRisk } {
  if (!raw) return { status: 'unknown', risk: 'review' };
  const s = raw.trim();
  for (const [re, status, risk] of STATUS_RULES) {
    if (re.test(s)) return { status, risk };
  }
  return { status: 'unknown', risk: 'review' };
}

/**
 * Annual returns are due within 30 business days after each anniversary of
 * incorporation. Persistent non-filing moves the company into deregistration.
 * Returns the next anniversary; the 30-business-day window is computed by the
 * monitoring worker with the public-holiday calendar.
 */
export function nextAnnualReturnAnniversary(incorporationDate: Date, now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), incorporationDate.getUTCMonth(), incorporationDate.getUTCDate()));
  if (d < now) d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}
