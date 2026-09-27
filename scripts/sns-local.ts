/** Dedicated local MVP launcher; the shared team DATABASE_URL is never used. */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { migrate } from '../backend/src/db.js';
const root = resolve(import.meta.dirname, '..');
const action = process.argv[2];
if (!['setup','api','worker'].includes(action)) throw new Error('Usage: sns-local.ts setup|api|worker');
if (existsSync(resolve(root,'backend/.env'))) process.loadEnvFile(resolve(root,'backend/.env'));
const deploymentEnv = resolve(root,'midnight/.env.sns.local');
if (!existsSync(deploymentEnv)) throw new Error('Run the SNS local deployment first');
// Deployment data must come from the explicitly isolated local contract, not shell/team settings.
const { parseEnv } = await import('node:util');
const { readFile } = await import('node:fs/promises');
Object.assign(process.env, parseEnv(await readFile(deploymentEnv,'utf8')), {
  ZKISS_MODE:'real', MIDNIGHT_PROTOCOL:'zkiss-sns-v1', ADMISSION_MODE:'open',
  DEFAULT_EVENT_ID:'evt_sns_mvp', AUTO_CREATE_EVENT:'true',
  SECURE_COOKIES:'true', PUBLIC_ORIGIN:'https://127.0.0.1:5176', PORT:'3003',
  DATABASE_URL:'postgres://zkiss:local-development-only@127.0.0.1:55432/zkiss?options=-c%20search_path%3Dsns_mvp',
  MIDNIGHT_ADAPTER_MODULE:resolve(root,'midnight/sns/adapter.module.ts'),
  MIDNIGHT_OPERATOR_MODULE:resolve(root,'midnight/sns/operator.module.ts'),
  MIDNIGHT_NODE_URL:'http://127.0.0.1:9944',
  MIDNIGHT_INDEXER_URL:'http://127.0.0.1:8088/api/v3/graphql',
  MIDNIGHT_INDEXER_WS_URL:'ws://127.0.0.1:8088/api/v3/graphql/ws',
  MIDNIGHT_PROOF_SERVER_URL:'http://127.0.0.1:6300',
  AI_MODE:'real',
});
delete process.env.DATABASE_CA_PEM;
delete process.env.AI_PROVIDER_MODULE;
if (action === 'setup') {
  const admin = new Pool({connectionString:'postgres://zkiss:local-development-only@127.0.0.1:55432/zkiss'});
  try { await admin.query('CREATE SCHEMA IF NOT EXISTS sns_mvp'); } finally { await admin.end(); }
  const pool = new Pool({connectionString:process.env.DATABASE_URL});
  try { await migrate(pool); } finally { await pool.end(); }
  console.log('Dedicated local sns_mvp schema ready; shared DB unchanged.');
} else if (action === 'api') await import('../backend/src/server.js');
else await import('../backend/src/worker-main.js');
