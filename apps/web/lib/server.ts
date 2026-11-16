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
}

/** Sandbox flag and prices. If the API cannot be reached, the page still says "sandbox". */
export async function getMeta(): Promise<Meta> {
  try {
    const r = await fetch(`${origin}/api/meta`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (r.ok) return (await r.json()) as Meta;
  } catch {
    // fall through to the cautious default below
  }
  return {
    sandbox: true,
    currency: 'ZAR',
    vat_rate: 0.15,
    check_prices: { company_cents: 300, company_live_cents: 600, driver_cents: 250, monitoring_per_supplier_month_cents: 1500 },
    modules: [],
  };
}
