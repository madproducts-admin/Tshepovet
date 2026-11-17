import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { hashPassword } from '../packages/core/src/auth/password';

/**
 * Creates a TshepoVet staff account (staff console). Staff cannot sign up through the API.
 *
 *   MIGRATION_DATABASE_URL=... npx tsx scripts/create-staff.ts --email a@b.c --name "Full Name" --role admin --out C:\path\to\file
 *
 * A random 24-character password is generated and written to --out only (never printed), for
 * the operator to hand over; at first sign-in the staff member must set up two-step
 * verification before anything else. Roles: support, reviewer, admin.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const role = arg('role') ?? 'support';
  const out = arg('out');
  if (!url || !email || !name || !out || !['support', 'reviewer', 'admin'].includes(role)) {
    throw new Error('usage: MIGRATION_DATABASE_URL=... tsx scripts/create-staff.ts --email E --name N --role support|reviewer|admin --out FILE');
  }
  const password = crypto.randomBytes(18).toString('base64url');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO staff_users (email, full_name, role, password_hash, password_changed_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [email, name, role, await hashPassword(password)],
    );
    writeFileSync(out, `TshepoVet staff account\nemail: ${email}\npassword: ${password}\nSign in, then set up two-step verification.\n`, { mode: 0o600 });
    console.log(JSON.stringify({ staff_id: r.rows[0]!.id, email, role, password_file: out }));
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
