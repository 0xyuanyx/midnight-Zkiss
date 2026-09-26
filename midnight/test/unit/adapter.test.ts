import { pureCircuits } from '../../contract/managed/zkiss/contract/index.js';
// Adapter decision logic over a fake chain snapshot. Real chain readback is covered by test/devnet.
import { describe, expect, it } from 'vitest';
import { createMidnightAdapter, readRevealStatus, type AdapterConfig } from '../../src/adapter.js';
import type { Binding, EventChain, PrepareContext, VerificationInput } from '../../src/adapter-contract.js';
import { createHash } from 'node:crypto';
import type { ChainSnapshot, ChainView, RoomView, TxOutcome } from '../../src/chain-view.js';
import { bytesToHex, decodeTerms, encodeTerms, fromBase64Url, hexToBytes, randomBytes32, type TermsFields } from '../../src/encoding.js';

const hex = (b: Uint8Array) => bytesToHex(b);
const SCOPE = randomBytes32();
const ADDR = 'ab'.repeat(32);
const NOW = 1_800_000_000;

class FakeChain implements ChainView {
  admissions = new Map<string, bigint>();
  consents = new Map<string, { transcript: Uint8Array; slot: number; expiresAt: bigint }>(); // `${bh}:${slotValue}`
  approvals = new Map<string, { roomId: Uint8Array; a: boolean; b: boolean }>();
  rooms = new Map<string, RoomView>();
  tx: TxOutcome = 'unknown';
  down = false;
  timeSec: bigint | null = BigInt(NOW);
  async snapshot(addr: string): Promise<ChainSnapshot | null> {
    if (this.down) throw new Error('down');
    if (addr !== ADDR) return null; // only one deployed contract exists on this fake chain
    return {
      blockRef: '10:beef',
      blockTimeSec: this.timeSec,
      eventScope: SCOPE,
      admissionExpiry: (k) => this.admissions.get(hex(k)),
      consent: (k, slot) => this.consents.get(`${hex(k)}:${hex(slot)}`),
      approval: (k) => this.approvals.get(hex(k)),
      room: (k) => this.rooms.get(hex(k)),
    };
  }
  async txOutcome() {
    return this.tx;
  }
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const binding = (over: Partial<Binding> = {}): Binding => ({
  version: 'zkiss-backend-binding-v1',
  intentId: 'i1',
  purpose: 'admission',
  eventId: 'e1',
  participantId: 'p1',
  devicePublicKey: 'dpk',
  deviceKeyVersion: 1,
  revealRequestId: null,
  transcriptHash: null,
  admissionNullifier: '11'.repeat(32),
  nonce: 'n',
  expiresAt: iso(NOW + 600),
  ...over,
});

const roomId = randomBytes32();
const transcript = randomBytes32();
const EVENT: EventChain = { network: 'undeployed', contractAddress: ADDR, eventScope: hex(SCOPE) };
// Stand-in for the revealTranscript pure circuit (the real one is exercised in the contract and devnet tests).
const fakeTranscriptOf = (addr: string, scope: Uint8Array, rid: Uint8Array, a: Uint8Array, b: Uint8Array, t: TermsFields) =>
  new Uint8Array(createHash('sha256').update(addr).update(scope).update(rid).update(a).update(b).update(encodeTerms(t)).digest());
const cfg = (chain: ChainView, over: Partial<AdapterConfig> = {}): AdapterConfig => ({
  mode: 'real',
  network: 'undeployed',
  zkManifestUrl: null,
  chain,
  capabilities: { admission: true, reveal: true, anonymousReveal: false },
  transcriptOf: fakeTranscriptOf,
  ...over,
});
// backend supplies the chain room position from its DB (v2 PrepareContext)
const ctxFor = (b: Binding): PrepareContext => ({
  event: EVENT,
  reveal: b.participantId === 'p1' ? { roomId: hex(roomId), slotIndex: 0, anonymous: false } : { roomId: hex(roomId), slotIndex: 1, anonymous: true },
});

const verifyInput = async (adapter: ReturnType<typeof createMidnightAdapter>, b: Binding, bh: string, txId = 'aa'): Promise<VerificationInput> => {
  const p = await adapter.prepare(b, bh, ctxFor(b));
  return { ...p, intentId: b.intentId, purpose: b.purpose, bindingHash: bh, expiresAt: b.expiresAt, transactionId: txId };
};

describe('capabilities', () => {
  it('default to disabled and gate prepare()', async () => {
    const a = createMidnightAdapter({ ...cfg(new FakeChain()), capabilities: undefined });
    expect(a.capabilities).toEqual({ admission: false, reveal: false, anonymousReveal: false });
    await expect(a.prepare(binding(), 'aa'.repeat(32), { event: EVENT })).rejects.toThrow(/CAPABILITY_DISABLED/);
  });
  it('demo mode cannot grant permissions', () => {
    expect(() => createMidnightAdapter(cfg(new FakeChain(), { mode: 'demo' }))).toThrow(/demo mode/);
  });
  it('anonymous room reveal stays disabled unless anonymousReveal is on', async () => {
    const a = createMidnightAdapter(cfg(new FakeChain()));
    const b = binding({ purpose: 'reveal_approval', participantId: 'p2', revealRequestId: 'r', transcriptHash: hex(transcript) });
    await expect(a.prepare(b, 'aa'.repeat(32), ctxFor(b))).rejects.toThrow(/anonymousReveal/);
  });
});

describe('v2 event context', () => {
  it('prepare requires context.event and rejects another network or a non-allowlisted contract', async () => {
    const a = createMidnightAdapter(cfg(new FakeChain(), { contractAllowlist: [ADDR] }));
    await expect(a.prepare(binding(), 'aa'.repeat(32), undefined as any)).rejects.toThrow(/CONTEXT_MISSING/);
    await expect(a.prepare(binding(), 'aa'.repeat(32), { event: { ...EVENT, network: 'preprod' } })).rejects.toThrow(/NETWORK_MISMATCH/);
    await expect(a.prepare(binding(), 'aa'.repeat(32), { event: { ...EVENT, contractAddress: 'cd'.repeat(32) } })).rejects.toThrow(/CONTRACT_NOT_ALLOWED/);
    const p = await a.prepare(binding(), 'aa'.repeat(32), { event: EVENT });
    expect(p.contractAddress).toBe(ADDR);
  });
  it('an admission prepared for another event scope never verifies against this contract', async () => {
    const chain = new FakeChain();
    const a = createMidnightAdapter(cfg(chain));
    const bh = 'ce'.repeat(32);
    const p = await a.prepare(binding(), bh, { event: { ...EVENT, eventScope: hex(randomBytes32()) } });
    chain.admissions.set(hex(pureCircuits.admissionKey(hexToBytes(bh), hexToBytes(binding().admissionNullifier!))), BigInt(NOW + 600));
    const v = await a.verify({ ...p, intentId: 'i1', purpose: 'admission', bindingHash: bh, expiresAt: binding().expiresAt, transactionId: 'aa' });
    expect(v).toEqual({ status: 'failed', reasonCode: 'EVENT_SCOPE_MISMATCH' });
  });
});

describe('revealTerms / revealStatus', () => {
  const input = () => ({
    event: EVENT,
    roomId: hex(roomId),
    slots: [hex(randomBytes32()), hex(randomBytes32())] as [string, string],
    keyCommits: [hex(randomBytes32()), hex(randomBytes32())] as [string, string],
    contactCommits: [hex(randomBytes32()), hex(randomBytes32())] as [string, string],
    expiresAt: iso(NOW + 600),
    policyVersion: 3,
  });
  it('returns wire terms that decode to the inputs and a transcript computed from them', async () => {
    const a = createMidnightAdapter(cfg(new FakeChain()));
    const i = input();
    const r = await a.revealTerms(i);
    const t = decodeTerms(fromBase64Url(r.terms));
    expect(hex(t.keyCommitB)).toBe(i.keyCommits[1]);
    expect(hex(t.contactCommitA)).toBe(i.contactCommits[0]);
    expect(t.expiresAt).toBe(BigInt(NOW + 600));
    expect(t.policyVersion).toBe(3n);
    expect(r.transcriptHash).toBe(hex(fakeTranscriptOf(ADDR, SCOPE, roomId, hexToBytes(i.slots[0]), hexToBytes(i.slots[1]), t)));
    // a fresh requestNonce per call: re-requesting never reuses a transcript
    expect((await a.revealTerms(i)).transcriptHash).not.toBe(r.transcriptHash);
  });
  it('refuses equal slots and runs only with the reveal capability', async () => {
    const i = input();
    await expect(createMidnightAdapter(cfg(new FakeChain())).revealTerms({ ...i, slots: [i.slots[0], i.slots[0]] })).rejects.toThrow(/SLOTS_EQUAL/);
    await expect(createMidnightAdapter(cfg(new FakeChain(), { capabilities: { admission: true } })).revealTerms(i)).rejects.toThrow(/CAPABILITY_DISABLED/);
  });
  it('revealStatus maps chain state and hides read failures as unknown', async () => {
    const chain = new FakeChain();
    const a = createMidnightAdapter(cfg(chain));
    const tr = randomBytes32();
    chain.rooms.set(hex(roomId), { slotA: randomBytes32(), slotB: randomBytes32(), expiresAt: BigInt(NOW + 3600), open: true });
    expect(await a.revealStatus(EVENT, hex(tr))).toBe('awaiting');
    chain.approvals.set(hex(tr), { roomId, a: true, b: true });
    expect(await a.revealStatus(EVENT, hex(tr))).toBe('authorized');
    chain.down = true;
    expect(await a.revealStatus(EVENT, hex(tr))).toBe('unknown');
  });
});

describe('admission verify', () => {
  const bh = 'cd'.repeat(32);
  it('H3: another valid ticket cannot activate or preempt the victim binding', async () => {
    const chain = new FakeChain();
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, binding(), bh);
    chain.admissions.set(hex(pureCircuits.admissionKey(hexToBytes(bh), hexToBytes('22'.repeat(32)))), BigInt(NOW + 600));
    chain.tx = 'success';
    expect(await a.verify(input)).toEqual({ status: 'failed', reasonCode: 'EFFECT_NOT_FOUND' });
    chain.admissions.set(hex(pureCircuits.admissionKey(hexToBytes(bh), hexToBytes(binding().admissionNullifier!))), BigInt(NOW + 600));
    expect((await a.verify(input)).status).toBe('succeeded');
  });
  it('pending → succeeded only after the ledger effect with matching expiry exists', async () => {
    const chain = new FakeChain();
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, binding(), bh);
    expect(await a.verify(input)).toEqual({ status: 'pending' });
    chain.admissions.set(hex(pureCircuits.admissionKey(hexToBytes(bh), hexToBytes(binding().admissionNullifier!))), BigInt(NOW + 600));
    const v = await a.verify(input);
    expect(v.status).toBe('succeeded');
  });
  it('a successful tx without the effect is not success (forged / foreign tx reference)', async () => {
    const chain = new FakeChain();
    chain.tx = 'success';
    const a = createMidnightAdapter(cfg(chain));
    expect(await a.verify(await verifyInput(a, binding(), bh))).toEqual({ status: 'failed', reasonCode: 'EFFECT_NOT_FOUND' });
  });
  it('maps partial / failed tx and expiry', async () => {
    const chain = new FakeChain();
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, binding(), bh);
    chain.tx = 'partial';
    expect((await a.verify(input)).status).toBe('partial_failure');
    chain.tx = 'failure';
    expect(await a.verify(input)).toEqual({ status: 'failed', reasonCode: 'TX_FAILED' });
    chain.tx = 'unknown';
    chain.timeSec = BigInt(NOW + 601);
    expect(await a.verify(input)).toEqual({ status: 'failed', reasonCode: 'EXPIRED' });
  });
  it('indexer outage is reconciling, not failure', async () => {
    const chain = new FakeChain();
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, binding(), bh);
    chain.down = true;
    expect((await a.verify(input)).status).toBe('reconciling');
  });
  it('rejects tampered inputs', async () => {
    const chain = new FakeChain();
    chain.admissions.set(hex(pureCircuits.admissionKey(hexToBytes(bh), hexToBytes(binding().admissionNullifier!))), BigInt(NOW + 600));
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, binding(), bh);
    expect((await a.verify({ ...input, bindingHash: 'ef'.repeat(32) })).status).toBe('failed');
    expect((await a.verify({ ...input, network: 'mainnet' })).status).toBe('failed');
    expect((await a.verify({ ...input, contractAddress: 'cd'.repeat(32) })).status).not.toBe('succeeded');
    expect((await a.verify({ ...input, expiresAt: iso(NOW + 9999) })).status).toBe('failed');
    expect((await a.verify({ ...input, purpose: 'reveal_approval' })).status).toBe('failed');
    chain.admissions.set(hex(pureCircuits.admissionKey(hexToBytes(bh), hexToBytes(binding().admissionNullifier!))), BigInt(NOW + 1)); // same hash, different expiry on chain
    expect(await a.verify(input)).toEqual({ status: 'failed', reasonCode: 'BINDING_MISMATCH' });
  });
});

describe('reveal verify', () => {
  const bh = '12'.repeat(32);
  const rb = binding({ purpose: 'reveal_approval', revealRequestId: 'r', transcriptHash: hex(transcript) });
  const slotA = randomBytes32();
  const slotB = randomBytes32();
  const EXP = BigInt(NOW + 600); // binding expiresAt in seconds
  const openRoom = (chain: FakeChain, open = true) => chain.rooms.set(hex(roomId), { slotA, slotB, expiresAt: BigInt(NOW + 3600), open });
  // 계약과 같이 consent는 (bindingHash, 호출자 슬롯 값)으로 저장된다
  const setConsent = (chain: FakeChain, slotIndex: 0 | 1, c: { transcript: Uint8Array; slot: number; expiresAt?: bigint }) =>
    chain.consents.set(`${bh}:${hex(slotIndex === 0 ? slotA : slotB)}`, { expiresAt: EXP, ...c });

  it('succeeds for this party once its consent is recorded on an open room', async () => {
    const chain = new FakeChain();
    openRoom(chain);
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, rb, bh);
    expect((await a.verify(input)).status).toBe('pending');
    setConsent(chain, 0, { transcript, slot: 0 });
    chain.approvals.set(hex(transcript), { roomId, a: true, b: false });
    expect((await a.verify(input)).status).toBe('succeeded');
    expect(await readRevealStatus(chain, ADDR, hex(transcript))).toEqual({ state: 'awaiting', approvedSlots: [0] });
    chain.approvals.set(hex(transcript), { roomId, a: true, b: true });
    expect(await readRevealStatus(chain, ADDR, hex(transcript))).toEqual({ state: 'authorized' });
  });
  it('a consent written under the OTHER slot for my bindingHash is ignored (pre-emption, review H1)', async () => {
    const chain = new FakeChain();
    openRoom(chain);
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, rb, bh);
    setConsent(chain, 1, { transcript: randomBytes32(), slot: 1 }); // B wrote with A's bindingHash
    expect(await a.verify(input)).toEqual({ status: 'pending' });
    setConsent(chain, 0, { transcript, slot: 0 });
    chain.approvals.set(hex(transcript), { roomId, a: true, b: false });
    expect((await a.verify(input)).status).toBe('succeeded');
  });
  it('my consent over another transcript or intent expiry is a mismatch', async () => {
    const chain = new FakeChain();
    openRoom(chain);
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, rb, bh);
    setConsent(chain, 0, { transcript: randomBytes32(), slot: 0 });
    expect(await a.verify(input)).toEqual({ status: 'failed', reasonCode: 'BINDING_MISMATCH' });
    setConsent(chain, 0, { transcript, slot: 0, expiresAt: EXP + 1n });
    chain.approvals.set(hex(transcript), { roomId, a: true, b: false });
    expect(await a.verify(input)).toEqual({ status: 'failed', reasonCode: 'BINDING_MISMATCH' });
  });
  it('a tx that lands between the state read and the tx lookup is re-read, not failed (review M3)', async () => {
    const chain = new FakeChain();
    openRoom(chain);
    const a = createMidnightAdapter(cfg(chain));
    const input = await verifyInput(a, rb, bh);
    chain.txOutcome = async () => {
      setConsent(chain, 0, { transcript, slot: 0 });
      chain.approvals.set(hex(transcript), { roomId, a: true, b: false });
      return 'success';
    };
    expect((await a.verify(input)).status).toBe('succeeded');
  });
  it('without chain time an absent effect is reconciling, not expired (review L3)', async () => {
    const chain = new FakeChain();
    openRoom(chain);
    chain.timeSec = null;
    const a = createMidnightAdapter(cfg(chain));
    expect(await a.verify(await verifyInput(a, rb, bh))).toEqual({ status: 'reconciling', reasonCode: 'CHAIN_TIME_UNAVAILABLE' });
  });
  it('a closed room wins over recorded approvals', async () => {
    const chain = new FakeChain();
    openRoom(chain, false);
    setConsent(chain, 0, { transcript, slot: 0 });
    chain.approvals.set(hex(transcript), { roomId, a: true, b: true });
    const a = createMidnightAdapter(cfg(chain));
    expect(await a.verify(await verifyInput(a, rb, bh))).toEqual({ status: 'failed', reasonCode: 'ROOM_CLOSED' });
    expect(await readRevealStatus(chain, ADDR, hex(transcript))).toEqual({ state: 'closed' });
  });
  it('prepare requires the transcript hash in 32-byte hex', async () => {
    const a = createMidnightAdapter(cfg(new FakeChain()));
    await expect(a.prepare({ ...rb, transcriptHash: 'zz' }, bh, ctxFor(rb))).rejects.toThrow();
    expect(hexToBytes(hex(transcript), 32)).toEqual(transcript);
  });
});
