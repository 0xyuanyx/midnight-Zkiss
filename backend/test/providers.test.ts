import { expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localConfig } from '../src/config.js';
import { loadProviders } from '../src/providers.js';

test('worker provider loading does not import the API relay wallet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zkiss-relay-module-'));
  const modulePath = join(dir, 'relay.mjs');
  try {
    await writeFile(modulePath, "throw new Error('API_RELAY_WALLET_LOADED');\n");
    const config = { ...localConfig, mode: 'real' as const, midnightRelayModule: modulePath };
    await expect(loadProviders(config, { includeRelay: false })).resolves.toMatchObject({ relay: undefined });
    await expect(loadProviders(config)).rejects.toThrow('API_RELAY_WALLET_LOADED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
