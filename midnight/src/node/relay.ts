/** Devnet sponsor: accepts a single proven ZKiss call, no caller-supplied transfers.
 * Participant witnesses never enter this module. A dedicated fee wallet is required.
 */
import * as L from '@midnight-ntwrk/ledger-v8';
import { QueryContext, CostModel } from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { ledger, pureCircuits } from '../../contract/managed/zkiss/contract/index.js';
import { decodePayload, fromBase64Url, bytesEqual, hexToBytes } from '../encoding.js';
import type { EventChain, VerificationInput } from '../adapter-contract.js';
import { buildWallet, configureProviders, type Config } from './wallet.js';
import { ZK_PATH } from './operator.js';
import { zkissIndexerView } from '../ledger-decoder.js';

type Providers=Awaited<ReturnType<typeof configureProviders>>;
export function createRelay(options:{network:string; endpoints:Config; walletSeed?:string; providers?:Providers; indexerUrl?:string; indexerWsUrl?:string; outcomeWaitMs?:number; outcomePollMs?:number}) {
  // Keep publicly reachable sponsorship opt-in until economic limits are validated on a shared network.
  if(options.network!=='undeployed') throw Error('RELAY_DEVNET_ONLY');
  let wallet:Awaited<ReturnType<typeof buildWallet>>|undefined;
  let ready:Promise<Providers>|undefined;
  let tail:Promise<unknown>=Promise.resolve();
  const queue=<T>(fn:()=>Promise<T>)=>{const p=tail.then(fn,fn);tail=p.catch(()=>{});return p;};
  const init=()=>ready??=(async()=>{
    setNetworkId(options.network);
    if(options.providers)return options.providers;
    if(!options.walletSeed)throw Error('RELAY_WALLET_SEED_REQUIRED');
    wallet=await buildWallet(options.endpoints,options.walletSeed);
    return configureProviders(wallet,options.endpoints,ZK_PATH,'zkiss-browser-relay');
  })();
  const checkEvent=(event:EventChain)=>{if(event.network!==options.network)throw Error('RELAY_NETWORK_MISMATCH');};
  const validatePublicTransaction=async(transaction:string,input:VerificationInput,event:EventChain)=>{
      checkEvent(event);
      if(input.network!==event.network||input.contractAddress!==event.contractAddress)throw Error('RELAY_SCOPE_MISMATCH');
      const p=await init();
      const tx=L.Transaction.deserialize<L.SignatureEnabled,L.Proof,L.PreBinding>('signature','proof','pre-binding',Buffer.from(transaction,'base64'));
      if(tx.rewards||tx.guaranteedOffer||tx.fallibleOffer?.size||tx.intents?.size!==1)throw Error('RELAY_TRANSFERS_FORBIDDEN');
      const intent=[...tx.intents.values()][0];
      if(intent.guaranteedUnshieldedOffer||intent.fallibleUnshieldedOffer||intent.dustActions||intent.actions.length!==1)throw Error('RELAY_TRANSFERS_FORBIDDEN');
      const call=intent.actions[0];
      if(!(call instanceof L.ContractCall)||call.address!==event.contractAddress)throw Error('RELAY_CONTRACT_MISMATCH');
      const entry=typeof call.entryPoint==='string'?call.entryPoint:new TextDecoder().decode(call.entryPoint);
      if(!['admit','approveReveal'].includes(entry)||entry!==input.circuit)throw Error('RELAY_CIRCUIT_MISMATCH');
      const state=await p.publicDataProvider.queryContractState(event.contractAddress);
      if(!state)throw Error('RELAY_STATE_UNAVAILABLE');
      // Execute only public ledger operations to check this exact server intent's effect.
      // Indexer state and generated ledger use compact-runtime/onchain-runtime classes;
      // ledger-v8 ChargedState is a separate WASM class and rejects this instance.
      let query=new QueryContext(state.data,event.contractAddress);
      const now=BigInt(Math.floor(Date.now()/1000));
      query.block={...query.block,secondsSinceEpoch:now,secondsSinceEpochErr:30,lastBlockTime:now-6n};
      const before=ledger(state.data);
      if(call.guaranteedTranscript)query=query.runTranscript(call.guaranteedTranscript,CostModel.initialCostModel());
      if(call.fallibleTranscript)query=query.runTranscript(call.fallibleTranscript,CostModel.initialCostModel());
      const after=ledger(query.state);
      const payload=decodePayload(fromBase64Url(input.publicPayload));
      if(!bytesEqual(payload.bindingHash,hexToBytes(input.bindingHash,32))||payload.kind!==input.purpose)throw Error('RELAY_BINDING_MISMATCH');
      if(payload.kind==='admission') {
        const key=pureCircuits.admissionKey(payload.bindingHash,payload.admissionNullifier);
        if(before.admissions.member(key)||!after.admissions.member(key)||after.admissions.lookup(key)!==payload.expiresAt)throw Error('RELAY_BINDING_MISMATCH');
      } else {
        const room=before.rooms.lookup(payload.roomId);
        const key=pureCircuits.consentKey(payload.bindingHash,payload.slotIndex===0?room.slotA:room.slotB);
        if(before.consents.member(key)||!after.consents.member(key))throw Error('RELAY_BINDING_MISMATCH');
        const c=after.consents.lookup(key);
        if(!bytesEqual(c.transcript,payload.transcript)||c.expiresAt!==payload.expiresAt||Number(c.slot)!==payload.slotIndex)throw Error('RELAY_BINDING_MISMATCH');
      }
      return { p, tx };
  };
  return {
    mode:'real' as const,
    async validate(transaction:string,input:VerificationInput,event:EventChain) { await validatePublicTransaction(transaction,input,event); },
    async info(event:EventChain) {
      checkEvent(event);const p=await init();
      return {coinPublicKey:p.walletProvider.getCoinPublicKey(),encryptionPublicKey:p.walletProvider.getEncryptionPublicKey(),indexerUrl:options.indexerUrl??options.endpoints.indexer,indexerWsUrl:options.indexerWsUrl??options.endpoints.indexerWS};
    },
    balance(transaction:string,input:VerificationInput,event:EventChain) {return queue(async()=>{
      let checked: Awaited<ReturnType<typeof validatePublicTransaction>>;
      try { checked=await validatePublicTransaction(transaction,input,event); }
      catch(error) {
        // No fee-wallet balance/spend was attempted: the durable marker may be cleared.
        throw Object.assign(new Error('RELAY_VALIDATION_FAILED'), { safeToRetry: true, cause: error });
      }
      const { p, tx }=checked;
      const ttl=new Date(input.expiresAt);
      const finalized=await p.walletProvider.balanceTx(tx,ttl);
      return Buffer.from(finalized.serialize()).toString('base64');
    });},
    submit(transaction:string) {return queue(async()=>{
      const p=await init();
      const tx=L.Transaction.deserialize<L.SignatureEnabled,L.Proof,L.Binding>('signature','proof','binding',Buffer.from(transaction,'base64'));
      const expected=tx.identifiers().at(-1);
      if(!expected)throw Error('RELAY_TRANSACTION_IDENTIFIER_MISSING');
      try { return String(await p.midnightProvider.submitTx(tx)); }
      catch(error) {
        // A finalized broadcast may outlive the HTTP response or process. Only
        // chain evidence makes an exact-byte retry safe to report as submitted.
        // A dropped node watch can precede block inclusion, so poll the indexer briefly.
        const deadline=Date.now()+(options.outcomeWaitMs??30_000);
        for(;;) {
          try {
            const outcome=await zkissIndexerView(options.endpoints.indexer).txOutcome(expected);
            if(outcome==='success'||outcome==='partial'||outcome==='failure')return expected;
          } catch { /* Indexer outage leaves the original outcome unknown. */ }
          if(Date.now()>=deadline)throw error;
          await new Promise(resolve=>setTimeout(resolve,options.outcomePollMs??3_000));
        }
      }
    });},
    async stop(){await wallet?.wallet.stop();},
  };
}
