import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createOperatorRuntime } from '../sns/operator.js';
import { randomBytes32, bytesToHex } from '../src/encoding.js';
import { localConfig } from '../src/node/wallet.js';
if (existsSync('.env.sns.local')) throw new Error('SNS_DEPLOYMENT_ALREADY_EXISTS: preserve the existing deployment and operator secret');
const operatorSecret = randomBytes32();
const walletSeed = '0'.repeat(63) + '1';
const runtime = createOperatorRuntime({ network: 'undeployed', endpoints: localConfig, operatorSecret, walletSeed, privateStateStore: 'sns-mvp-local' });
try {
  const result = await runtime.deployEvent(new Date(Date.now() + 7 * 86400000));
  await mkdir('reports', { recursive: true });
  await writeFile('reports/sns-deployment.json', JSON.stringify(result, null, 2));
  await writeFile('.env.sns.local', `MIDNIGHT_NETWORK=undeployed\nMIDNIGHT_OPERATOR_WALLET_SEED=${walletSeed}\nMIDNIGHT_OPERATOR_SECRET=${bytesToHex(operatorSecret)}\nMIDNIGHT_CONTRACT_ADDRESS=${result.contractAddress}\nMIDNIGHT_EVENT_SCOPE=${result.eventScope}\nMIDNIGHT_CONTRACT_ALLOWLIST=${result.contractAddress}\nMIDNIGHT_OPERATOR_STATE_STORE=sns-mvp-local\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await runtime.stop(); }
