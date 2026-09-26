import { ContractState, QueryContext, CostModel } from '@midnight-ntwrk/compact-runtime';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { ledger as decode, pureCircuits } from './managed/sns/contract/index.js';
import { bytesEqual, decodePayload, fromBase64Url, hexToBytes } from '../src/encoding.js';
import type { PreparedIntent } from '../src/adapter-contract.js';

/** Only a single, already-proven SNS consent call can spend sponsor fees. */
export function validateRelay(raw: Uint8Array, prepared: PreparedIntent, state: ContractState) {
  if (prepared.protocolVersion !== 'zkiss-sns-v1' || prepared.circuit !== 'approveReveal') throw new Error('RELAY_SCOPE_INVALID');
  const payload = decodePayload(fromBase64Url(prepared.publicPayload));
  if (payload.kind !== 'reveal_approval') throw new Error('RELAY_SCOPE_INVALID');
  const tx = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>('signature', 'proof', 'pre-binding', raw);
  if (tx.rewards || tx.guaranteedOffer || tx.fallibleOffer?.size || tx.intents?.size !== 1) throw new Error('RELAY_ACTION_INVALID');
  const intent = [...tx.intents.values()][0];
  if (intent.actions.length !== 1 || intent.guaranteedUnshieldedOffer || intent.fallibleUnshieldedOffer || intent.dustActions) throw new Error('RELAY_ACTION_INVALID');
  const call = intent.actions[0];
  if (!(call instanceof ledger.ContractCall) || call.address !== prepared.contractAddress || call.entryPoint !== 'approveReveal') throw new Error('RELAY_SCOPE_INVALID');
  const before = decode(state.data);
  if (!before.rooms.member(payload.roomId)) throw new Error('ROOM_NOT_FOUND');
  const room = before.rooms.lookup(payload.roomId);
  const slot = payload.slotIndex === 0 ? room.slotA : room.slotB;
  const key = pureCircuits.consentKey(payload.bindingHash, slot);
  if (!room.open || before.consents.member(key)) throw new Error('RELAY_ALREADY_APPLIED');
  let ctx = new QueryContext(state.data, prepared.contractAddress);
  if (call.guaranteedTranscript) ctx = ctx.runTranscript(call.guaranteedTranscript, CostModel.initialCostModel());
  if (call.fallibleTranscript) ctx = ctx.runTranscript(call.fallibleTranscript, CostModel.initialCostModel());
  const after = decode(ctx.state);
  if (!after.consents.member(key)) throw new Error('RELAY_BINDING_INVALID');
  const effect = after.consents.lookup(key);
  if (!bytesEqual(effect.transcript, payload.transcript) || effect.slot !== BigInt(payload.slotIndex) || effect.expiresAt !== payload.expiresAt) throw new Error('RELAY_BINDING_INVALID');
  return tx;
}
