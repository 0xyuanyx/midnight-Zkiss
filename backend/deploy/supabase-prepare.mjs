/** Run after the owner connection has been verified. Secrets stay in ignored files. */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

const adminEnv = await readFile('.env.supabase.admin', 'utf8');
const adminUrl = adminEnv.match(/^DATABASE_URL=(.+)$/m)?.[1];
if (!adminUrl) throw new Error('SUPABASE_ADMIN_URL_MISSING');
const origin = new URL(adminUrl);
if (origin.hostname !== 'aws-0-ap-northeast-2.pooler.supabase.com' ||
    origin.username !== 'postgres.jdoirdexxiabsddbthca' ||
    origin.port !== '5432' || origin.searchParams.get('sslmode') !== 'verify-full' ||
    !origin.searchParams.has('sslrootcert')) throw new Error('UNEXPECTED_DATABASE_TARGET');
const db = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 12000 });
try {
  const owner = await db.query('SELECT current_user AS name, current_database() AS db');
  if (owner.rows[0].name !== 'postgres' || owner.rows[0].db !== 'postgres') {
    throw new Error('DATABASE_OWNER_MISMATCH');
  }
  const migrations = await db.query('SELECT version FROM public.migrations ORDER BY version');
  if (migrations.rows.map(x => x.version).join(',') !== '001,002,003,004,005') {
    throw new Error('RUN_BACKEND_MIGRATIONS_FIRST');
  }
  const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname='zkiss_backend'");
  if (role.rowCount) throw new Error('APP_ROLE_ALREADY_EXISTS');
  const secret = randomBytes(32).toString('hex');
  const quoted = (await db.query('SELECT quote_literal($1) AS value', [secret])).rows[0].value;
  const access = await readFile('deploy/supabase-access.sql', 'utf8');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE zkiss_backend LOGIN PASSWORD ${quoted} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await client.query(access);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const appUrl = new URL(adminUrl);
  appUrl.username = 'zkiss_backend.jdoirdexxiabsddbthca';
  appUrl.password = secret;
  const appEnv = `DATABASE_URL=${appUrl.toString()}\nZKISS_MODE=real\nSECURE_COOKIES=true\n`;
  await writeFile('.env.supabase.app', appEnv, { mode: 0o600, flag: 'wx' });
  await chmod('.env.supabase.app', 0o600);
  console.log('Supabase backend role, table grants and RLS policies applied. App URL saved privately.');
} finally {
  await db.end();
}
