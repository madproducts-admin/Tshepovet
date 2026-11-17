import { luhnValid } from './luhn';

/**
 * South African ID number: YYMMDD SSSS C A Z
 *   YYMMDD  date of birth
 *   SSSS    0000-4999 female, 5000-9999 male
 *   C       0 = SA citizen, 1 = permanent resident, 2 = refugee
 *   A       historically encoded race (pre-1986). It is IGNORED: inferring race
 *           from it would be processing special personal information (POPIA
 *           s26) without a lawful basis.
 *   Z       Luhn check digit
 *
 * The century is ambiguous ("25" = 1925 or 2025). Directors, sole proprietors
 * and professional drivers are adults, so callers pass `minAge` to resolve it.
 */
export interface ParsedSaId {
  normalised: string;
  dateOfBirth: string; // ISO date
  centuryAmbiguous: boolean;
  sex: 'female' | 'male';
  citizenship: 'citizen' | 'permanent_resident' | 'refugee';
  ageYears: number;
}

export class SaIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaIdError';
  }
}

function age(dob: Date, now: Date): number {
  let a = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) a--;
  return a;
}

export function parseSaId(input: string, opts: { minAge?: number; now?: Date } = {}): ParsedSaId {
  const now = opts.now ?? new Date();
  const id = input.replace(/\s+/g, '');
  if (!/^\d{13}$/.test(id)) throw new SaIdError('SA ID number must be 13 digits');
  if (!luhnValid(id)) throw new SaIdError('SA ID number check digit is invalid');

  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  const c = id[10];

  const candidates = [1900 + yy, 2000 + yy]
    .map((y) => new Date(Date.UTC(y, mm - 1, dd)))
    .filter((d) => d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd && d <= now);
  if (candidates.length === 0) throw new SaIdError('SA ID number encodes an invalid date of birth');

  const minAge = opts.minAge ?? 0;
  const plausible = candidates.filter((d) => age(d, now) >= minAge && age(d, now) <= 120);
  if (plausible.length === 0) throw new SaIdError('SA ID number date of birth is implausible for this role');
  // Prefer the most recent plausible century.
  const dob = plausible[plausible.length - 1]!;

  const citizenship = c === '0' ? 'citizen' : c === '1' ? 'permanent_resident' : c === '2' ? 'refugee' : null;
  if (!citizenship) throw new SaIdError('SA ID number citizenship digit is invalid');

  return {
    normalised: id,
    dateOfBirth: dob.toISOString().slice(0, 10),
    centuryAmbiguous: plausible.length > 1,
    sex: Number(id.slice(6, 10)) < 5000 ? 'female' : 'male',
    citizenship,
    ageYears: age(dob, now),
  };
}
