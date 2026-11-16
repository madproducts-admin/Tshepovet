/**
 * The browser's client for the portal API (same origin: /api). Sends the CSRF token on every
 * change, turns problem+json into ApiProblem, and sends a lapsed session to sign-in.
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

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const r = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
  csrfToken = ((await r.json()) as { csrf_token: string }).csrf_token;
  return csrfToken;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; query?: Query } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await csrf();
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
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) {
      window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    if (p.code === 'csrf_failed') csrfToken = null;
    throw new ApiProblem(res.status, p.code ?? `http_${res.status}`, p.title ?? 'Something went wrong. Try again.', p.details);
  }
  return data as T;
}
