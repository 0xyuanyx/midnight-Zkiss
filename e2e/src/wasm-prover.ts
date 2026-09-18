// 증명 서버 없이 이 프로세스 안에서 zkir-v2 WASM으로 계약 회로를 증명한다.
// midnight-js의 dappConnectorProofProvider는 지갑의 getProvingProvider(keyMaterialProvider)에 증명을 맡긴다.
// 여기서는 지갑 대신 zkir-v2의 provingProvider를 넘겨, 브라우저 단말에서 증명하는 구성과 같은 경로를 만든다.
// 수수료(DUST) 증명은 수수료를 내는 지갑(운영자) 쪽에서 따로 만든다 — 참가자 비밀과 무관하다.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { provingProvider } from '@midnight-ntwrk/zkir-v2';
import { dappConnectorProofProvider } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import * as ledger from '@midnight-ntwrk/ledger-v8';

// 공개 파라미터(bls_midnight_2p{k}). 브라우저에서는 앱이 정적 파일로 제공한다
const PARAMS_DIR = path.resolve(import.meta.dirname, '../.zk-params');

export const provingStats: { keyLocation: string; ms: number }[] = [];

export async function wasmProofProvider(zkConfigProvider: unknown) {
  const api = {
    async getProvingProvider(km: any) {
      // midnight-js가 넘기는 km은 getZKIR/getProverKey/getVerifierKey 형태이고,
      // zkir-v2는 lookupKey(→{proverKey, verifierKey, ir}) 형태를 요구하므로 변환한다
      const inner = provingProvider({
        lookupKey: async (loc: string) => {
          try {
            const [proverKey, verifierKey, ir] = await Promise.all([
              km.getProverKey(loc), km.getVerifierKey(loc), km.getZKIR(loc),
            ]);
            return { proverKey, verifierKey, ir };
          } catch {
            return undefined;
          }
        },
        getParams: async (k: number) => new Uint8Array(await readFile(path.join(PARAMS_DIR, `bls_midnight_2p${k}`))),
      });
      // 회로별 증명 시간을 기록한다(증거용)
      return {
        check: (pre: Uint8Array, loc: string) => inner.check(pre, loc),
        async prove(pre: Uint8Array, loc: string, bind?: bigint) {
          const t = Date.now();
          const out = await inner.prove(pre, loc, bind);
          provingStats.push({ keyLocation: loc, ms: Date.now() - t });
          return out;
        },
      };
    },
  };
  return dappConnectorProofProvider(api as any, zkConfigProvider as any, ledger.CostModel.initialCostModel());
}
