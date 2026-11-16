import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError, type SessionStore } from '@tshepovet/core';
import { type CookieNames, parseCookies } from './cookies';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function same(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Runs for every /api request (the portal and staff APIs; /v1 keeps API keys):
 *   1. loads the buyer session (or, under /api/staff, the staff session) from its cookie;
 *   2. for POST/PUT/PATCH/DELETE, requires CSRF proof: an X-CSRF-Token header equal to the
 *      csrf cookie (double submit) and, once signed in, to the session's own token.
 * A cross-site page can neither read the cookie nor set the header, and the session cookie is
 * SameSite=Lax on top of that.
 */
export function portalContext(sessions: SessionStore, names: CookieNames) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const cookies = parseCookies(req.header('cookie'));
      req.cookies = cookies;
      const isStaff = req.path === '/staff' || req.path.startsWith('/staff/');

      const token = cookies[isStaff ? names.staffSession : names.userSession];
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        const session = await sessions.touch(token);
        const kind = isStaff ? 'staff' : 'user';
        if (session && session.kind === kind) {
          if (isStaff) req.staff = { token, session };
          else req.portal = { token, session };
        }
      }

      if (UNSAFE.has(req.method)) {
        const header = req.header('x-csrf-token');
        const cookie = cookies[isStaff ? names.staffCsrf : names.userCsrf];
        const session = isStaff ? req.staff?.session : req.portal?.session;
        const ok = same(header, cookie) && (!session || same(header, session.csrf));
        if (!ok) throw new ApiError(403, 'csrf_failed', 'The request could not be verified. Reload the page and try again.');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
