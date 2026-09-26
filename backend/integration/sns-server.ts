/** Isolated SNS Devnet browser test server. Never reads the shared backend/.env. */
import { resolve } from 'node:path';
import { database } from '../test/helpers.js';
import { migrate } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { localConfig } from '../src/config.js';
import { ensureDefaultEvent } from '../src/default-event.js';
import { maintain, reconcile, processChainJobs } from '../src/worker.js';
import { processRelayJobs } from '../src/relay-worker.js';
process.env.NODE_ENV = 'test';
process.loadEnvFile(resolve(process.env.SNS_TEST_ENV_FILE ?? 'midnight/.env.sns.local'));
const { default: midnight } = await import('../../midnight/sns/adapter.module.js');
const { createOperatorRuntime } = await import('../../midnight/sns/operator.js');
const { readOperatorSecrets, readEndpoints } = await import('../../midnight/src/node/env.js');
const { default: ai } = await import('../test/browser-provider.js');
if (process.env.TEST_DATABASE_URL && !['127.0.0.1', 'localhost'].includes(new URL(process.env.TEST_DATABASE_URL).hostname)) throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
const db = await database();
await migrate(db.pool);
const config = { ...localConfig, mode: 'real' as const, aiMode: 'real' as const, admissionMode: 'open' as const, snsOnly: true, secureCookies: true, origin: process.env.SNS_TEST_ORIGIN ?? 'https://127.0.0.1:5176', requireGeneratedImage: true, sessionRateLimit: 1000, defaultEventId: 'evt_sns_test', midnightNetwork: 'undeployed', midnightContractAddress: process.env.MIDNIGHT_CONTRACT_ADDRESS, midnightEventScope: process.env.MIDNIGHT_EVENT_SCOPE };
await ensureDefaultEvent(db.pool, config);
const runtime = createOperatorRuntime({ network: 'undeployed', endpoints: readEndpoints(), ...readOperatorSecrets(), privateStateStore: process.env.MIDNIGHT_OPERATOR_STATE_STORE ?? 'sns-test-server' });
const app = await buildApp({ config, pool: db.pool, ai, midnight });
await app.listen({host:'127.0.0.1',port:Number(process.env.SNS_TEST_PORT ?? 3003)});
console.log('SNS test server: isolated schema, actual Devnet, SYNTHETIC AI');
let running = true;
const loop = (async () => { while(running) { try { await maintain(db.pool); await reconcile(db.pool, midnight); await processChainJobs(db.pool, midnight, runtime.operator); await processRelayJobs(db.pool, runtime.operator); } catch { console.error('SNS_TEST_WORKER_ERROR'); } await new Promise(r => setTimeout(r,1500)); } })();
async function stop() { running=false;await loop;await app.close();await runtime.stop();await db.close();process.exit(); }
process.once('SIGINT', () => void stop());process.once('SIGTERM', () => void stop());
