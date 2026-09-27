const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64 = (b: Uint8Array) => { let s = ''; for (const n of b) s += String.fromCharCode(n); return btoa(s); };
import { createProofAssetLoader } from './proof-assets';
const asset = createProofAssetLoader(path => self.postMessage({ stage: `asset:${path}` }));
const zk = { getProverKey: (c: string) => asset(`keys/${c}.prover`), getVerifierKey: (c: string) => asset(`keys/${c}.verifier`), getZKIR: (c: string) => asset(`zkir/${c}.bzkir`) };
let ready: Promise<any> | undefined;
const initialize = () => ready ??= (async () => {
    await import('./browser-polyfills');
    self.postMessage({ stage: 'loading-sdk' });
    const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
    self.postMessage({ stage: 'loading-contracts' });
    const { createUnprovenCallTxFromInitialStates } = await import('@midnight-ntwrk/midnight-js/contracts');
    self.postMessage({ stage: 'loading-ledger' });
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js/network-id');
    const ledger = await import('@midnight-ntwrk/ledger-v8');
    const compactRuntime = await import('@midnight-ntwrk/compact-runtime');
    self.postMessage({ stage: 'loading-prover' });
    const { provingProvider } = await import('@midnight-ntwrk/zkir-v2');
    const { Contract } = await import('../../../midnight/sns/managed/sns/contract/index.js');
    const { witnesses } = await import('../../../midnight/sns/witnesses');
    const { decodePayload, fromBase64Url } = await import('../../../midnight/src/encoding');
    const { parseTerms } = await import('../../../midnight/sns/device');
    await Promise.all([zk.getProverKey('approveReveal'), zk.getVerifierKey('approveReveal'), zk.getZKIR('approveReveal'), asset('params/bls_midnight_2p16')]);
    return {CompiledContract,createUnprovenCallTxFromInitialStates,setNetworkId,ledger,compactRuntime,provingProvider,Contract,witnesses,decodePayload,fromBase64Url,parseTerms};
})().catch(e=>{ready=undefined;throw e;});
self.onmessage = async ({ data }) => {
  try {
    const start=performance.now();
    const {CompiledContract,createUnprovenCallTxFromInitialStates,setNetworkId,ledger,compactRuntime,provingProvider,Contract,witnesses,decodePayload,fromBase64Url,parseTerms}=await initialize();
    self.postMessage({metric:'initialization',durationMs:performance.now()-start});
    if(data.type==='warm') {self.postMessage({warmed:true});return;}
    if (data.intent.protocolVersion !== 'zkiss-sns-v1') throw new Error('PROTOCOL_MISMATCH');
    self.postMessage({ stage: 'constructing' });
    setNetworkId(data.network);
    const payload = decodePayload(fromBase64Url(data.intent.publicPayload));
    if (payload.kind !== 'reveal_approval') throw new Error('PURPOSE_MISMATCH');
    const compiled = CompiledContract.make('zkiss', Contract).pipe(CompiledContract.withWitnesses(witnesses));
    const call = await createUnprovenCallTxFromInitialStates(zk as any, {
      compiledContract: compiled, circuitId: 'approveReveal', contractAddress: data.contractAddress,
      args: [payload.bindingHash, payload.expiresAt, payload.roomId, parseTerms(data.terms)],
      initialPrivateState: data.privateState,
      initialContractState: compactRuntime.ContractState.deserialize(bytes(data.context.contractState)),
      initialZswapChainState: ledger.ZswapChainState.deserialize(bytes(data.context.zswapState)),
      ledgerParameters: ledger.LedgerParameters.deserialize(bytes(data.context.parameters)),
      coinPublicKey: '0'.repeat(64),
    } as any, '0'.repeat(64));
    // Load assets before entering WASM so missing files become a recoverable JS error.
    await Promise.all([zk.getProverKey('approveReveal'), zk.getVerifierKey('approveReveal'), zk.getZKIR('approveReveal'), asset('params/bls_midnight_2p16')]);
    const prover = provingProvider({
      lookupKey: async (name: string) => { try { return { proverKey: await zk.getProverKey(name), verifierKey: await zk.getVerifierKey(name), ir: await zk.getZKIR(name) }; } catch { return undefined; } },
      getParams: (k: number) => asset(`params/bls_midnight_2p${k}`),
    });
    self.postMessage({ stage: 'proving' });
    const proofStart=performance.now();
    const proven = await call.private.unprovenTx.prove(prover, ledger.CostModel.initialCostModel());
    self.postMessage({metric:"proving",durationMs:performance.now()-proofStart});
    // Only proven public transaction bytes leave this worker. Never post call/private/witness data.
    self.postMessage({ transaction: b64(proven.serialize()) });
  } catch (e) { self.postMessage({ error: e instanceof Error ? e.message : 'PROOF_FAILED' }); }
};
