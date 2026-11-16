/**
 * How numbers, money and dates read in TshepoVet: South African style, a space between
 * thousands and a decimal comma (R1 250,00).
 *
 * Money and counts are formatted by hand, not with Intl: browsers and Node ship different
 * locale data (one writes "R1 250,00", another "R 1 250,00"), and a page rendered on the
 * server must read the same once the browser takes over. The space is a no-break space, so
 * an amount never wraps.
 */
const NBSP = '\u00a0';
const group = (n: number) => Math.trunc(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
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

export function formatMoney(cents: number, whole = false): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const rands = group(Math.floor(abs / 100));
  return whole && abs % 100 === 0 ? `${sign}R${rands}` : `${sign}R${rands},${String(abs % 100).padStart(2, '0')}`;
}
export const formatCount = (n: number) => `${n < 0 ? '-' : ''}${group(n)}`;
export function formatPercent(fraction: number): string {
  const v = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1).replace('.', ',')}%`;
}

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
