// `npm run manifest` — writes reports/zkiss-manifest.json (no secrets). Uses vitest only as a TS runner.
// Env: ZKISS_NETWORK, ZKISS_CONTRACT_ADDRESS, ZKISS_EVENT_SCOPE, ZKISS_ASSET_BASE_URL (all optional).
import { it } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildManifest } from '../../src/manifest.js';

it('generate manifest', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const m = await buildManifest({
    managedDir: path.join(root, 'contract/managed/zkiss'),
    network: process.env.ZKISS_NETWORK ?? 'undeployed',
    contractAddress: process.env.ZKISS_CONTRACT_ADDRESS ?? null,
    eventScope: process.env.ZKISS_EVENT_SCOPE ?? null,
    assetBaseUrl: process.env.ZKISS_ASSET_BASE_URL ?? null,
    compilerVersion: '0.31.1',
    runtimeVersion: '0.16.0',
  });
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports/zkiss-manifest.json'), JSON.stringify(m, null, 2));
});
