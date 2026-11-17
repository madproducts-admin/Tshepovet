// Server only: imported by server components and route handlers, never by client code.

/**
 * The web server's own calls to the API (public data only: it never forwards a visitor's
 * session). TSV_API_ORIGIN is the API on loopback (127.0.0.1:9131 on the box).
 */
const origin = process.env.TSV_API_ORIGIN ?? 'http://127.0.0.1:9131';

export interface Meta {
  sandbox: boolean;
  currency: 'ZAR';
  vat_rate: number;
  check_prices: { company_cents: number; company_live_cents: number; driver_cents: number; monitoring_per_supplier_month_cents: number };
  modules: Array<{ sku: string; name: string; description: string; price_cents: number; available: boolean; unavailable_reason: string | null }>;
  /** Whether TshepoVet's operator is a VAT vendor: if not, vat_rate is 0 and no VAT is charged. */
  vat_registered: boolean;
  /** Who runs TshepoVet (ECTA s43, POPIA); null: not configured yet. */
  seller: {
    legal_name: string;
    trading_name: string;
    registration_number: string | null;
    vat_number: string | null;
    address: string | null;
    directors: string[];
    email: string | null;
    phone: string | null;
    website: string;
    information_officer: string | null;
    information_regulator_number: string | null;
  };
}

/** The site's public address, for links that leave the page (a printed passport's QR code). */
export const PUBLIC_ORIGIN = process.env.TSV_PUBLIC_ORIGIN ?? 'https://tshepovet.madproducts.ai';

export type PassportLoad =
  | { kind: 'ok'; passport: import('@tshepovet/contracts').PublicPassport }
  | { kind: 'withdrawn' }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** A published passport, by its public id (the API decides what it shows). */
export async function getPassport(id: string): Promise<PassportLoad> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return { kind: 'missing' };
  try {
    const r = await fetch(`${origin}/api/passport/${id.toLowerCase()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (r.status === 404) return { kind: 'missing' };
    if (r.status === 410) return { kind: 'withdrawn' };
    if (!r.ok) return { kind: 'unavailable' };
    return { kind: 'ok', passport: await r.json() };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The cautious default: what the pages show when the API cannot be reached. */
const FALLBACK_META: Meta = {
  sandbox: true,
  currency: 'ZAR',
  vat_rate: 0,
  vat_registered: false,
  check_prices: { company_cents: 300, company_live_cents: 600, driver_cents: 250, monitoring_per_supplier_month_cents: 1500 },
  modules: [],
  seller: {
    legal_name: 'MAD Products (Pty) Ltd',
    trading_name: 'TshepoVet',
    registration_number: null,
    vat_number: null,
    address: null,
    directors: [],
    email: null,
    phone: null,
    website: 'https://tshepovet.madproducts.ai',
    information_officer: null,
    information_regulator_number: null,
  },
};

/**
 * Sandbox flag and prices. If the API cannot be reached, the page still says "sandbox". An
 * answer from an older API (or a cached one, served stale while Next refetches it) may lack a
 * field added since, as `seller` once did: the default fills it rather than breaking the page.
 */
export async function getMeta(): Promise<Meta> {
  try {
    const r = await fetch(`${origin}/api/meta`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const m = (await r.json()) as Partial<Meta>;
      return {
        ...FALLBACK_META,
        ...m,
        // An older answer has only the rate: VAT charged means registered.
        vat_registered: m.vat_registered ?? (m.vat_rate ?? 0) > 0,
        seller: { ...FALLBACK_META.seller, ...m.seller },
      };
    }
  } catch {
    // fall through to the cautious default below
  }
  return FALLBACK_META;
}
