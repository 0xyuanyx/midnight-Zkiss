/** Adapted from main c3470f9: retry transient asset failures, cache successes only. */
export function createProofAssetLoader(onLoad: (path: string) => void = () => {}, fetcher: typeof fetch = fetch,
  delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  const assets = new Map<string, Promise<Uint8Array>>();
  return (path: string): Promise<Uint8Array> => {
    const cached = assets.get(path);
    if (cached) return cached;
    const pending = (async () => {
      onLoad(path);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetcher(`/zk/sns/${path}`, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error('PROOF_ASSET_UNAVAILABLE');
          return new Uint8Array(await response.arrayBuffer());
        } catch {
          if (attempt === 2) throw new Error('PROOF_ASSET_UNAVAILABLE');
          await delay(500 * (attempt + 1));
        }
      }
      throw new Error('PROOF_ASSET_UNAVAILABLE');
    })();
    assets.set(path, pending);
    void pending.catch(() => { if (assets.get(path) === pending) assets.delete(path); });
    return pending;
  };
}
