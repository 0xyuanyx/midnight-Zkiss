// MIDNIGHT_ADAPTER_MODULE 진입점(백엔드 API·worker). default export = MidnightAdapter v2.
// 필요한 환경: MIDNIGHT_NETWORK, MIDNIGHT_INDEXER_URL, MIDNIGHT_CAPABILITIES(기본 없음=전부 false),
// 선택: MIDNIGHT_CONTRACT_ALLOWLIST, MIDNIGHT_ZK_MANIFEST_URL.
import { createMidnightAdapter } from '../adapter.js';
import { zkissIndexerView, zkissTranscriptOf } from '../ledger-decoder.js';
import { readAllowlist, readCapabilities, readEndpoints, readNetwork } from './env.js';

const adapter = createMidnightAdapter({
  mode: 'real',
  network: readNetwork(),
  zkManifestUrl: process.env.MIDNIGHT_ZK_MANIFEST_URL ?? null,
  capabilities: readCapabilities(),
  chain: zkissIndexerView(readEndpoints().indexer),
  transcriptOf: zkissTranscriptOf,
  contractAllowlist: readAllowlist(),
});

export default adapter;
