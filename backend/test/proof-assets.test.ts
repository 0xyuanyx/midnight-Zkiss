import { test, expect, vi } from 'vitest';
import { createProofAssetLoader } from '../../web/src/midnight/proof-assets.js';

test('proof assets retry network/body failures and reuse the successful download', async () => {
  const fetcher = vi.fn()
    .mockRejectedValueOnce(new Error('connection reset'))
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
  const loader = createProofAssetLoader(() => {}, fetcher, async () => {});
  const a = loader('keys/approveReveal.prover');
  const b = loader('keys/approveReveal.prover');
  expect(a).toBe(b);
  expect(await a).toEqual(new Uint8Array([1, 2, 3]));
  await loader('keys/approveReveal.prover');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('failed assets are evicted so a later explicit retry can succeed', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  const loader = createProofAssetLoader(() => {}, fetcher, async () => {});
  await expect(loader('params/bls_midnight_2p16')).rejects.toThrow('PROOF_ASSET_UNAVAILABLE');
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValue(new Response(new Uint8Array([4])));
  expect(await loader('params/bls_midnight_2p16')).toEqual(new Uint8Array([4]));
});
