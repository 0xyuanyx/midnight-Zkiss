// MidnightAdapter implementation for the backend (docs/MIDNIGHT_ADAPTER_CONTRACT.ts).
// Success is decided ONLY from contract ledger effects read back from the chain, never from a tx id or a client claim.
import type {
  Binding,
  EventChain,
  MidnightAdapter,
  PrepareContext,
  PreparedIntent,
  RevealChainStatus,
  RevealTermsInput,
  RevealTermsResult,
  Verification,
  VerificationInput,
} from './adapter-contract.js';
import {
  PROTOCOL_VERSION,
  EncodingError,
  bytesEqual,
  bytesToHex,
  decodePayload,
  encodePayload,
  fromBase64Url,
  hexToBytes,
  isoToSeconds,
  parseBindingHash,
  randomBytes32,
  toBase64Url,
  encodeTerms,
  type TermsFields,
} from './encoding.js';
import type { ChainSnapshot, ChainView, TxOutcome } from './chain-view.js';

export const CIRCUITS = { admission: 'admit', reveal_approval: 'approveReveal' } as const;

export type AdapterConfig = {
  mode: 'real' | 'demo';
  protocolVersion?: string;
  network: string;
  zkManifestUrl: string | null;
  /**
   * Capabilities default to false. Turn one on only after the matching Devnet/network run in
   * MIDNIGHT_IMPLEMENTATION_STATUS.md passed with real proofs and indexer readback.
   */
  capabilities?: Partial<MidnightAdapter['capabilities']>;
  chain: ChainView;
  /** revealTranscript pure circuit with the contract address already encoded (see ledger-decoder.ts). */
  transcriptOf: (contractAddress: string, eventScope: Uint8Array, roomId: Uint8Array, slotA: Uint8Array, slotB: Uint8Array, terms: TermsFields) => Uint8Array;
  /** Optional: only these event contracts (lowercase hex) are accepted. */
  contractAllowlist?: string[];
};

export class AdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export const createMidnightAdapter = (cfg: AdapterConfig): MidnightAdapter => {
  const capabilities = {
    admission: cfg.capabilities?.admission ?? false,
    reveal: cfg.capabilities?.reveal ?? false,
    anonymousReveal: cfg.capabilities?.anonymousReveal ?? false,
  };
  if (capabilities.anonymousReveal && !capabilities.reveal) throw new AdapterError('CONFIG', 'anonymousReveal requires reveal');
  if (cfg.mode === 'demo' && (capabilities.admission || capabilities.reveal)) {
    // A demo adapter must never grant real permissions.
    throw new AdapterError('CONFIG', 'demo mode cannot enable capabilities');
  }
  const allow = cfg.contractAllowlist?.map((a) => a.toLowerCase());

  /** Validates an event's chain coordinates; returns normalized address and scope bytes. */
  const eventOf = (e: EventChain) => {
    if (e.network !== cfg.network) throw new AdapterError('NETWORK_MISMATCH', e.network);
    const contractAddress = e.contractAddress.toLowerCase();
    if (!/^[0-9a-f]+$/.test(contractAddress)) throw new AdapterError('CONTRACT_FORMAT', e.contractAddress);
    if (allow && !allow.includes(contractAddress)) throw new AdapterError('CONTRACT_NOT_ALLOWED', contractAddress);
    return { contractAddress, eventScope: hexToBytes(e.eventScope, 32) };
  };

  const base = (contractAddress: string, circuit: string, payload: Uint8Array): PreparedIntent => ({
    protocolVersion: cfg.protocolVersion ?? PROTOCOL_VERSION,
    network: cfg.network,
    contractAddress,
    circuit,
    publicPayload: toBase64Url(payload),
    zkManifestUrl: cfg.zkManifestUrl,
  });

  const prepare = async (binding: Binding, bindingHash: string, context: PrepareContext): Promise<PreparedIntent> => {
    if (binding.version !== 'zkiss-backend-binding-v1') throw new AdapterError('BINDING_VERSION', binding.version);
    if (!context?.event) throw new AdapterError('CONTEXT_MISSING', 'context.event is required');
    const { contractAddress, eventScope } = eventOf(context.event);
    const bh = parseBindingHash(bindingHash);
    const expiresAt = isoToSeconds(binding.expiresAt);

    if (binding.purpose === 'admission') {
      if (!capabilities.admission) throw new AdapterError('CAPABILITY_DISABLED', 'admission');
      return base(contractAddress, CIRCUITS.admission, encodePayload({ kind: 'admission', bindingHash: bh, expiresAt, eventScope }));
    }

    if (binding.purpose === 'reveal_approval') {
      if (!capabilities.reveal) throw new AdapterError('CAPABILITY_DISABLED', 'reveal');
      if (!binding.revealRequestId || !binding.transcriptHash) throw new AdapterError('BINDING_FIELDS', 'revealRequestId and transcriptHash required');
      const ctx = context.reveal;
      if (!ctx) throw new AdapterError('REVEAL_CONTEXT_MISSING', binding.revealRequestId);
      if (ctx.slotIndex !== 0 && ctx.slotIndex !== 1) throw new AdapterError('SLOT_RANGE', String(ctx.slotIndex));
      if (ctx.anonymous && !capabilities.anonymousReveal) throw new AdapterError('CAPABILITY_DISABLED', 'anonymousReveal');
      // transcriptHash must be the value revealTerms() returned (in-circuit revealTranscript), hex.
      return base(
        contractAddress,
        CIRCUITS.reveal_approval,
        encodePayload({
          kind: 'reveal_approval',
          bindingHash: bh,
          expiresAt,
          roomId: hexToBytes(ctx.roomId, 32),
          slotIndex: ctx.slotIndex,
          transcript: hexToBytes(binding.transcriptHash, 32),
        }),
      );
    }
    throw new AdapterError('PURPOSE', String((binding as Binding).purpose));
  };

  const revealTerms = async (i: RevealTermsInput): Promise<RevealTermsResult> => {
    if (!capabilities.reveal) throw new AdapterError('CAPABILITY_DISABLED', 'reveal');
    const { contractAddress, eventScope } = eventOf(i.event);
    if (!Number.isInteger(i.policyVersion) || i.policyVersion < 0) throw new AdapterError('POLICY_VERSION', String(i.policyVersion));
    const [slotA, slotB] = i.slots.map((x: string) => hexToBytes(x, 32));
    if (bytesEqual(slotA, slotB)) throw new AdapterError('SLOTS_EQUAL', 'slots must differ');
    const terms: TermsFields = {
      requestNonce: randomBytes32(), // new nonce per request: a re-request never reuses a transcript
      expiresAt: isoToSeconds(i.expiresAt),
      keyCommitA: hexToBytes(i.keyCommits[0], 32),
      keyCommitB: hexToBytes(i.keyCommits[1], 32),
      contactCommitA: hexToBytes(i.contactCommits[0], 32),
      contactCommitB: hexToBytes(i.contactCommits[1], 32),
      policyVersion: BigInt(i.policyVersion),
    };
    const transcript = cfg.transcriptOf(contractAddress, eventScope, hexToBytes(i.roomId, 32), slotA, slotB, terms);
    return { transcriptHash: bytesToHex(transcript), terms: toBase64Url(encodeTerms(terms)) };
  };

  const revealStatus = async (event: EventChain, transcriptHash: string): Promise<RevealChainStatus> => {
    const { contractAddress } = eventOf(event);
    try {
      const s = await readRevealStatus(cfg.chain, contractAddress, transcriptHash);
      return s.state;
    } catch {
      return 'unknown';
    }
  };

  const verify = async (input: VerificationInput): Promise<Verification> => {
    // 1. Context: a proof for another protocol/network/contract never counts.
    if (input.protocolVersion !== (cfg.protocolVersion ?? PROTOCOL_VERSION)) return failed('PROTOCOL_MISMATCH');
    if (input.network !== cfg.network) return failed('NETWORK_MISMATCH');
    const contractAddress = input.contractAddress.toLowerCase();
    if (!/^[0-9a-f]+$/.test(contractAddress)) return failed('CONTRACT_MISMATCH');
    if (allow && !allow.includes(contractAddress)) return failed('CONTRACT_NOT_ALLOWED');
    if (input.circuit !== CIRCUITS[input.purpose]) return failed('CIRCUIT_MISMATCH');

    // 2. The payload must be the one prepare() produced for exactly this binding.
    let payload;
    let bh: Uint8Array;
    let expiresAt: bigint;
    try {
      payload = decodePayload(fromBase64Url(input.publicPayload));
      bh = parseBindingHash(input.bindingHash);
      expiresAt = isoToSeconds(input.expiresAt);
    } catch (e) {
      return failed(e instanceof EncodingError ? e.code : 'PAYLOAD_INVALID');
    }
    if (payload.kind !== input.purpose) return failed('PURPOSE_MISMATCH');
    if (!bytesEqual(payload.bindingHash, bh)) return failed('BINDING_MISMATCH');
    if (payload.expiresAt !== expiresAt) return failed('EXPIRY_MISMATCH');

    // 3. Trusted chain readback. Returns null when this binding's effect is not (yet) on chain.
    type Eval = { v: Verification } | { missing: true; nowSec: bigint | null };
    const evaluate = (snap: ChainSnapshot): Eval => {
      const ok = (): Eval => ({
        v: {
          status: 'succeeded',
          bindingHash: input.bindingHash,
          network: cfg.network,
          contractAddress,
          purpose: input.purpose,
          evidenceRef: `${cfg.network}:${contractAddress}:${snap.blockRef}:${input.purpose}:${input.bindingHash}`,
        },
      });
      const missing: Eval = { missing: true, nowSec: snap.blockTimeSec };

      if (payload.kind === 'admission') {
        // The payload's scope must be this contract's scope (the reveal transcript already binds the contract address).
        if (!bytesEqual(payload.eventScope, snap.eventScope)) return { v: failed('EVENT_SCOPE_MISMATCH') };
        const recorded = snap.admissionExpiry(bh);
        if (recorded === undefined) return missing;
        if (recorded !== payload.expiresAt) return { v: failed('BINDING_MISMATCH') };
        return ok();
      }

      const room = snap.room(payload.roomId);
      if (!room) return missing; // room not registered yet (or wrong id): never success
      // consents are keyed by (bindingHash, slot value), so only the owner of the expected slot can have written this.
      const consent = snap.consent(bh, payload.slotIndex === 0 ? room.slotA : room.slotB);
      if (!consent) return room.open ? missing : { v: failed('ROOM_CLOSED') };
      if (!bytesEqual(consent.transcript, payload.transcript) || consent.slot !== payload.slotIndex || consent.expiresAt !== payload.expiresAt) {
        return { v: failed('BINDING_MISMATCH') };
      }
      const approval = snap.approval(payload.transcript);
      if (!approval || !bytesEqual(approval.roomId, payload.roomId)) return { v: failed('BINDING_MISMATCH') };
      if (!room.open) return { v: failed('ROOM_CLOSED') }; // closing wins over any approval, earlier or later
      return ok();
    };

    const read = async (): Promise<ChainSnapshot | Verification> => {
      try {
        const snap = await cfg.chain.snapshot(contractAddress);
        return snap ?? { status: 'reconciling', reasonCode: 'CONTRACT_STATE_UNAVAILABLE' };
      } catch {
        return { status: 'reconciling', reasonCode: 'CHAIN_READ_FAILED' };
      }
    };
    const isSnap = (x: ChainSnapshot | Verification): x is ChainSnapshot => 'blockRef' in x;

    const first = await read();
    if (!isSnap(first)) return first;
    const r1 = evaluate(first);
    if ('v' in r1) return r1.v;

    // Effect absent. The tx id is client-supplied and untrusted: it only refines the reason, never grants success.
    let tx: TxOutcome;
    try {
      tx = await cfg.chain.txOutcome(input.transactionId);
    } catch {
      return { status: 'reconciling', reasonCode: 'TX_LOOKUP_FAILED' };
    }
    if (tx === 'failure') return failed('TX_FAILED');
    if (tx === 'partial') return { status: 'partial_failure', reasonCode: 'TX_PARTIAL' };
    if (tx === 'success') {
      // The tx may have landed between the two reads (security review M3): read the state once more.
      const second = await read();
      if (!isSnap(second)) return second;
      const r2 = evaluate(second);
      return 'v' in r2 ? r2.v : failed('EFFECT_NOT_FOUND'); // a landed tx that did not create this binding's effect
    }
    // Without chain time we cannot tell pending from expired (security review L3).
    if (r1.nowSec === null) return { status: 'reconciling', reasonCode: 'CHAIN_TIME_UNAVAILABLE' };
    return r1.nowSec < expiresAt ? { status: 'pending' } : failed('EXPIRED');
  };

  return { mode: cfg.mode, capabilities, prepare, verify, revealTerms, revealStatus };
};

const failed = (reasonCode: string): Verification => ({ status: 'failed', reasonCode });

export type RevealStatus =
  | { state: 'awaiting'; approvedSlots: (0 | 1)[] }
  | { state: 'authorized' }
  | { state: 'closed' }
  | { state: 'unknown' };

/**
 * Whole-request status for the backend worker: authorized only when both slots approved the SAME transcript
 * and the room is still open. Per-intent verify() reports one party's consent.
 */
export const readRevealStatus = async (chain: ChainView, contractAddress: string, transcriptHex: string): Promise<RevealStatus> => {
  const snap = await chain.snapshot(contractAddress.toLowerCase());
  if (!snap) return { state: 'unknown' };
  const approval = snap.approval(hexToBytes(transcriptHex, 32));
  if (!approval) return { state: 'awaiting', approvedSlots: [] };
  const room = snap.room(approval.roomId);
  if (!room || !room.open) return { state: 'closed' };
  if (approval.a && approval.b) return { state: 'authorized' };
  return { state: 'awaiting', approvedSlots: [...(approval.a ? [0 as const] : []), ...(approval.b ? [1 as const] : [])] };
};

export { bytesToHex };
