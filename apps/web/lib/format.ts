/**
 * How numbers, money and dates read in TshepoVet: South African English, rand with a space
 * as the thousands separator (R1 250,00 is how SA writes it; en-ZA formats that way).
 */
const rand = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 });
const randWhole = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('en-ZA');
const pct = new Intl.NumberFormat('en-ZA', { style: 'percent', maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
const dayShort = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' });
const stamp = new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Johannesburg',
});
const relative = new Intl.RelativeTimeFormat('en-ZA', { numeric: 'auto' });

export const formatMoney = (cents: number, whole = false) => (whole && cents % 100 === 0 ? randWhole : rand).format(cents / 100);
export const formatCount = (n: number) => count.format(n);
export const formatPercent = (fraction: number) => pct.format(fraction);

/** A calendar day ('YYYY-MM-DD' or an instant) as "16 November 2026". */
export function formatDay(value: string | Date, short = false): string {
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+02:00`) : new Date(value);
  return (short ? dayShort : day).format(d);
}

/** An instant as "16 Nov 2026, 14:05" (SAST). */
export const formatInstant = (value: string | Date) => stamp.format(new Date(value));

/** "3 days ago", "in 2 weeks": always paired with the absolute date in a title or tooltip. */
export function formatRelative(value: string | Date, now = Date.now()): string {
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['week', 7 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return relative.format(Math.round(diff / ms), unit);
  return 'just now';
}

/** Whole days from today to a calendar day (negative once past). */
export function daysUntil(dayIso: string, now = new Date()): number {
  const target = Date.parse(`${dayIso}T00:00:00+02:00`);
  const today = Date.parse(`${now.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' })}T00:00:00+02:00`);
  return Math.round((target - today) / 86_400_000);
}
