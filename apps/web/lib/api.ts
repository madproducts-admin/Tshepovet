/**
 * The browser's client for the API (same origin: /api). Sends the CSRF token on every change,
 * turns problem+json into ApiProblem, and sends a lapsed session to sign-in.
 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiProblem';
  }

  /** Validation issues by field ("vat_number" -> message), for forms. */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    return Object.fromEntries(issues.map((i) => [i.path, i.message]));
  }
}

/**
 * Three realms share the client: buyers (the portal, /api), suppliers (self-service,
 * /api/vendor) and TshepoVet staff (/api/staff), each with its own session cookie, CSRF token
 * and sign-in page.
 */
interface Realm {
  csrfPath: string;
  signIn: string;
  /** Paths that answer 401 as part of signing in, so a 401 there is not a lapsed session. */
  authPrefix: string;
  token: string | null;
}
const buyer: Realm = { csrfPath: '/api/auth/csrf', signIn: '/sign-in', authPrefix: '/api/auth/', token: null };
const supplier: Realm = { csrfPath: '/api/vendor/auth/csrf', signIn: '/supplier/sign-in', authPrefix: '/api/vendor/auth/', token: null };
const staff: Realm = { csrfPath: '/api/staff/auth/csrf', signIn: '/staff/sign-in', authPrefix: '/api/staff/auth/', token: null };

export const setCsrfToken = (t: string | null) => {
  buyer.token = t;
};
export const setVendorCsrfToken = (t: string | null) => {
  supplier.token = t;
};
export const setStaffCsrfToken = (t: string | null) => {
  staff.token = t;
};

async function csrf(realm: Realm): Promise<string> {
  if (realm.token) return realm.token;
  const r = await fetch(realm.csrfPath, { credentials: 'same-origin', cache: 'no-store' });
  realm.token = ((await r.json()) as { csrf_token: string }).csrf_token;
  return realm.token;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

type Init = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; query?: Query };

async function call<T>(realm: Realm, path: string, init: Init = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await csrf(realm);
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(withQuery(path, init.query), {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const p = (typeof data === 'object' ? data : {}) as { code?: string; title?: string; details?: Record<string, unknown> };
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith(realm.authPrefix)) {
      window.location.assign(`${realm.signIn}?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    if (p.code === 'csrf_failed') realm.token = null;
    throw new ApiProblem(res.status, p.code ?? `http_${res.status}`, p.title ?? 'Something went wrong. Try again.', p.details);
  }
  return data as T;
}

/** The buyer portal's API. */
export const api = <T,>(path: string, init: Init = {}) => call<T>(buyer, path, init);
/** The supplier self-service API (/api/vendor). */
export const vendorApi = <T,>(path: string, init: Init = {}) => call<T>(supplier, path, init);
/** The staff console's API (/api/staff). */
export const staffApi = <T,>(path: string, init: Init = {}) => call<T>(staff, path, init);
