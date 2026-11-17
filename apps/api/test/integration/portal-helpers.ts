import type { Server } from 'node:http';
import type { Pool } from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import { totpCode, totpStep } from '@tshepovet/core';

export const PW = 'correct horse battery 42';
let visitor = 100;

/** A browser: keeps cookies and sends the CSRF header. Each one is its own visitor (IP). */
export class Browser {
  agent: ReturnType<typeof request.agent>;
  csrf = '';
  constructor(app: Server) {
    ++visitor;
    this.agent = request.agent(app).set('cf-connecting-ip', `10.${(visitor >> 8) & 255}.${visitor & 255}.7`);
  }
  async init() {
    const r = await this.agent.get('/api/auth/csrf');
    this.csrf = r.body.csrf_token;
    return this;
  }
  get(path: string) {
    return this.agent.get(path);
  }
  post(path: string, body: unknown = {}) {
    return this.agent.post(path).set('x-csrf-token', this.csrf).send(body as object);
  }
  patch(path: string, body: unknown = {}) {
    return this.agent.patch(path).set('x-csrf-token', this.csrf).send(body as object);
  }
  del(path: string) {
    return this.agent.delete(path).set('x-csrf-token', this.csrf);
  }
  adopt(res: request.Response) {
    const token = res.body?.session?.csrf_token ?? res.body?.csrf_token;
    if (token) this.csrf = token;
    return res;
  }
}

export async function mailToken(owner: Pool, to: string, template: string) {
  const r = await owner.query<{ body_text: string }>(
    `SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`,
    [to, template],
  );
  const token = r.rows[0]?.body_text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  expect(token, `${template} link for ${to}`).toBeTruthy();
  return token!;
}

/** Signs up an organisation, confirms the email, signs the owner in and enrols MFA. */
export async function ownerWithMfa(app: Server, owner: Pool, email: string, org: string, name = 'Thandi Mokoena') {
  const b = await new Browser(app).init();
  expect((await b.post('/api/auth/signup', { organisation_name: org, full_name: name, email, password: PW, accept_terms: true })).status).toBe(202);
  expect((await b.post('/api/auth/verify-email', { token: await mailToken(owner, email, 'verify_email') })).status).toBe(200);
  b.adopt(await b.post('/api/auth/login', { email, password: PW }));
  const setup = await b.post('/api/auth/mfa/setup');
  const en = await b.post('/api/auth/mfa/enable', { code: totpCode(setup.body.secret, totpStep()) });
  expect(en.status).toBe(200);
  const tenant = await owner.query<{ tenant_id: string; id: string }>(`SELECT tenant_id, id FROM tenant_users WHERE email = $1`, [email]);
  return { b, tenantId: tenant.rows[0]!.tenant_id, userId: tenant.rows[0]!.id };
}

/** Invites someone with a role, accepts as them and signs them in (roles without required MFA). */
export async function member(app: Server, owner: Pool, inviter: Browser, email: string, role: string, name = 'Sam Member') {
  expect((await inviter.post('/api/team/invitations', { email, role })).status).toBe(202);
  const b = await new Browser(app).init();
  const acc = await b.post('/api/auth/invitations/accept', { token: await mailToken(owner, email, 'invite'), full_name: name, password: PW });
  expect(acc.status, JSON.stringify(acc.body)).toBe(201);
  b.adopt(acc);
  const s = await b.get('/api/auth/session');
  if (s.status !== 200 || s.body.stage !== 'full') b.adopt(await b.post('/api/auth/login', { email, password: PW }));
  return b;
}
