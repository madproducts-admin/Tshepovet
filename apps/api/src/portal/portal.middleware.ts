import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { type AccountStore, ApiError, type SessionData, type SessionStore } from '@tshepovet/core';
import { MFA_REQUIRED_ROLES } from '@tshepovet/contracts';
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
 *   1. loads the buyer session (or, under /api/staff, the staff session) from its cookie, then
 *      re-reads the account from the database on every request, so the session never outlives
 *      the facts it rests on: a disabled user, a suspended organisation or a removed staff
 *      member ends the session; the role comes from the database, not the session; and a role
 *      that requires two-step verification without it enrolled is held at the mfa_setup stage;
 *   2. for POST/PUT/PATCH/DELETE, requires CSRF proof: an X-CSRF-Token header equal to the
 *      csrf cookie (double submit) and, once signed in, to the session's own token.
 */
export function portalContext(sessions: SessionStore, accounts: AccountStore, names: CookieNames) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const cookies = parseCookies(req.header('cookie'));
      req.cookies = cookies;
      const isStaff = req.path === '/staff' || req.path.startsWith('/staff/');

      const token = cookies[isStaff ? names.staffSession : names.userSession];
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        const session = await sessions.touch(token);
        if (session && session.kind === (isStaff ? 'staff' : 'user')) {
          const current = isStaff ? await currentStaff(session, accounts) : await currentUser(session, accounts);
          if (!current) {
            await sessions.destroy(token);
          } else {
            if (current.role !== session.role || current.stage !== session.stage) {
              await sessions.update(token, { role: current.role, stage: current.stage });
            }
            const live = { ...session, role: current.role, stage: current.stage };
            if (isStaff) req.staff = { token, session: live };
            else req.portal = { token, session: live };
          }
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

type Current = { role: string; stage: SessionData['stage'] } | null;

async function currentUser(s: SessionData, accounts: AccountStore): Promise<Current> {
  const u = await accounts.userById(s.subjectId);
  if (!u || u.disabled_at || u.tenant_status !== 'active' || u.tenant_id !== s.tenantId) return null;
  const needsMfa = (MFA_REQUIRED_ROLES as readonly string[]).includes(u.role) && !u.mfa_enrolled;
  return { role: u.role, stage: needsMfa ? 'mfa_setup' : s.stage === 'mfa_setup' && !u.mfa_enrolled ? 'mfa_setup' : 'full' };
}

async function currentStaff(s: SessionData, accounts: AccountStore): Promise<Current> {
  const st = await accounts.staffById(s.subjectId);
  if (!st || st.disabled_at) return null;
  return { role: st.role, stage: st.mfa_enrolled ? 'full' : 'mfa_setup' };
}
