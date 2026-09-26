// ZKiss contract logic tests on the compact-runtime simulator (no proofs, no node).
// Covers PROTOCOL.md sections 2-3. ZK soundness itself is not exercised here: the
// simulator runs the same circuit logic (asserts) that the prover constrains.
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  ledger,
  pureCircuits,
  type RevealTerms,
} from "../../sns/managed/sns/contract/index.js";
import { witnesses, toHex, type ZkissPrivateState } from "../../sns/witnesses.js";

const T0 = 1_800_000_000; // seconds
const EVENT_END = BigInt(T0 + 6 * 3600);
const SCOPE = new Uint8Array(randomBytes(32));
const rnd = () => new Uint8Array(randomBytes(32));
// The runtime encodes Bytes<N> in public transcripts with trailing 0x00 bytes trimmed
// (measured: a value ending in 00 is never found verbatim). Search for the trimmed form,
// otherwise both the leak checks (false negative) and the controls (flaky) are wrong.
const needleHex = (v: Uint8Array) => toHex(v).replace(/(00)+$/, "");
const pad64 = (s: string) => {
  const b = new Uint8Array(64);
  b.set(Buffer.from(s.normalize("NFC"), "utf8"));
  return b;
};

type User = ZkissPrivateState & {
  name: string;
  recipientPk: Uint8Array;
  contact: Uint8Array;
  contactSalt: Uint8Array;
};

function user(name: string, operatorSecret?: Uint8Array): User {
  return {
    name,
    operatorSecret,
    participantSecret: rnd(),
    roomSecrets: {},
    recipientPk: rnd(),
    contact: pad64(`@${name}.insta`),
    contactSalt: rnd(),
  };
}

class Sim {
  contract = new Contract<ZkissPrivateState>(witnesses);
  address = sampleContractAddress(); // fixed for the whole deployment
  state: CircuitContext<ZkissPrivateState>["currentQueryContext"]["state"];
  zswap: CircuitContext<ZkissPrivateState>["currentZswapLocalState"];
  time = T0;
  last?: CircuitResults<ZkissPrivateState, []>;

  constructor(op: User) {
    const init = this.contract.initialState(createConstructorContext<ZkissPrivateState>(op, "0".repeat(64)), SCOPE, EVENT_END);
    const ctx = createCircuitContext(this.address, init.currentZswapLocalState, init.currentContractState, init.currentPrivateState);
    this.state = ctx.currentQueryContext.state;
    this.zswap = ctx.currentZswapLocalState;
  }
  get l() {
    return ledger(this.state);
  }
  call(as: ZkissPrivateState, name: keyof Contract<ZkissPrivateState>["impureCircuits"], ...args: unknown[]) {
    const ctx = createCircuitContext(this.address, this.zswap, this.state, as, undefined, undefined, this.time);
    const res = (this.contract.impureCircuits[name] as any)(ctx, ...args) as CircuitResults<ZkissPrivateState, []>;
    this.state = res.context.currentQueryContext.state;
    this.zswap = res.context.currentZswapLocalState;
    this.last = res;
    return res;
  }
}

describe("zkiss contract", () => {
  let op: User, A: User, B: User, C: User, D: User, sim: Sim;
  let roomId: Uint8Array, slotA: Uint8Array, slotB: Uint8Array;
  const ROOM_END = BigInt(T0 + 3600);
  const TERMS_END = BigInt(T0 + 600);

  const slot = (u: User, rid = roomId) => pureCircuits.slotOf(SCOPE, rid, u.participantSecret);
  const withRoomSecrets = (u: User, rid = roomId) => {
    u.roomSecrets[toHex(rid)] = { recipientPk: u.recipientPk, contact: u.contact, contactSalt: u.contactSalt };
  };
  const termsFor = (a: User, b: User, over: Partial<RevealTerms> = {}): RevealTerms => ({
    requestNonce: rnd(),
    expiresAt: TERMS_END,
    keyCommitA: pureCircuits.recipientKeyCommit(a.recipientPk),
    keyCommitB: pureCircuits.recipientKeyCommit(b.recipientPk),
    contactCommitA: pureCircuits.contactCommit(a.contact, a.contactSalt),
    contactCommitB: pureCircuits.contactCommit(b.contact, b.contactSalt),
    policyVersion: 1n,
    ...over,
  });
  const transcript = (terms: RevealTerms, rid = roomId, a = slotA, b = slotB) =>
    pureCircuits.revealTranscript(encodeContractAddress(sim.address), SCOPE, rid, a, b, terms);
  const INTENT_END = BigInt(T0 + 300);
  const approve = (u: User, terms: RevealTerms, bh = rnd(), rid = roomId, exp = INTENT_END) => {
    sim.call(u, "approveReveal", bh, exp, rid, terms);
    return bh;
  };
  // approvals are split per slot (review M2); consents are keyed by (bindingHash, slot value) (review H1)
  const approval = (tr: Uint8Array) => ({
    a: sim.l.approvedA.member(tr),
    b: sim.l.approvedB.member(tr),
    roomId: sim.l.approvedA.member(tr) ? sim.l.approvedA.lookup(tr) : sim.l.approvedB.member(tr) ? sim.l.approvedB.lookup(tr) : undefined,
  });
  const consentOf = (bh: Uint8Array, slotValue: Uint8Array) => sim.l.consents.lookup(pureCircuits.consentKey(bh, slotValue));

  beforeEach(() => {
    op = user("operator", rnd());
    A = user("alice");
    B = user("bob");
    C = user("charlie"); // not in the room
    D = user("dave"); // ordinary participant, no admission
    sim = new Sim(op);
    roomId = rnd();
    slotA = slot(A);
    slotB = slot(B);
    sim.call(op, "openRoom", roomId, slotA, slotB, ROOM_END);
    for (const u of [A, B, C, D]) withRoomSecrets(u);
  });

  // ---------------------------------------------------------------- intent binding

  it("a slot owner cannot reuse its own consent bindingHash", () => {
    const bh = approve(A, termsFor(A, B));
    expect(() => approve(A, termsFor(A, B), bh)).toThrow(/bindingHash already used/);
  });

  it("the other slot owner pre-empting my bindingHash does not block or alter my consent (review H1)", () => {
    const terms = termsFor(A, B);
    const bhB = rnd(); // B's intent, visible in the mempool
    approve(A, { ...terms, requestNonce: rnd() }, bhB); // A front-runs with B's bindingHash
    approve(B, terms, bhB); // B's own approval still lands
    expect(consentOf(bhB, slotB)).toEqual({ transcript: transcript(terms), slot: 1n, expiresAt: INTENT_END });
    expect(toHex(consentOf(bhB, slotA).transcript)).not.toBe(toHex(transcript(terms)));
  });

  it("approval after the intent expiry is rejected (review L1)", () => {
    expect(() => approve(A, termsFor(A, B), rnd(), roomId, BigInt(T0))).toThrow(/intent expired/);
  });


  // ---------------------------------------------------------------- operator

  it("non-operator cannot openRoom or closeRoom", () => {
    const mallory = user("mallory", rnd()); // has *a* secret, just not the operator's
    expect(() => sim.call(mallory, "openRoom", rnd(), rnd(), rnd(), ROOM_END)).toThrow(/not operator/);
    expect(() => sim.call(mallory, "closeRoom", roomId)).toThrow(/not operator/);
    expect(sim.l.rooms.lookup(roomId).open).toBe(true);
  });

  it("openRoom with slotA == slotB is rejected", () => {
    const rid = rnd();
    const s = slot(A, rid);
    expect(() => sim.call(op, "openRoom", rid, s, s, ROOM_END)).toThrow(/slots must differ/);
  });

  // ---------------------------------------------------------------- reveal

  it("happy path: both slot owners approve the same terms -> both bits set", () => {
    const terms = termsFor(A, B);
    const bhA = approve(A, terms);
    const bhB = approve(B, terms);
    const tr = transcript(terms);
    expect(approval(tr)).toEqual({ roomId, a: true, b: true });
    expect(consentOf(bhA, slotA)).toEqual({ transcript: tr, slot: 0n, expiresAt: INTENT_END });
    expect(consentOf(bhB, slotB)).toEqual({ transcript: tr, slot: 1n, expiresAt: INTENT_END });
    expect(sim.l.rooms.lookup(roomId).open).toBe(true);
  });

  it("only A approves -> not authorized (b bit unset)", () => {
    const terms = termsFor(A, B);
    approve(A, terms);
    expect(approval(transcript(terms))).toEqual({ roomId, a: true, b: false });
  });

  it("A and B approving different terms never produce a transcript with both bits", () => {
    const tA = termsFor(A, B);
    const tB = { ...tA, requestNonce: rnd() };
    approve(A, tA);
    approve(B, tB);
    expect(sim.l.approvedA.size() + sim.l.approvedB.size()).toBe(2n);
    for (const [tr] of sim.l.approvedA) expect(sim.l.approvedB.member(tr)).toBe(false);
  });

  it("one user cannot fill both slots (slot is derived from their own secret)", () => {
    const terms = termsFor(A, B);
    approve(A, terms);
    // A tries again (new bindingHash) hoping to land in slot B; the circuit maps A to slot A.
    expect(() => approve(A, terms)).toThrow(/already approved/);
    // A with B's commit openings is still checked against slot A's commits.
    A.roomSecrets[toHex(roomId)] = B.roomSecrets[toHex(roomId)];
    expect(() => approve(A, termsFor(A, B))).toThrow(/key commit mismatch/);
    expect(approval(transcript(terms)).b).toBe(false);
  });

  it("a third party who does not own a slot cannot approve", () => {
    expect(() => approve(C, termsFor(A, B))).toThrow(/not a room member/);
  });

  it("a slot owner approves without any ticket or admission", () => {
    const rid = rnd();
    sim.call(op, "openRoom", rid, slot(A, rid), slot(D, rid), ROOM_END);
    withRoomSecrets(D, rid);
    expect(() => approve(D, termsFor(A, D), rnd(), rid)).not.toThrow();
  });

  it("wrong opening of own keyCommit is rejected", () => {
    expect(() => approve(A, termsFor(A, B, { keyCommitA: pureCircuits.recipientKeyCommit(rnd()) }))).toThrow(
      /key commit mismatch/,
    );
  });

  it("wrong opening of own contactCommit is rejected", () => {
    const forged = pureCircuits.contactCommit(pad64("@someone.else"), A.contactSalt);
    expect(() => approve(A, termsFor(A, B, { contactCommitA: forged }))).toThrow(/contact commit mismatch/);
  });

  it("the peer's commits are not checked by my approval (only my own slot)", () => {
    // B's fields are garbage; A's approval still succeeds, B's own approval will fail.
    const terms = termsFor(A, B, { keyCommitB: rnd(), contactCommitB: rnd() });
    approve(A, terms);
    expect(() => approve(B, terms)).toThrow(/key commit mismatch/);
  });

  it("duplicate approval by the same slot is rejected", () => {
    const terms = termsFor(A, B);
    approve(B, terms);
    expect(() => approve(B, terms)).toThrow(/already approved/);
  });

  it("approval after closeRoom is rejected", () => {
    sim.call(op, "closeRoom", roomId);
    expect(sim.l.rooms.lookup(roomId).open).toBe(false);
    expect(() => approve(A, termsFor(A, B))).toThrow(/room closed/);
  });

  it("approval after leaveRoom is rejected, and only slot owners can leave", () => {
    expect(() => sim.call(C, "leaveRoom", roomId)).toThrow(/not a room member/);
    const terms = termsFor(A, B);
    approve(A, terms);
    sim.call(B, "leaveRoom", roomId);
    expect(sim.l.rooms.lookup(roomId).open).toBe(false);
    expect(() => approve(B, terms)).toThrow(/room closed/);
  });

  it("approval after terms expiry is rejected", () => {
    sim.time = Number(TERMS_END);
    expect(() => approve(A, termsFor(A, B), rnd(), roomId, ROOM_END + 100n)).toThrow(/terms expired/);
  });

  it("approval after room expiry is rejected", () => {
    sim.time = Number(ROOM_END);
    expect(() => approve(A, termsFor(A, B, { expiresAt: ROOM_END + 100n }), rnd(), roomId, ROOM_END + 100n)).toThrow(/room expired/);
  });

  it("pure revealTranscript equals the transcript recorded by approveReveal", () => {
    const terms = termsFor(A, B);
    const bh = approve(A, terms);
    const recorded = consentOf(bh, slotA).transcript;
    expect(toHex(recorded)).toBe(toHex(transcript(terms)));
    expect(sim.l.approvedA.member(recorded)).toBe(true);
    // A different contract address gives a different transcript.
    const other = pureCircuits.revealTranscript(encodeContractAddress(sampleContractAddress()), SCOPE, roomId, slotA, slotB, terms);
    expect(toHex(other)).not.toBe(toHex(recorded));
  });

  it("an approval from another room cannot complete this room's mutual consent", () => {
    const otherRoom = rnd();
    const otherA = slot(A, otherRoom), otherB = slot(B, otherRoom);
    sim.call(op, "openRoom", otherRoom, otherA, otherB, ROOM_END);
    withRoomSecrets(A, otherRoom);
    withRoomSecrets(B, otherRoom);
    const terms = termsFor(A, B);
    approve(A, terms);
    approve(B, terms, rnd(), otherRoom);
    const here = transcript(terms);
    const there = transcript(terms, otherRoom, otherA, otherB);
    expect(toHex(here)).not.toBe(toHex(there));
    expect(approval(here)).toEqual({ roomId, a: true, b: false });
    expect(approval(there)).toEqual({ roomId: otherRoom, a: false, b: true });
  });

  it("exposes no admission or ticket circuits", () => {
    expect(Object.keys(sim.contract.impureCircuits).sort()).toEqual(['approveReveal', 'closeRoom', 'leaveRoom', 'openRoom']);
    expect('tickets' in sim.l).toBe(false);
    expect('admitted' in sim.l).toBe(false);
  });
});
