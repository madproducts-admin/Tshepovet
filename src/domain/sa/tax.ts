/**
 * SARS identifiers.
 *
 * VAT number: 10 digits starting with 4. We validate format only - SARS does
 * not publish a check-digit algorithm for VAT numbers, so we never reject on
 * one; authoritative validation is the VAT vendor search via a provider.
 *
 * Income tax reference: 10 digits; first digit 0-3 or 9 (individuals,
 * companies, trusts). Format-only for the same reason.
 *
 * TCS PIN: issued on eFiling per Tax Compliance Status request. The taxpayer
 * chooses the expiry at request time, the status it reveals is LIVE (a PIN
 * that showed "compliant" yesterday can show "non-compliant" today), and the
 * taxpayer can cancel it at any time. It is a bearer credential.
 */
export function normaliseVatNumber(input: string): string | null {
  const v = input.replace(/[\s-]/g, '');
  return /^4\d{9}$/.test(v) ? v : null;
}

export function normaliseTaxReference(input: string): string | null {
  const v = input.replace(/[\s-]/g, '');
  return /^[0-39]\d{9}$/.test(v) ? v : null;
}

export class TcsPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TcsPinError';
  }
}

export interface NormalisedTcsPin {
  pin: string;
  /** 10 digits starting 0-4/9: probably the tax or VAT number pasted by mistake. */
  looksLikeTaxNumber: boolean;
}

/**
 * Normalise a PIN. SARS does not publish a PIN grammar, so we only enforce a
 * permissive shape and surface the most common user error as a soft signal
 * (the WhatsApp bot asks the user to confirm; the API rejects only when the
 * PIN equals the supplied tax reference).
 */
export function normaliseTcsPin(input: string): NormalisedTcsPin {
  const pin = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(pin)) throw new TcsPinError('TCS PIN must be 6-20 letters or digits');
  return { pin, looksLikeTaxNumber: /^[0-49]\d{9}$/.test(pin) };
}

export type TcsStatus = 'compliant' | 'non_compliant' | 'unknown';

export interface TcsResult {
  status: TcsStatus;
  pinStatus: 'active' | 'expired' | 'revoked' | 'invalid';
  pinExpiresOn: string | null;
  taxpayerName: string | null;
  checkedAt: string;
}

/** Days until PIN expiry (negative = expired). */
export function daysUntil(isoDate: string, now: Date = new Date()): number {
  const d = Date.parse(`${isoDate}T23:59:59Z`);
  return Math.floor((d - now.getTime()) / 86_400_000);
}
