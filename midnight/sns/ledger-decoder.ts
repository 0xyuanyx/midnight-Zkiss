// 인덱서가 준 contract state(hex)를 컴파일된 계약의 ledger()로 해석한다. 백엔드 read adapter 전용.
import { ContractState, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { ledger, pureCircuits } from './managed/sns/contract/index.js';
import { hexToBytes, type TermsFields } from '../src/encoding.js';
import { indexerChainView, type ZkissLedgerLike } from '../src/chain-view.js';

export const decodeZkissState = (stateHex: string): ZkissLedgerLike =>
  ledger(ContractState.deserialize(hexToBytes(stateHex)).data) as unknown as ZkissLedgerLike;

export const zkissConsentKey = (bindingHash: Uint8Array, slotValue: Uint8Array): Uint8Array => pureCircuits.consentKey(bindingHash, slotValue);

/** 백엔드용 인덱서 read view. indexerUrl은 운영자가 신뢰하는(가능하면 자체 운영) 인덱서여야 한다. */
export const zkissIndexerView = (indexerUrl: string) => indexerChainView({ indexerUrl, decode: decodeZkissState, consentKey: zkissConsentKey });

/** revealTranscript pure circuit; must equal what approveReveal computes with kernel.self(). */
export const zkissTranscriptOf = (
  contractAddress: string,
  eventScope: Uint8Array,
  roomId: Uint8Array,
  slotA: Uint8Array,
  slotB: Uint8Array,
  terms: TermsFields,
): Uint8Array => pureCircuits.revealTranscript(encodeContractAddress(contractAddress), eventScope, roomId, slotA, slotB, terms);
