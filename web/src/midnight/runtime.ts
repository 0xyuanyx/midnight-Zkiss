import './polyfills';
import { mergePrivateState } from './state-merge';
import { sdkSigningStore } from './sdk-signing-store';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Transaction } from '@midnight-ntwrk/ledger-v8';
import { Contract, ledger, pureCircuits } from '../../../midnight/contract/managed/zkiss/contract/index.js';
import { witnesses, type ZkissPrivateState } from '../../../midnight/contract/witnesses.js';
import * as device from '../../../midnight/src/device.js';
import { sealContact, openContact, type Envelope } from '../../../midnight/src/envelope.js';
import { bytesToHex, hexToBytes, encodeContact, decodeContact, randomBytes32, bytesEqual, decodePayload, fromBase64Url } from '../../../midnight/src/encoding.js';
import type { PreparedIntent } from '../../../midnight/src/adapter-contract.js';
import { api } from '../liveApi';
import { deviceKey, readSecret, writeSecret, withDeviceLock } from './device-store';
import { BrowserZkConfig, localProofProvider } from './prover';

export type Reveal = { chainRoomId: string; terms?:string|null; transcriptHash?:string|null; peerEncryptionKey?:{publicKey:string;keyVersion?:number;version?:number}|null };
type Intent = PreparedIntent & {id:string};
type Config = {network:string;contractAddress:string;eventScope:string;coinPublicKey:string;encryptionPublicKey:string;indexerUrl:string;indexerWsUrl:string};
type Stored = {privateState:ZkissPrivateState;contact?:string; proven?:Record<string,string>; approved?:Record<string,{terms:string;transcriptHash:string}>};
const base64 = (v:Uint8Array) => { let s=''; for(let i=0;i<v.length;i+=8192)s+=String.fromCharCode(...v.subarray(i,i+8192));return btoa(s); };
const unbase64 = (s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export async function createBrowserRuntime(input:{eventId:string;participantId:string;ticketLeaf?:string|null}) {
  const scope = `${input.eventId}:${input.participantId}`;
  const path = `/events/${encodeURIComponent(input.eventId)}/midnight/relay`;
  const config = await api<Config>(path);
  setNetworkId(config.network);
  const stored = await withDeviceLock(scope,async()=>{
    let value = await readSecret<Stored>(scope);
    if (!value) {
      if(input.ticketLeaf) throw Error('DEVICE_STATE_LOST');
      value={privateState:device.newParticipant()}; await writeSecret(scope,value);
    }
    if(input.ticketLeaf && bytesToHex(device.ticketLeafFor(value.privateState))!==input.ticketLeaf) throw Error('DEVICE_TICKET_MISMATCH');
    return value;
  });
  let state = stored;
  const update = async (fn:(value:Stored)=>void|Promise<void>) => withDeviceLock(scope,async()=>{
    const value=await readSecret<Stored>(scope);if(!value)throw Error('DEVICE_STATE_LOST');
    await fn(value);await writeSecret(scope,value);state=value;
  });
  const owner = await deviceKey(scope+':owner',Boolean(input.ticketLeaf));
  const ownerPub = new Uint8Array(await crypto.subtle.exportKey('raw',owner.publicKey));
  const context = {network:config.network,contractAddress:config.contractAddress,eventScope:hexToBytes(config.eventScope,32)};
  const indexerUrl=new URL(config.indexerUrl,location.origin).href;
  const indexerWsUrl=new URL(config.indexerWsUrl,location.origin.replace(/^http/,'ws')).href;
  const publicDataProvider = indexerPublicDataProvider(indexerUrl,indexerWsUrl,WebSocket as any);
  const compiledContract = CompiledContract.make('zkiss',Contract).pipe(CompiledContract.withWitnesses(witnesses as any),CompiledContract.withCompiledFileAssets('/midnight-assets'));
  const keyFor = async (roomId:string) => {
    const keyPair=await deviceKey(scope+':room:'+roomId,Boolean(state.privateState.roomSecrets[roomId]));
    return {keyPair,publicKey:new Uint8Array(await crypto.subtle.exportKey('raw',keyPair.publicKey))};
  };
  const setupFor = async (roomId:string):Promise<device.RoomSetup> => {
    const secret=state.privateState.roomSecrets[roomId];if(!secret)throw Error('ROOM_SECRET_MISSING');
    const roomKey=await keyFor(roomId);
    if(!bytesEqual(roomKey.publicKey,secret.recipientPk))throw Error('ROOM_KEY_MISMATCH');
    return {roomKey,keyCommit:pureCircuits.recipientKeyCommit(secret.recipientPk),contactCommit:pureCircuits.contactCommit(secret.contact,secret.contactSalt)};
  };
  const prepareRoom = async (roomId:string,contact:string) => {
    hexToBytes(roomId,32);
    const roomKey=await keyFor(roomId);
    await update(v=>{
      if(v.privateState.roomSecrets[roomId])return;
      v.privateState.roomSecrets[roomId]={recipientPk:roomKey.publicKey,contact:encodeContact(contact),contactSalt:randomBytes32()};
    });
    return setupFor(roomId);
  };
  const handleFor = async (intent:Intent) => {
    const zkConfigProvider = new BrowserZkConfig();
    const proofProvider = await localProofProvider(zkConfigProvider);
    const privateStateProvider:any = {
      setContractAddress:(address:string)=>{if(address!==config.contractAddress)throw Error('CONTRACT_MISMATCH');},
      get:async()=>state.privateState,
      set:async(_id:string,ps:ZkissPrivateState)=>update(v=>{v.privateState=mergePrivateState(v.privateState,ps);}),
      remove:async()=>{throw Error('DEVICE_STATE_REMOVAL_DISABLED');}, clear:async()=>{throw Error('DEVICE_STATE_REMOVAL_DISABLED');},
      ...sdkSigningStore(scope,config.contractAddress),
    };
    const providers:any = {privateStateProvider,publicDataProvider,zkConfigProvider,proofProvider,
      walletProvider:{getCoinPublicKey:()=>config.coinPublicKey,getEncryptionPublicKey:()=>config.encryptionPublicKey,
        balanceTx:async(tx:any)=>{
          const transaction=base64(tx.serialize());
          await update(v=>{v.proven??={};v.proven[intent.id]=transaction;});
          const result=await api<{transaction:string}>(path+'/balance',{method:'POST',body:{intentId:intent.id,transaction}});
          return Transaction.deserialize('signature','proof','binding',unbase64(result.transaction));
        }},
      midnightProvider:{submitTx:async(tx:any)=>{
        const result=await api<{transactionId:string}>(path+'/submit',{method:'POST',body:{intentId:intent.id,transaction:base64(tx.serialize())}});
        return result.transactionId;
      }},
    };
    return await findDeployedContract(providers,{compiledContract,contractAddress:config.contractAddress,privateStateId:scope,initialPrivateState:state.privateState}) as unknown as device.ZkissHandle;
  };
  const approvedTerms = async (r:Reveal, sealing=false) => {
    const approved=state.approved?.[r.chainRoomId];
    if(!approved || approved.transcriptHash!==r.transcriptHash || approved.terms!==r.terms)throw Error('REVEAL_NOT_APPROVED_ON_DEVICE');
    const terms=device.parseTerms(approved.terms);
    const publicState=await publicDataProvider.queryContractState(config.contractAddress);
    if(!publicState)throw Error('CHAIN_AUTHORIZATION_UNAVAILABLE');
    const chain=ledger(publicState.data),rid=hexToBytes(r.chainRoomId,32),transcript=hexToBytes(approved.transcriptHash,32);
    if(!chain.rooms.member(rid)||!chain.rooms.lookup(rid).open||chain.rooms.lookup(rid).expiresAt<=BigInt(Math.floor(Date.now()/1000)))throw Error('ROOM_CLOSED_ON_CHAIN');
    if(!chain.approvedA.member(transcript)||!chain.approvedB.member(transcript)||!bytesEqual(chain.approvedA.lookup(transcript),rid)||!bytesEqual(chain.approvedB.lookup(transcript),rid))throw Error('BILATERAL_CHAIN_APPROVAL_REQUIRED');
    if(sealing&&terms.expiresAt<=BigInt(Math.floor(Date.now()/1000)))throw Error('REVEAL_EXPIRED');
    const mine=await setupFor(r.chainRoomId);
    const isA=bytesEqual(terms.keyCommitA,mine.keyCommit);
    if(!isA&&!bytesEqual(terms.keyCommitB,mine.keyCommit))throw Error('OWN_COMMIT_MISMATCH');
    return {terms,mine,peerKey:isA?terms.keyCommitB:terms.keyCommitA,peerContact:isA?terms.contactCommitB:terms.contactCommitA};
  };
  return {
    async ticket(){return {ticketLeaf:bytesToHex(device.ticketLeafFor(state.privateState)),admissionNullifier:bytesToHex(device.admissionNullifierFor(state.privateState,context.eventScope)),devicePublicKey:base64(ownerPub),deviceKeyVersion:1};},
    async getContact(){if(!state.contact)throw Error('CONTACT_MISSING');return state.contact;},
    async saveContact(contact:string){
      // Validate and persist before issuing the public request, so retries use identical commitments.
      encodeContact(contact);
      const roomId='0'.repeat(64);
      await update(v=>{if(v.contact && v.contact!==contact)throw Error('CONTACT_ALREADY_COMMITTED');v.contact=contact;});
      const setup=await prepareRoom(roomId,contact);const secret=state.privateState.roomSecrets[roomId];
      const ownerEnvelope=await sealContact({recipientPub:ownerPub,recipientKeyCommit:pureCircuits.recipientKeyCommit(ownerPub),recipientKeyVersion:1,transcript:new Uint8Array(32),contact:secret.contact,contactSalt:secret.contactSalt,keyCommit:pureCircuits.recipientKeyCommit});
      return {commitment:bytesToHex(setup.contactCommit),ownerEnvelope};
    },
    async roomMaterial(r:Reveal){
      if(!state.contact)throw Error('CONTACT_MISSING');
      const setup=await prepareRoom(r.chainRoomId,state.contact);
      return device.roomMaterial(state.privateState,context.eventScope,hexToBytes(r.chainRoomId,32),setup);
    },
    async recoverSubmission(intent:Intent){
      const status=await api<{status:string;transactionId?:string;transaction?:string}>(path+'/intents/'+encodeURIComponent(intent.id));
      if(status.status==='submitted'&&status.transactionId)return {transactionId:status.transactionId};
      if(status.status==='absent'){
        const staged=(await readSecret<Stored>(scope))?.proven?.[intent.id];
        if(!staged)throw Object.assign(Error('SAFE_TO_REPROVE'),{safeToRetry:true});
        const balanced=await api<{transaction:string}>(path+'/balance',{method:'POST',body:{intentId:intent.id,transaction:staged}});
        return api<{transactionId:string}>(path+'/submit',{method:'POST',body:{intentId:intent.id,transaction:balanced.transaction}});
      }
      if(status.status==='balanced'&&status.transaction)return api<{transactionId:string}>(path+'/submit',{method:'POST',body:{intentId:intent.id,transaction:status.transaction}});
      return null;
    },
    async submitAdmission(intent:Intent){return device.submitAdmission(await handleFor(intent),intent,{...context,privateState:state.privateState});},
    async submitApproval(intent:Intent,r:Reveal){
      if(!r.terms||!r.transcriptHash)throw Error('REVEAL_TERMS_MISSING');
      const payload=decodePayload(fromBase64Url(intent.publicPayload));
      if(payload.kind!=='reveal_approval'||bytesToHex(payload.roomId)!==r.chainRoomId||bytesToHex(payload.transcript)!==r.transcriptHash)throw Error('REVEAL_CONTEXT_MISMATCH');
      const chain=await publicDataProvider.queryContractState(config.contractAddress);if(!chain)throw Error('CONTRACT_STATE_UNAVAILABLE');
      const handle=await handleFor(intent);
      const approve=handle.callTx.approveReveal.bind(handle.callTx);
      handle.callTx.approveReveal=async(...args)=>{
        // Called only after device.ts validates transcript + own commitments.
        // Persist consent before submission so an interrupted response can recover.
        await update(v=>{v.approved??={};v.approved[r.chainRoomId]={terms:r.terms!,transcriptHash:r.transcriptHash!};});
        return approve(...args);
      };
      return device.submitRevealApproval(handle,intent,r.terms,{...context,ledger:ledger(chain.data),mine:await setupFor(r.chainRoomId)});
    },
    async sealPeer(r:Reveal){
      const a=await approvedTerms(r,true);if(!r.peerEncryptionKey)throw Error('PEER_KEY_MISSING');
      const secret=state.privateState.roomSecrets[r.chainRoomId];
      return sealContact({recipientPub:unbase64(r.peerEncryptionKey.publicKey),recipientKeyCommit:a.peerKey,recipientKeyVersion:r.peerEncryptionKey.keyVersion??r.peerEncryptionKey.version??1,transcript:hexToBytes(r.transcriptHash!,32),contact:secret.contact,contactSalt:secret.contactSalt,keyCommit:pureCircuits.recipientKeyCommit});
    },
    async openPeer(r:Reveal,envelope:unknown){
      const a=await approvedTerms(r);
      const result=await openContact({recipientKey:a.mine.roomKey,recipientKeyCommit:a.mine.keyCommit,transcript:hexToBytes(r.transcriptHash!,32),envelope:envelope as Envelope,expectedContactCommit:a.peerContact,contactCommit:pureCircuits.contactCommit});
      if(!result.ok)throw Error(result.reasonCode);return decodeContact(result.contact);
    },
  };
}
export type BrowserRuntime = Awaited<ReturnType<typeof createBrowserRuntime>>;
