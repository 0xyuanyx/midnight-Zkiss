// 백엔드 모듈·CLI 공통 환경 변수. 비밀(운영자 비밀·지갑 seed)은 비밀 저장소에서 환경으로 주입하고 로그에 남기지 않는다.
import { hexToBytes } from '../encoding.js';
import type { Config } from './wallet.js';

const req = (env: NodeJS.ProcessEnv, k: string) => {
  const v = env[k];
  if (!v) throw new Error(`MISSING_ENV: ${k}`);
  return v;
};

export const readEndpoints = (env: NodeJS.ProcessEnv = process.env): Config => ({
  indexer: env.MIDNIGHT_INDEXER_URL ?? 'http://127.0.0.1:8088/api/v3/graphql',
  indexerWS: env.MIDNIGHT_INDEXER_WS_URL ?? 'ws://127.0.0.1:8088/api/v3/graphql/ws',
  node: env.MIDNIGHT_NODE_URL ?? 'http://127.0.0.1:9944',
  proofServer: env.MIDNIGHT_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
});

/** MIDNIGHT_CAPABILITIES="admission,reveal" 형식. 없으면 모두 false. */
export const readCapabilities = (env: NodeJS.ProcessEnv = process.env) => {
  const set = new Set((env.MIDNIGHT_CAPABILITIES ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const k of set) if (!['admission', 'reveal', 'anonymousReveal'].includes(k)) throw new Error(`UNKNOWN_CAPABILITY: ${k}`);
  return { admission: set.has('admission'), reveal: set.has('reveal'), anonymousReveal: set.has('anonymousReveal') };
};

export const readNetwork = (env: NodeJS.ProcessEnv = process.env) => env.MIDNIGHT_NETWORK ?? 'undeployed';

export const readAllowlist = (env: NodeJS.ProcessEnv = process.env) =>
  env.MIDNIGHT_CONTRACT_ALLOWLIST ? env.MIDNIGHT_CONTRACT_ALLOWLIST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;

export const readOperatorSecrets = (env: NodeJS.ProcessEnv = process.env) => ({
  walletSeed: req(env, 'MIDNIGHT_OPERATOR_WALLET_SEED'),
  operatorSecret: hexToBytes(req(env, 'MIDNIGHT_OPERATOR_SECRET'), 32),
});
