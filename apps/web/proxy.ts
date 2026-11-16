import { type NextRequest, NextResponse } from 'next/server';

/**
 * Every page gets a fresh nonce and a strict Content Security Policy (Next.js applies the nonce
 * to its own scripts). Scripts load from this origin with the nonce; the Cloudflare Web
 * Analytics beacon, which the zone injects, is allowed by host. Inline style attributes are
 * allowed (Radix positions popovers with them; a nonce cannot cover attributes), style
 * elements are not.
 *
 * Portal pages without a session cookie go straight to sign-in (the API still decides: this
 * only saves a round trip).
 */
const SESSION_COOKIES = ['__Host-tv_session', 'tv_session'];
const STAFF_COOKIES = ['__Host-tv_staff_session', 'tv_staff_session'];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const has = (names: string[]) => names.some((n) => request.cookies.has(n));
  if (pathname.startsWith('/app') && !has(SESSION_COOKIES)) {
    const url = new URL('/sign-in', request.url);
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  if (pathname.startsWith('/staff') && !pathname.startsWith('/staff/sign-in') && !has(STAFF_COOKIES)) {
    return NextResponse.redirect(new URL('/staff/sign-in', request.url));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  // Behind Cloudflare and IIS the original scheme arrives in X-Forwarded-Proto.
  const https = request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self' https://cloudflareinsights.com${dev ? ' ws:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|v1|_next/static|_next/image|favicon.ico|seal.svg|robots.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
