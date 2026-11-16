/**
 * South African driving licences (National Road Traffic Act 93 of 1996).
 *
 * Codes and what a code also authorises (a higher code covers lower ones):
 *   A1 (motorcycle <= 125cc)          A  (motorcycle > 125cc)  -> covers A1
 *   B  (light motor vehicle <= 3500kg)
 *   EB (B + trailer > 750kg)          -> covers B
 *   C1 (3500-16000kg)                 -> covers B
 *   C  (> 16000kg)                    -> covers C1, B
 *   EC1 (C1 + heavy trailer)          -> covers C1, EB, B
 *   EC (C + heavy trailer / artic)    -> covers EC1, C, C1, EB, B
 *
 * Card licences are valid for 5 years. During card-production backlogs the
 * Department of Transport has gazetted validity extensions; those live in
 * ref_regulatory_grace_periods, never in code.
 *
 * PrDP (Professional Driving Permit) categories: G (goods), P (passengers),
 * D (dangerous goods). Typically valid 24 months. Whether a higher category
 * implies a lower one is configurable: the conservative default requires the
 * exact category the buyer asked for. Category D requires the driver to be at
 * least 25.
 */
export const LICENCE_CODES = ['A1', 'A', 'B', 'EB', 'C1', 'C', 'EC1', 'EC'] as const;
export type LicenceCode = (typeof LICENCE_CODES)[number];

const COVERS: Record<LicenceCode, LicenceCode[]> = {
  A1: ['A1'],
  A: ['A', 'A1'],
  B: ['B'],
  EB: ['EB', 'B'],
  C1: ['C1', 'B'],
  C: ['C', 'C1', 'B'],
  EC1: ['EC1', 'C1', 'EB', 'B'],
  EC: ['EC', 'EC1', 'C', 'C1', 'EB', 'B'],
};

export function normaliseLicenceCode(raw: string): LicenceCode | null {
  const c = raw.trim().toUpperCase().replace(/\s+/g, '');
  // Colloquial legacy codes still used by drivers and on old documents
  // ("Code 8", "Code 10", "Code 14"). Anything else -> manual review.
  const legacy: Record<string, LicenceCode> = { '08': 'B', '8': 'B', '10': 'C1', '14': 'EC' };
  if ((LICENCE_CODES as readonly string[]).includes(c)) return c as LicenceCode;
  return legacy[c] ?? null;
}

export function licenceCovers(held: LicenceCode[], required: LicenceCode): boolean {
  return held.some((h) => COVERS[h].includes(required));
}

export const PRDP_CATEGORIES = ['G', 'P', 'D'] as const;
export type PrdpCategory = (typeof PRDP_CATEGORIES)[number];

export function prdpCovers(
  held: PrdpCategory[],
  required: PrdpCategory,
  implies: Partial<Record<PrdpCategory, PrdpCategory[]>> = {},
): boolean {
  return held.some((h) => h === required || (implies[h] ?? []).includes(required));
}

export interface GracePeriod {
  expiredFrom: string;
  expiredTo: string;
  validUntil: string;
  gazetteReference: string;
}

export type ValidityState = 'valid' | 'expiring_soon' | 'grace_period' | 'expired';

export function validityState(
  expiresOn: string,
  opts: { now?: Date; warnDays?: number; graces?: GracePeriod[] } = {},
): { state: ValidityState; daysRemaining: number; graceReference?: string } {
  const now = opts.now ?? new Date();
  const days = Math.floor((Date.parse(`${expiresOn}T23:59:59Z`) - now.getTime()) / 86_400_000);
  if (days >= 0) return { state: days <= (opts.warnDays ?? 30) ? 'expiring_soon' : 'valid', daysRemaining: days };
  for (const g of opts.graces ?? []) {
    if (expiresOn >= g.expiredFrom && expiresOn <= g.expiredTo && now.toISOString().slice(0, 10) <= g.validUntil) {
      return { state: 'grace_period', daysRemaining: days, graceReference: g.gazetteReference };
    }
  }
  return { state: 'expired', daysRemaining: days };
}
