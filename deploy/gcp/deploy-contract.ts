import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createOperatorRuntime } from '../../midnight/sns/operator.js';
import { randomBytes32, bytesToHex } from '../../midnight/src/encoding.js';
import { readEndpoints } from '../../midnight/src/node/env.js';
const destination = '/config/contract.env';
if (existsSync(destination)) throw new Error('DEPLOYMENT_ALREADY_EXISTS');
const operatorSecret = randomBytes32();
const walletSeed = '0'.repeat(63) + '1'; // Isolated devnet genesis; never public testnet funds.
const runtime = createOperatorRuntime({ network: 'undeployed', endpoints: readEndpoints(), operatorSecret, walletSeed, privateStateStore: 'zkiss-cloud' });
try {
  const result = await runtime.deployEvent(new Date(Date.now() + 7 * 86400000));
  await writeFile(destination, `MIDNIGHT_NETWORK=undeployed\nMIDNIGHT_OPERATOR_WALLET_SEED=${walletSeed}\nMIDNIGHT_OPERATOR_SECRET=${bytesToHex(operatorSecret)}\nMIDNIGHT_CONTRACT_ADDRESS=${result.contractAddress}\nMIDNIGHT_EVENT_SCOPE=${result.eventScope}\nMIDNIGHT_CONTRACT_ALLOWLIST=${result.contractAddress}\nMIDNIGHT_OPERATOR_STATE_STORE=zkiss-cloud\n`, { mode: 0o600 });
  console.log(JSON.stringify({contractAddress:result.contractAddress,eventScope:result.eventScope}));
} finally { await runtime.stop(); }
