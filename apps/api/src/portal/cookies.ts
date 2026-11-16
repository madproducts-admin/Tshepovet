import type { Response } from 'express';

/**
 * Portal cookies. Over HTTPS they use the __Host- prefix: Secure, Path=/, no Domain, so a
 * sibling subdomain can never set or read them. Plain-http tests use unprefixed names.
 *   session  HttpOnly, SameSite=Lax   the opaque session token
 *   csrf     readable by the page     double-submit token, echoed in X-CSRF-Token
 */
export interface CookieNames {
  userSession: string;
  staffSession: string;
  userCsrf: string;
  staffCsrf: string;
}

export function cookieNames(secure: boolean): CookieNames {
  const p = secure ? '__Host-' : '';
  return { userSession: `${p}tv_session`, staffSession: `${p}tv_staff_session`, userCsrf: `${p}tv_csrf`, staffCsrf: `${p}tv_staff_csrf` };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export function setCookie(res: Response, name: string, value: string, o: { secure: boolean; httpOnly: boolean; maxAgeSeconds?: number }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${o.maxAgeSeconds}`);
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res: Response, name: string, secure: boolean) {
  setCookie(res, name, '', { secure, httpOnly: true, maxAgeSeconds: 0 });
}
