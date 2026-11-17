import { readFileSync } from 'node:fs';
import { Client, type ClientBase } from 'pg';
import { hashPassword, passwordProblems, verifyPassword } from '../packages/core/src/auth/password';

/**
 * Makes sure the people in a users file can sign in to TshepoVet (owner's request, 2026-11-17).
 *
 *   MIGRATION_DATABASE_URL=... npx tsx scripts/seed-users.ts [--file D:\applications\USERS.json]
 *       [--org "MAD Products (sandbox)"] [--reset-passwords] [--dry-run]
 *
 * The file is a JSON array of { email, password, superAdmin?, admin?, name? } (the fleet's
 * D:\applications\USERS.json). Each person gets:
 *   - a staff console account, role admin (the console's highest role: superAdmin adds nothing
 *     there), and
 *   - a buyer-portal account in one sandbox organisation: the first superAdmin is its owner, the
 *     other admins are admins, anyone else a viewer; the email address counts as confirmed.
 * Both ask for two-step verification at the first sign-in. Safe to run again: nothing changes
 * for accounts that are already right. An existing account keeps its password unless
 * --reset-passwords is given. A password the app's own rules would refuse stops the run, and no
 * password is ever printed. Every change is written to the audit log as a system action.
 *
 * Pre-registration: anyone can sign up with an address they do not control (the account stays
 * unconfirmed, with their password and their organisation). So an existing *unconfirmed* portal
 * account counts as this person's only when its password matches the file (or
 * --reset-passwords replaces it); otherwise the seed leaves it unconfirmed, says so, and puts
 * nobody into its organisation.
 */
export interface SeedUser {
  email: string;
  password: string;
  superAdmin?: boolean;
  admin?: boolean;
  name?: string;
}
export interface SeedOptions {
  org: string;
  resetPasswords?: boolean;
}
export type SeedReport = Array<{ email: string; staff: string; portal: string }>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseUsers(text: string): SeedUser[] {
  const users = JSON.parse(text) as unknown;
  if (!Array.isArray(users) || !users.length) throw new Error('the users file must be a non-empty JSON array');
  const seen = new Set<string>();
  return users.map((u, i) => {
    const r = u as Partial<SeedUser>;
    const email = String(r.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw new Error(`entry ${i + 1}: "${email}" is not an email address`);
    if (seen.has(email)) throw new Error(`entry ${i + 1}: ${email} appears twice`);
    seen.add(email);
    if (typeof r.password !== 'string') throw new Error(`${email}: no password`);
    const problems = passwordProblems(r.password, { email, name: r.name ?? email.split('@')[0] });
    if (problems.length) throw new Error(`${email}: the app would refuse this password: ${problems.join(' ')}`);
    return { email, password: r.password, superAdmin: r.superAdmin === true, admin: r.admin === true, name: r.name };
  });
}

/** "admin@x" -> "Administrator", "anton@x" -> "Anton", unless the file names the person. */
export const displayName = (u: SeedUser) => {
  if (u.name?.trim()) return u.name.trim();
  const local = u.email.split('@')[0]!;
  if (local === 'admin') return 'Administrator';
  return local.split(/[._-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};
const portalRole = (u: SeedUser, isOwner: boolean) => (isOwner ? 'owner' : u.admin || u.superAdmin ? 'admin' : 'viewer');

async function platformEvent(db: ClientBase, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  await db.query(`SELECT audit_platform_event('system', 'seed-users', $1, $2, $3, NULL, NULL, $4)`, [action, entityType, entityId, JSON.stringify(details)]);
}
async function tenantEvent(db: ClientBase, tenantId: string, action: string, entityId: string, details: Record<string, unknown>) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, details) VALUES ($1, 'system', 'seed-users', $2, 'user', $3, $4)`,
    [tenantId, action, entityId, JSON.stringify(details)],
  );
}

/** Runs inside the caller's transaction on an owner (BYPASSRLS) connection. */
export async function seedUsers(db: ClientBase, users: SeedUser[], opts: SeedOptions): Promise<SeedReport> {
  const report: SeedReport = users.map((u) => ({ email: u.email, staff: '', portal: '' }));
  const row = (email: string) => report.find((r) => r.email === email)!;

  // -- The staff console --------------------------------------------------------------------
  for (const u of users) {
    const r = row(u.email);
    const found = await db.query<{ id: string; role: string; disabled_at: Date | null }>(`SELECT id, role, disabled_at FROM staff_users WHERE email = $1`, [u.email]);
    const s = found.rows[0];
    if (!s) {
      const ins = await db.query<{ id: string }>(
        `INSERT INTO staff_users (email, full_name, role, password_hash, password_changed_at) VALUES ($1, $2, 'admin', $3, now()) RETURNING id`,
        [u.email, displayName(u), await hashPassword(u.password)],
      );
      await platformEvent(db, 'staff.seeded', 'staff_user', ins.rows[0]!.id, { role: 'admin' });
      r.staff = 'created (admin)';
      continue;
    }
    const changes: string[] = [];
    if (s.role !== 'admin') {
      await db.query(`UPDATE staff_users SET role = 'admin' WHERE id = $1`, [s.id]);
      changes.push(`role ${s.role} -> admin`);
    }
    if (s.disabled_at) {
      await db.query(`UPDATE staff_users SET disabled_at = NULL WHERE id = $1`, [s.id]);
      changes.push('enabled');
    }
    if (opts.resetPasswords) {
      await db.query(`UPDATE staff_users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [s.id, await hashPassword(u.password)]);
      changes.push('password reset');
    }
    if (changes.length) await platformEvent(db, 'staff.seeded', 'staff_user', s.id, { changes });
    r.staff = changes.length ? `updated (${changes.join(', ')})` : 'already right';
  }

  // -- The buyer portal: one sandbox organisation -------------------------------------------
  type PortalRow = { id: string; tenant_id: string; role: string; email_verified_at: Date | null; password_hash: string | null };
  const portalRow = async (email: string) =>
    (await db.query<PortalRow>(`SELECT id, tenant_id, role, email_verified_at, password_hash FROM tenant_users WHERE email = $1 AND disabled_at IS NULL`, [email])).rows[0];
  // Whether an existing portal account is this person's: confirmed already, or its password is
  // the one in the file (someone pre-registering the address would not know it), or the run
  // replaces the password anyway.
  const isTheirs = async (row: PortalRow, u: SeedUser) =>
    Boolean(row.email_verified_at) || Boolean(opts.resetPasswords) || (await verifyPassword(row.password_hash, u.password));
  const UNPROVEN = 'left unconfirmed: an existing unconfirmed account with another password (it may not be this person\'s); run with --reset-passwords to take it over';

  const ownerUser = users.find((u) => u.superAdmin) ?? users.find((u) => u.admin) ?? users[0]!;
  const existingOwner = await portalRow(ownerUser.email);
  let tenantId: string;
  if (existingOwner) {
    if (!(await isTheirs(existingOwner, ownerUser))) {
      // Never confirm it, and never add anyone to an organisation a stranger may have made.
      for (const u of users) row(u.email).portal = u === ownerUser ? UNPROVEN : `not added: the owner's account (${ownerUser.email}) is unconfirmed and may not be theirs`;
      return report;
    }
    tenantId = existingOwner.tenant_id;
  } else {
    const created = await db.query<{ tenant_id: string; user_id: string }>(`SELECT * FROM auth_signup($1, $2, $3, $4)`, [
      opts.org,
      displayName(ownerUser),
      ownerUser.email,
      await hashPassword(ownerUser.password),
    ]);
    const c = created.rows[0];
    if (!c) throw new Error(`could not create the organisation for ${ownerUser.email}`);
    tenantId = c.tenant_id;
    await db.query(`UPDATE tenant_users SET email_verified_at = now() WHERE id = $1`, [c.user_id]);
    await tenantEvent(db, tenantId, 'user.seeded', c.user_id, { role: 'owner', organisation: 'created' });
    row(ownerUser.email).portal = `created "${opts.org}" with this person as owner`;
  }

  for (const u of users) {
    const r = row(u.email);
    if (r.portal) continue;
    const isOwner = u === ownerUser;
    const want = portalRole(u, isOwner);
    const t = await portalRow(u.email);
    if (t && t.tenant_id !== tenantId) {
      // One sign-in identity per email across the platform: never move someone's account.
      r.portal = 'left as it is: already a member of another organisation';
      continue;
    }
    if (t && !(await isTheirs(t, u))) {
      r.portal = UNPROVEN;
      continue;
    }
    if (!t) {
      const ins = await db.query<{ id: string }>(
        `INSERT INTO tenant_users (tenant_id, email, full_name, role, password_hash, password_changed_at, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, now(), now()) RETURNING id`,
        [tenantId, u.email, displayName(u), want, await hashPassword(u.password)],
      );
      await tenantEvent(db, tenantId, 'user.seeded', ins.rows[0]!.id, { role: want });
      r.portal = `created (${want})`;
      continue;
    }
    const changes: string[] = [];
    // The owner stays owner; nobody is demoted by a re-run.
    if (t.role !== want && t.role !== 'owner') {
      await db.query(`UPDATE tenant_users SET role = $2 WHERE id = $1`, [t.id, want]);
      changes.push(`role ${t.role} -> ${want}`);
    }
    if (!t.email_verified_at) {
      await db.query(`UPDATE tenant_users SET email_verified_at = now() WHERE id = $1`, [t.id]);
      changes.push('email confirmed');
    }
    if (opts.resetPasswords) {
      await db.query(`UPDATE tenant_users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [t.id, await hashPassword(u.password)]);
      changes.push('password reset');
    }
    if (changes.length) await tenantEvent(db, tenantId, 'user.seeded', t.id, { changes });
    r.portal = changes.length ? `updated (${changes.join(', ')})` : 'already right';
  }
  return report;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL (the owner login) is required');
  const file = arg('file') ?? 'D:/applications/USERS.json';
  const users = parseUsers(readFileSync(file, 'utf8'));
  const opts: SeedOptions = { org: arg('org') ?? 'MAD Products (sandbox)', resetPasswords: process.argv.includes('--reset-passwords') };
  const dry = process.argv.includes('--dry-run');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('BEGIN');
    const report = await seedUsers(db, users, opts);
    await db.query(dry ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify({ dryRun: dry, users: report }, null, 2));
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

// Run as a script (tsx), not when a test imports seedUsers.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
