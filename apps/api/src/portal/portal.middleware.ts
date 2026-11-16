import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { type AccountStore, ApiError, type SessionData, type SessionKind, type SessionStore } from '@tshepovet/core';
import { MFA_REQUIRED_ROLES } from '@tshepovet/contracts';
import { type CookieNames, parseCookies } from './cookies';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function same(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Which kind of session a path belongs to: the staff console, supplier self-service, or the buyer portal. */
export function kindFor(path: string): SessionKind {
  if (path === '/staff' || path.startsWith('/staff/')) return 'staff';
  if (path === '/vendor' || path.startsWith('/vendor/')) return 'vendor';
  return 'user';
}

/**
 * Runs for every /api request (the portal, staff and supplier APIs; /v1 keeps API keys):
 *   1. loads the session for the path's kind from its cookie, then re-reads the account from
 *      the database on every request, so the session never outlives the facts it rests on: a
 *      disabled user, a suspended organisation, a removed staff member or supplier contact
 *      ends the session; the role comes from the database, not the session; and a role that
 *      requires two-step verification without it enrolled is held at the mfa_setup stage;
 *   2. for POST/PUT/PATCH/DELETE, requires CSRF proof: an X-CSRF-Token header equal to the
 *      csrf cookie (double submit) and, once signed in, to the session's own token.
 */
export function portalContext(sessions: SessionStore, accounts: AccountStore, pool: Pool, names: CookieNames) {
  const cookie = { user: [names.userSession, names.userCsrf], staff: [names.staffSession, names.staffCsrf], vendor: [names.vendorSession, names.vendorCsrf] } as const;
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const cookies = parseCookies(req.header('cookie'));
      req.cookies = cookies;
      const kind = kindFor(req.path);
      const [sessionCookie, csrfCookie] = cookie[kind];

      const token = cookies[sessionCookie];
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        const session = await sessions.touch(token);
        if (session && session.kind === kind) {
          const current = kind === 'staff' ? await currentStaff(session, accounts) : kind === 'vendor' ? await currentVendor(session, pool) : await currentUser(session, accounts);
          if (!current) {
            await sessions.destroy(token);
          } else {
            if (current.role !== session.role || current.stage !== session.stage) {
              await sessions.update(token, { role: current.role, stage: current.stage });
            }
            const live = { ...session, role: current.role, stage: current.stage };
            if (kind === 'staff') req.staff = { token, session: live };
            else if (kind === 'vendor') req.vendor = { token, session: live, vendorId: current.vendorId! };
            else req.portal = { token, session: live };
          }
        }
      }

      if (UNSAFE.has(req.method)) {
        const header = req.header('x-csrf-token');
        const session = kind === 'staff' ? req.staff?.session : kind === 'vendor' ? req.vendor?.session : req.portal?.session;
        const ok = same(header, cookies[csrfCookie]) && (!session || same(header, session.csrf));
        if (!ok) throw new ApiError(403, 'csrf_failed', 'The request could not be verified. Reload the page and try again.');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

type Current = { role: string; stage: SessionData['stage']; vendorId?: string } | null;

/*
 * The stage is only ever DOWNGRADED here, never upgraded. A session at mfa_setup was signed in
 * with a password alone; the account later enrolling MFA (in another session) must not lift it
 * to full access. Only AuthService.mfaEnable promotes a session, and only the one that
 * completed enrolment; enrolling also ends the account's other sessions.
 */
async function currentUser(s: SessionData, accounts: AccountStore): Promise<Current> {
  const u = await accounts.userById(s.subjectId);
  if (!u || u.disabled_at || u.tenant_status !== 'active' || u.tenant_id !== s.tenantId) return null;
  const needsMfa = (MFA_REQUIRED_ROLES as readonly string[]).includes(u.role) && !u.mfa_enrolled;
  return { role: u.role, stage: needsMfa ? 'mfa_setup' : s.stage };
}

async function currentStaff(s: SessionData, accounts: AccountStore): Promise<Current> {
  const st = await accounts.staffById(s.subjectId);
  if (!st || st.disabled_at) return null;
  return { role: st.role, stage: st.mfa_enrolled ? s.stage : 'mfa_setup' };
}

/** A supplier contact: still on record, and the supplier it speaks for comes from the database. */
async function currentVendor(s: SessionData, pool: Pool): Promise<Current> {
  const r = await pool.query<{ vendor_id: string }>(`SELECT vendor_id FROM vendor_contact_live($1)`, [s.subjectId]);
  const c = r.rows[0];
  if (!c) return null;
  return { role: 'vendor_contact', stage: 'full', vendorId: c.vendor_id };
}
