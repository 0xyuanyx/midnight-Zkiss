import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { validateRelay } from './relay.js';
// MIDNIGHT_ADAPTER_MODULE 진입점(백엔드 API·worker). default export = MidnightAdapter v2.
// 필요한 환경: MIDNIGHT_NETWORK, MIDNIGHT_INDEXER_URL, MIDNIGHT_CAPABILITIES(기본 없음=전부 false),
// 선택: MIDNIGHT_CONTRACT_ALLOWLIST, MIDNIGHT_ZK_MANIFEST_URL.
import { createMidnightAdapter } from '../src/adapter.js';
import { zkissIndexerView, zkissTranscriptOf } from './ledger-decoder.js';
import { readAllowlist, readCapabilities, readEndpoints, readNetwork } from '../src/node/env.js';

const adapter = createMidnightAdapter({
  mode: 'real',
  network: readNetwork(),
  zkManifestUrl: process.env.MIDNIGHT_ZK_MANIFEST_URL ?? null,
  protocolVersion: 'zkiss-sns-v1',
  capabilities: { admission: false, reveal: true, anonymousReveal: false },
  chain: zkissIndexerView(readEndpoints().indexer),
  transcriptOf: zkissTranscriptOf,
  contractAllowlist: readAllowlist(),
});

const endpoints = readEndpoints();
const publicData = indexerPublicDataProvider(endpoints.indexer, endpoints.indexerWS);
export default Object.assign(adapter, {
  async proofContext(event: import('../src/adapter-contract.js').EventChain) {
    if (event.network !== readNetwork() || !readAllowlist()?.includes(event.contractAddress)) throw new Error('CONTRACT_NOT_ALLOWED');
    const state = await publicData.queryZSwapAndContractState(event.contractAddress);
    if (!state) throw new Error('CHAIN_UNAVAILABLE');
    return { contractState: Buffer.from(state[1].serialize()).toString('base64'), zswapState: Buffer.from(state[0].serialize()).toString('base64'), parameters: Buffer.from(state[2].serialize()).toString('base64') };
  },
  async validateRelay(raw: string, prepared: import('../src/adapter-contract.js').PreparedIntent) {
    if (prepared.network !== readNetwork() || !readAllowlist()?.includes(prepared.contractAddress)) throw new Error('CONTRACT_NOT_ALLOWED');
    const state = await publicData.queryContractState(prepared.contractAddress);
    if (!state) throw new Error('CHAIN_UNAVAILABLE');
    validateRelay(Buffer.from(raw, 'base64'), prepared, state);
  },
});
