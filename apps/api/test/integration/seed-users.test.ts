import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '@tshepovet/core';
import { parseUsers, type SeedReport, seedUsers, type SeedUser } from '../../../../scripts/seed-users';
import { buildTestApp, ownerPool, resetDatabase } from './harness';
import { Browser, ownerWithMfa } from './portal-helpers';

/**
 * scripts/seed-users.ts (the owner's request, 2026-11-17): the people in a users file get a staff
 * console account and a buyer-portal account in one organisation, and can sign in; a re-run
 * changes nothing; nobody is moved out of another organisation; weak passwords stop the run.
 * Made-up people only: the real users file never enters a test.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
const ORG = 'Seeded Organisation (sandbox)';
const PASSWORDS: Record<string, string> = {
  'boss@seed.example': 'quiet harbour lantern 7',
  'ann.lee@seed.example': 'amber orchard violin 3',
  'reader@seed.example': 'granite meadow pocket 9',
};
const USERS: SeedUser[] = parseUsers(
  JSON.stringify([
    { email: 'boss@seed.example', password: PASSWORDS['boss@seed.example'], superAdmin: true, admin: true },
    { email: 'ann.lee@seed.example', password: PASSWORDS['ann.lee@seed.example'], admin: true },
    { email: 'reader@seed.example', password: PASSWORDS['reader@seed.example'] },
  ]),
);

async function run(users: SeedUser[], resetPasswords = false): Promise<SeedReport> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const report = await seedUsers(c, users, { org: ORG, resetPasswords });
    await c.query('COMMIT');
    return report;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
const auditCount = async () => Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE actor_id = 'seed-users'`)).rows[0]!.n);

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  t = await buildTestApp();
}, 120_000);

afterAll(async () => {
  await t?.close();
  await owner?.end();
});

describe('seeding the users file', () => {
  it('gives everyone a staff admin account and one organisation, the super admin as its owner', async () => {
    const report = await run(USERS);
    expect(report.map((r) => r.staff)).toEqual(['created (admin)', 'created (admin)', 'created (admin)']);
    expect(report.map((r) => r.portal)).toEqual([`created "${ORG}" with this person as owner`, 'created (admin)', 'created (viewer)']);

    const staff = await owner.query<{ email: string; role: string; full_name: string; password_hash: string; mfa_enrolled: boolean }>(
      `SELECT email, role, full_name, password_hash, mfa_enrolled FROM staff_users WHERE email LIKE '%@seed.example' ORDER BY email`,
    );
    expect(staff.rows.map((s) => [s.email, s.role, s.full_name, s.mfa_enrolled])).toEqual([
      ['ann.lee@seed.example', 'admin', 'Ann Lee', false],
      ['boss@seed.example', 'admin', 'Boss', false],
      ['reader@seed.example', 'admin', 'Reader', false],
    ]);
    for (const s of staff.rows) expect(await verifyPassword(s.password_hash, PASSWORDS[s.email]!)).toBe(true);

    const portal = await owner.query<{ email: string; role: string; legal_name: string; verified: boolean; password_hash: string }>(
      `SELECT u.email, u.role, t.legal_name, u.email_verified_at IS NOT NULL AS verified, u.password_hash
         FROM tenant_users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email LIKE '%@seed.example' ORDER BY u.email`,
    );
    expect(portal.rows.map((u) => [u.email, u.role, u.legal_name, u.verified])).toEqual([
      ['ann.lee@seed.example', 'admin', ORG, true],
      ['boss@seed.example', 'owner', ORG, true],
      ['reader@seed.example', 'viewer', ORG, true],
    ]);
    for (const u of portal.rows) expect(await verifyPassword(u.password_hash, PASSWORDS[u.email]!)).toBe(true);
    // The organisation is a real one: it has its wallet, as a sign-up would.
    const wallet = await owner.query(`SELECT 1 FROM wallets w JOIN tenants t ON t.id = w.tenant_id WHERE t.legal_name = $1`, [ORG]);
    expect(wallet.rowCount).toBe(1);
    expect(await auditCount()).toBe(6);
  });

  it('changes nothing when run again', async () => {
    const before = await auditCount();
    const report = await run(USERS);
    expect(report.every((r) => r.staff === 'already right' && r.portal === 'already right')).toBe(true);
    expect(await auditCount()).toBe(before);
  });

  it('leaves someone in another organisation where they are, and resets passwords only when asked', async () => {
    await ownerWithMfa(t.app, owner, 'elsewhere@seed.example', 'Elsewhere (Pty) Ltd');
    const extra = parseUsers(JSON.stringify([{ email: 'elsewhere@seed.example', password: 'silver kettle compass 5', admin: true }]));
    const report = await run([...USERS, ...extra]);
    expect(report.find((r) => r.email === 'elsewhere@seed.example')!.portal).toBe('left as it is: already a member of another organisation');
    const still = await owner.query<{ legal_name: string }>(`SELECT t.legal_name FROM tenant_users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = 'elsewhere@seed.example'`);
    expect(still.rows[0]!.legal_name).toBe('Elsewhere (Pty) Ltd');

    const changed = parseUsers(JSON.stringify([{ email: 'reader@seed.example', password: 'cobalt river saddle 4' }]));
    const kept = await run(changed);
    expect(kept[0]!.staff).toBe('already right');
    const reset = await run(changed, true);
    expect(reset[0]!.staff).toBe('updated (password reset)');
    expect(reset[0]!.portal).toBe('updated (password reset)');
    const h = await owner.query<{ password_hash: string }>(`SELECT password_hash FROM staff_users WHERE email = 'reader@seed.example'`);
    expect(await verifyPassword(h.rows[0]!.password_hash, 'cobalt river saddle 4')).toBe(true);
  });

  it('refuses a password the app would refuse, and a person listed twice', () => {
    expect(() => parseUsers(JSON.stringify([{ email: 'weak@seed.example', password: 'short' }]))).toThrow(/would refuse this password/);
    expect(() => parseUsers(JSON.stringify([{ email: 'weak@seed.example', password: 'password1234' }]))).toThrow(/too common/);
    expect(() => parseUsers(JSON.stringify([{ email: 'a@seed.example', password: 'quiet harbour lantern 7' }, { email: 'A@seed.example', password: 'quiet harbour lantern 7' }]))).toThrow(/appears twice/);
    expect(() => parseUsers('[]')).toThrow(/non-empty/);
  });

  it('lets a seeded person sign in to the portal and the staff console, two-step verification first', async () => {
    const b = await new Browser(t.app).init();
    const login = b.adopt(await b.post('/api/auth/login', { email: 'boss@seed.example', password: PASSWORDS['boss@seed.example'] }));
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.session.stage).toBe('mfa_setup');

    const staff = request.agent(t.app).set('cf-connecting-ip', '10.77.0.9');
    const csrf = (await staff.get('/api/staff/auth/csrf')).body.csrf_token;
    const s = await staff.post('/api/staff/auth/login').set('x-csrf-token', csrf).send({ email: 'ann.lee@seed.example', password: PASSWORDS['ann.lee@seed.example'] });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.session.stage).toBe('mfa_setup');
  });
});
