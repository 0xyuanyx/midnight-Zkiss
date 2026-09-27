import { readDevice, writeDevice, participantSecret } from './device-store';
import { ledger } from '../../../midnight/sns/managed/sns/contract/index.js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits } from '../../../midnight/sns/managed/sns/contract/index.js';
import { newParticipant, slotFor, setupRoom, roomMaterial, parseTerms, submitRevealApproval, type RoomSetup } from '../../../midnight/sns/device';
import { sealContact, openContact, type Envelope } from '../../../midnight/src/envelope';
import { hexToBytes, decodeContact } from '../../../midnight/src/encoding';
import type { ZkissPrivateState } from '../../../midnight/sns/witnesses';
import { Api, ApiError, pause, type Reveal, type Room } from '../state/api';
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
interface Local { privateState: ZkissPrivateState; setup: RoomSetup; intent?: any; transaction?: string; submitted?: boolean }
const read = (key: string) => readDevice<Local>(key);
const write = writeDevice;
const localKey = (uid: string, r: Reveal) => `${uid}:${r.id}`;
async function local(uid: string, r: Reveal) { const v = await read(localKey(uid, r)); if (!v) throw new ApiError('KEYS_MISSING'); return v; }
export async function material(uid: string, r: Reveal, sns: string) {
  const key = localKey(uid, r); let value = await read(key);
  if (!value) {
    const participant = newParticipant();
    participant.participantSecret = await participantSecret(uid);
    const [privateState, setup] = await setupRoom(participant, hexToBytes(r.chainRoomId, 32), sns);
    value = { privateState, setup }; await write(key, value);
    value = (await read(key))!;
  }
  return roomMaterial(value.privateState, hexToBytes(r.eventScope!, 32), hexToBytes(r.chainRoomId, 32), value.setup);
}
export async function prepareRoom(api: Api, uid: string, room: Room) {
  const c=room.chainPreparation;if(!c)return;
  const state=newParticipant();state.participantSecret=await participantSecret(uid);
  const slot=Array.from(slotFor(state,hexToBytes(c.eventScope,32),hexToBytes(c.roomId,32)),b=>b.toString(16).padStart(2,'0')).join('');
  if(c.mySlot && c.mySlot!==slot) throw new ApiError('SLOT_CHANGED');
  if(!c.mySlot || c.status==='waiting') await api.event(`/conversations/${room.id}/chain-slot`,'PUT',{slot});
}
export { warmProof } from './proof-runtime';
import { prove } from './proof-runtime';
export async function approve(api: Api, uid: string, r: Reveal) {
  const value = await local(uid, r); const key = localKey(uid, r);

  if (!value.intent) { value.intent = await api.event('/chain-intents', 'POST', { purpose: 'reveal_approval', revealRequestId: r.id, transcriptHash: r.transcriptHash }); await write(key, value); }
  if (!value.transaction) {
    const context = await api.event<{ contractState: string }>('/midnight/proof-context');
    await submitRevealApproval({ callTx: { approveReveal: async () => ({ public: { txId: 'validated-locally' } }), leaveRoom: async () => { throw new Error('UNSUPPORTED'); } } }, value.intent, r.terms!, {
      network: r.network!, contractAddress: r.contractAddress!, eventScope: hexToBytes(r.eventScope!, 32), ledger: ledger(ContractState.deserialize(unb64(context.contractState)).data), mine: value.setup,
    });
    value.transaction = await prove({ intent: value.intent, context, network: r.network, contractAddress: r.contractAddress, terms: r.terms, privateState: value.privateState });
    await write(key, value);
  }
  if (!value.submitted) {
    await api.event(`/chain-intents/${value.intent.id}/relay`, 'POST', { transaction: value.transaction });
    value.submitted = true; await write(key, value);
  }
  for (let attempt = 0; attempt < 240; attempt++) {
    const operation = await api.event<{ status: string; effectApplied: boolean }>(`/operations/${value.intent.operationId}`);
    if (operation.status === 'succeeded' && operation.effectApplied) return;
    if (['failed', 'expired', 'partial_failure'].includes(operation.status)) throw new ApiError('SNS_APPROVAL_FAILED');
    await pause(2500);
  }
  throw new ApiError('PROOF_TIMEOUT');
}
export async function envelope(uid: string, r: Reveal) {
  const value = await local(uid, r); const terms = parseTerms(r.terms!);
  const sec = value.privateState.roomSecrets[r.chainRoomId];
  return sealContact({ recipientPub: unb64(r.peerEncryptionKey!.publicKey), recipientKeyCommit: r.mySlotIndex === 0 ? terms.keyCommitB : terms.keyCommitA,
    recipientKeyVersion: r.peerEncryptionKey!.version, transcript: hexToBytes(r.transcriptHash!, 32), contact: sec.contact, contactSalt: sec.contactSalt, keyCommit: pureCircuits.recipientKeyCommit });
}
export async function open(uid: string, r: Reveal, envelope: Envelope) {
  const value = await local(uid, r); const terms = parseTerms(r.terms!);
  const result = await openContact({ recipientKey: value.setup.roomKey, recipientKeyCommit: value.setup.keyCommit, transcript: hexToBytes(r.transcriptHash!, 32), envelope,
    expectedContactCommit: r.mySlotIndex === 0 ? terms.contactCommitB : terms.contactCommitA, contactCommit: pureCircuits.contactCommit });
  if (!result.ok) throw new ApiError(result.reasonCode);
  return decodeContact(result.contact);
}
