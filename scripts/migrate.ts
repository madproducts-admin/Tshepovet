import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/** Minimal forward-only migrator. Production: run as the schema owner role (BYPASSRLS). */
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.WORKER_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(process.cwd(), 'db', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await client.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
    if (done.rowCount) continue;
    process.stdout.write(`applying ${file}... `);
    await client.query(readFileSync(path.join(dir, file), 'utf8'));
    await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    process.stdout.write('ok\n');
  }
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
