// 사용자 단말 쪽 client. 비밀(티켓 비밀·방 키·SNS 원문·salt)은 private state에만 있고 서버로 보내지 않는다.
// 서버가 준 publicPayload는 신뢰하지 않고, 단말이 직접 원장과 대조한 뒤에만 증명 거래를 만든다.
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits, type Ledger, type RevealTerms } from '../contract/managed/zkiss/contract/index.js';
import type { ZkissPrivateState } from '../contract/witnesses.js';
import { PROTOCOL_VERSION, bytesEqual, bytesToHex, decodePayload, decodeTerms, encodeContact, fromBase64Url, randomBytes32, type RevealPayload } from './encoding.js';
import { generateRoomKey, type RoomKeyPair } from './envelope.js';
import type { PreparedIntent } from './adapter-contract.js';
import { CIRCUITS } from './adapter.js';

export class DeviceError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/** 행사마다 새 티켓 비밀. 발급자에게는 ticketLeaf만 보낸다. */
export const newParticipant = (): ZkissPrivateState => ({ ticketSecret: randomBytes32(), roomSecrets: {} });

export const ticketLeafFor = (ps: ZkissPrivateState): Uint8Array => pureCircuits.ticketLeaf(ps.ticketSecret);

export const admissionNullifierFor = (ps: ZkissPrivateState, eventScope: Uint8Array): Uint8Array => pureCircuits.nullifierOf(eventScope, ps.ticketSecret);

/** 방 슬롯 값. 단말 → 백엔드 → openRoom. 방마다 달라 공개 원장에서 참가 기록과 연결되지 않는다. */
export const slotFor = (ps: ZkissPrivateState, eventScope: Uint8Array, roomId: Uint8Array): Uint8Array =>
  pureCircuits.slotOf(eventScope, roomId, ps.ticketSecret);

export type RoomSetup = {
  roomKey: RoomKeyPair; // 개인키는 CryptoKey(추출 불가)로 단말 메모리에만 둔다
  keyCommit: Uint8Array;
  contactCommit: Uint8Array;
};

/**
 * SNS 단계 진입 시 방 전용 키·연락처 커밋을 만든다. 프로필 키를 재사용하지 않는다.
 * 반환된 두 커밋만 서버에 보내 terms를 구성한다. 원문과 salt는 private state에 남는다.
 */
export const setupRoom = async (ps: ZkissPrivateState, roomId: Uint8Array, contact: string): Promise<[ZkissPrivateState, RoomSetup]> => {
  const roomKey = await generateRoomKey();
  const contactBytes = encodeContact(contact);
  const contactSalt = randomBytes32();
  const next: ZkissPrivateState = {
    ...ps,
    roomSecrets: { ...ps.roomSecrets, [bytesToHex(roomId)]: { recipientPk: roomKey.publicKey, contact: contactBytes, contactSalt } },
  };
  return [
    next,
    {
      roomKey,
      keyCommit: pureCircuits.recipientKeyCommit(roomKey.publicKey),
      contactCommit: pureCircuits.contactCommit(contactBytes, contactSalt),
    },
  ];
};

/** 백엔드 PUT reveal-requests/{id}/room-material 본문. 비밀(티켓 비밀·방 개인키·연락처 원문·salt)은 포함하지 않는다. */
export const roomMaterial = (ps: ZkissPrivateState, eventScope: Uint8Array, roomId: Uint8Array, setup: RoomSetup) => ({
  slot: bytesToHex(slotFor(ps, eventScope, roomId)),
  roomPublicKey: btoa(String.fromCharCode(...setup.roomKey.publicKey)),
  keyCommit: bytesToHex(setup.keyCommit),
  contactCommit: bytesToHex(setup.contactCommit),
});

/** adapter.revealTerms()가 만든 terms(base64url)를 계약의 RevealTerms 값으로 해석한다. */
export const parseTerms = (terms: string): RevealTerms => decodeTerms(fromBase64Url(terms));

export const transcriptFor = (contractAddress: string, eventScope: Uint8Array, roomId: Uint8Array, room: { slotA: Uint8Array; slotB: Uint8Array }, terms: RevealTerms) =>
  pureCircuits.revealTranscript(encodeContractAddress(contractAddress), eventScope, roomId, room.slotA, room.slotB, terms);

/** findDeployedContract(...) 결과 중 이 client가 쓰는 부분 */
export type ZkissHandle = {
  callTx: {
    admit(bindingHash: Uint8Array, expiresAt: bigint): Promise<CallResult>;
    approveReveal(bindingHash: Uint8Array, expiresAt: bigint, roomId: Uint8Array, terms: RevealTerms): Promise<CallResult>;
    leaveRoom(roomId: Uint8Array): Promise<CallResult>;
  };
};
export type CallResult = { public: { txId: unknown; txHash?: unknown; blockHeight?: unknown } };
export type Submitted = { transactionId: string; txHash: string | null };

const checkIntent = (intent: PreparedIntent, expected: { network: string; contractAddress: string; circuit: string }) => {
  if (intent.protocolVersion !== PROTOCOL_VERSION) throw new DeviceError('PROTOCOL_MISMATCH', intent.protocolVersion);
  if (intent.network !== expected.network) throw new DeviceError('NETWORK_MISMATCH', intent.network);
  if (intent.contractAddress.toLowerCase() !== expected.contractAddress.toLowerCase()) throw new DeviceError('CONTRACT_MISMATCH', intent.contractAddress);
  if (intent.circuit !== expected.circuit) throw new DeviceError('CIRCUIT_MISMATCH', intent.circuit);
};

const submitted = (r: CallResult): Submitted => ({ transactionId: String(r.public.txId), txHash: r.public.txHash ? String(r.public.txHash) : null });

/** N01: 참가 증명. 백엔드는 이후 txId를 Z02로 받고 verify()로 원장 효과를 확인한다. */
export const submitAdmission = async (
  handle: ZkissHandle,
  intent: PreparedIntent,
  ctx: { network: string; contractAddress: string; eventScope: Uint8Array; privateState: ZkissPrivateState },
): Promise<Submitted> => {
  checkIntent(intent, { ...ctx, circuit: CIRCUITS.admission });
  const p = decodePayload(fromBase64Url(intent.publicPayload));
  if (p.kind !== 'admission') throw new DeviceError('PURPOSE_MISMATCH', p.kind);
  if (!bytesEqual(p.eventScope, ctx.eventScope)) throw new DeviceError('EVENT_SCOPE_MISMATCH', 'payload is for another event');
  if (!bytesEqual(p.admissionNullifier, admissionNullifierFor(ctx.privateState, ctx.eventScope))) throw new DeviceError('ADMISSION_NULLIFIER_MISMATCH', 'payload is for another ticket');
  return submitted(await handle.callTx.admit(p.bindingHash, p.expiresAt));
};

/**
 * N05: SNS 공개 동의. 서버가 준 terms로 transcript를 단말이 다시 계산하고,
 * (1) payload의 transcript와 같고 (2) 내 슬롯의 키·연락처 커밋이 내가 만든 값일 때만 승인한다.
 */
export const submitRevealApproval = async (
  handle: ZkissHandle,
  intent: PreparedIntent,
  termsWire: string | RevealTerms,
  ctx: { network: string; contractAddress: string; eventScope: Uint8Array; ledger: Ledger; mine: RoomSetup },
): Promise<Submitted> => {
  const terms = typeof termsWire === 'string' ? parseTerms(termsWire) : termsWire;
  checkIntent(intent, { ...ctx, circuit: CIRCUITS.reveal_approval });
  const p = decodePayload(fromBase64Url(intent.publicPayload));
  if (p.kind !== 'reveal_approval') throw new DeviceError('PURPOSE_MISMATCH', p.kind);
  const room = roomOrThrow(ctx.ledger, p);
  const tr = transcriptFor(ctx.contractAddress, ctx.eventScope, p.roomId, room, terms);
  if (!bytesEqual(tr, p.transcript)) throw new DeviceError('TRANSCRIPT_MISMATCH', 'terms do not match the requested transcript');
  const [myKey, myContact] = p.slotIndex === 0 ? [terms.keyCommitA, terms.contactCommitA] : [terms.keyCommitB, terms.contactCommitB];
  if (!bytesEqual(myKey, ctx.mine.keyCommit) || !bytesEqual(myContact, ctx.mine.contactCommit)) {
    throw new DeviceError('OWN_COMMIT_MISMATCH', 'server-supplied terms changed my key or contact');
  }
  return submitted(await handle.callTx.approveReveal(p.bindingHash, p.expiresAt, p.roomId, terms));
};

const roomOrThrow = (l: Ledger, p: RevealPayload) => {
  if (!l.rooms.member(p.roomId)) throw new DeviceError('ROOM_NOT_FOUND', bytesToHex(p.roomId));
  const room = l.rooms.lookup(p.roomId);
  if (!room.open) throw new DeviceError('ROOM_CLOSED', bytesToHex(p.roomId));
  return room;
};

/** N07: 방 나가기의 체인 쪽 기록. 웹의 즉시 권한 중단과 별개로 늦은 승인이 방을 다시 열지 못하게 한다. */
export const submitLeave = async (handle: ZkissHandle, roomId: Uint8Array): Promise<Submitted> => submitted(await handle.callTx.leaveRoom(roomId));
