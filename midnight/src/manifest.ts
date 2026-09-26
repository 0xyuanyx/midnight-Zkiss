// zk manifest (MIDNIGHT_SPEC §6): everything a device/backend needs to agree on, minus any secret.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CONTACT_BYTES, PROTOCOL_VERSION } from './encoding.js';
import { CIRCUITS } from './adapter.js';

export type ManifestInput = {
  managedDir: string; // contract/managed/zkiss
  network: string;
  contractAddress: string | null;
  eventScope: string | null;
  assetBaseUrl: string | null; // where the device fetches keys/zkir from, if served
  compilerVersion: string;
  runtimeVersion: string;
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const buildManifest = async (i: ManifestInput) => {
  const info = JSON.parse(await readFile(path.join(i.managedDir, 'compiler', 'contract-info.json'), 'utf8'));
  const assets: { path: string; sha256: string; bytes: number }[] = [];
  for (const dir of ['keys', 'zkir']) {
    const files = (await readdir(path.join(i.managedDir, dir)).catch(() => [])).sort();
    for (const f of files) {
      const b = await readFile(path.join(i.managedDir, dir, f));
      assets.push({ path: `${dir}/${f}`, sha256: sha256(b), bytes: b.length });
    }
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    network: i.network,
    contractAddress: i.contractAddress,
    eventScope: i.eventScope,
    toolchain: { compact: i.compilerVersion, compactRuntime: i.runtimeVersion, ledger: 'ledger-v8' },
    circuits: info.circuits?.map((c: { name: string; pure: boolean }) => ({ name: c.name, pure: c.pure })) ?? [],
    intents: {
      admission: { circuit: CIRCUITS.admission, caller: 'participant device', args: ['bindingHash: Bytes<32>', 'expiresAt: Uint<64> (unix sec)'] },
      reveal_approval: { circuit: CIRCUITS.reveal_approval, caller: 'slot owner device', args: ['bindingHash', 'roomId', 'terms: RevealTerms'] },
    },
    publicPayload: {
      encoding: 'base64url of fixed big-endian layout',
      admission: '0x01 | bindingHash(32) | expiresAtSec(u64) | eventScope(32)',
      reveal_approval: '0x02 | bindingHash(32) | expiresAtSec(u64) | roomId(32) | slotIndex(u8) | transcript(32)',
    },
    canonical: {
      bindingHash: 'backend binding-v1 SHA-256, 64 lowercase hex, used verbatim as Bytes<32>',
      contact: `NFC UTF-8, zero-padded to ${CONTACT_BYTES} bytes, longer rejected`,
      transcript: 'revealTranscript pure circuit (persistentHash), contract address included',
      time: 'whole unix seconds; compared with blockTimeLt',
    },
    provingAssets: { baseUrl: i.assetBaseUrl, files: assets },
    provers: ['proof-server (HTTP, sees witness data: run on device or trusted host)', 'zkir-v2 WASM in-process (device)'],
    readback: 'indexer GraphQL contractAction(address).state decoded with the compiled ledger(); success = ledger effect for bindingHash',
    errorCodes: [
      'CAPABILITY_DISABLED', 'BINDING_MISMATCH', 'EXPIRY_MISMATCH', 'PURPOSE_MISMATCH', 'NETWORK_MISMATCH', 'CONTRACT_MISMATCH',
      'PROTOCOL_MISMATCH', 'CIRCUIT_MISMATCH', 'EVENT_SCOPE_MISMATCH', 'EFFECT_NOT_FOUND', 'TX_FAILED', 'TX_PARTIAL', 'EXPIRED',
      'ROOM_CLOSED', 'ROOM_NOT_FOUND', 'CHAIN_READ_FAILED', 'CONTRACT_STATE_UNAVAILABLE', 'TX_LOOKUP_FAILED',
    ],
  };
};
