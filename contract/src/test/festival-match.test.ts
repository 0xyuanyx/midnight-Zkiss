// 축제 번호팅 계약 로직 검증(compact-runtime 시뮬레이터). 실제 증명·원장 검증은 범위 밖.
import { describe, it, expect, beforeEach } from "vitest";
import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { Contract, ledger, pureCircuits } from "../managed/festival-match/contract/index.js";

// 단말 비공개 상태: 티켓 비밀, DH 개인키, 인스타 원문과 커밋 난수
type PS = {
  opSk: Uint8Array;
  ticket: Uint8Array;
  dh: ReturnType<typeof generateKeyPairSync>;
  insta: string;
  instaSalt: Uint8Array;
  // 테스트용 조작: 상대 공개키 대신 임의의 비밀을 쓰는 공격자
  forgeSecret?: Uint8Array;
};

const rawPk = (u: PS) => new Uint8Array(u.dh.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const peerKeys = new Map<string, PS>(); // 공개 카드의 dhPk → 공개키 객체(데모 편의: 원장 dhPk로 복원하는 대신)

function shared(me: PS, peerPk: Uint8Array): Uint8Array {
  const peer = peerKeys.get(Buffer.from(peerPk).toString("hex"))!;
  return new Uint8Array(createHash("sha256").update(diffieHellman({ privateKey: me.dh.privateKey, publicKey: peer.dh.publicKey })).digest());
}

const witnesses = {
  operatorSecret: ({ privateState }: any) => [privateState, privateState.opSk],
  ticketSecret: ({ privateState }: any) => [privateState, privateState.ticket],
  ticketPath: ({ privateState, ledger: l }: any, leaf: Uint8Array) => [
    privateState,
    l.tickets.findPathForLeaf(leaf) ?? l.tickets.pathForLeaf(0n, leaf),
  ],
  pairSecret: ({ privateState, ledger: l }: any, peer: Uint8Array) => {
    const ps = privateState as PS;
    if (ps.forgeSecret) return [ps, ps.forgeSecret];
    return [ps, shared(ps, l.cards.lookup(peer).dhPk)];
  },
};

const T0 = 1_800_000_000;
const END = BigInt(T0 + 6 * 3600);
const pad32 = (s: string) => { const b = new Uint8Array(32); b.set(Buffer.from(s, "utf8")); return b; };

function person(insta: string): PS {
  const p: PS = { opSk: randomBytes(32), ticket: randomBytes(32), dh: generateKeyPairSync("x25519"), insta, instaSalt: randomBytes(32) };
  peerKeys.set(Buffer.from(rawPk(p)).toString("hex"), p);
  return p;
}

// 연락처 암호화: 키 = SHA256("contact-key" || s), AES-256-GCM.
// 평문 = 인스타 ID(최대 30바이트) || 커밋 난수(32바이트). 96바이트 = iv 12 + 인증태그 16 + 평문 62 + 여분
function encryptContact(s: Uint8Array, insta: string, salt: Uint8Array): Uint8Array {
  const key = createHash("sha256").update("contact-key").update(s).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.alloc(62);
  Buffer.from(insta, "utf8").copy(plain, 0, 0, 30);
  Buffer.from(salt).copy(plain, 30);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const out = new Uint8Array(96);
  out.set(iv, 0); out.set(c.getAuthTag(), 12); out.set(body, 28);
  return out;
}
function decryptContact(s: Uint8Array, ct: Uint8Array): { insta: string; salt: Uint8Array } {
  const key = createHash("sha256").update("contact-key").update(s).digest();
  const d = createDecipheriv("aes-256-gcm", key, ct.subarray(0, 12));
  d.setAuthTag(ct.subarray(12, 28));
  const plain = Buffer.concat([d.update(ct.subarray(28, 90)), d.final()]);
  return { insta: plain.subarray(0, 30).toString("utf8").replace(/\0+$/, ""), salt: new Uint8Array(plain.subarray(30, 62)) };
}

class Sim {
  contract = new Contract<PS>(witnesses as any);
  ctx: CircuitContext<PS>;
  time = T0;
  constructor(op: PS) {
    const init = this.contract.initialState(createConstructorContext(op, "0".repeat(64)), END, 3n);
    this.ctx = createCircuitContext(sampleContractAddress(), init.currentZswapLocalState, init.currentContractState, init.currentPrivateState, undefined, undefined, this.time);
  }
  get l() { return ledger(this.ctx.currentQueryContext.state); }
  call(as: PS, name: string, ...args: unknown[]) {
    const ctx = createCircuitContext(sampleContractAddress(), this.ctx.currentZswapLocalState, this.ctx.currentQueryContext.state, as, undefined, undefined, this.time);
    this.ctx = (this.contract.impureCircuits as any)[name](ctx, ...args).context;
  }
}

describe("festival-match", () => {
  let op: PS, A: PS, B: PS, C: PS, sim: Sim;
  let hA: Uint8Array, hB: Uint8Array, hC: Uint8Array;
  const keysOf = (m: Iterable<[Uint8Array, unknown]>) => new Set([...m].map(([k]) => Buffer.from(k).toString("hex")));
  const join = (u: PS) => {
    const before = keysOf(sim.l.cards);
    const card = createHash("sha256").update(`card:${u.insta}`).digest(); // 사진·성별·나이·키의 해시 자리
    sim.call(u, "joinEvent", new Uint8Array(card), pureCircuits.instaCommitment(pad32(u.insta), u.instaSalt), rawPk(u));
    const added = [...keysOf(sim.l.cards)].filter((k) => !before.has(k));
    expect(added).toHaveLength(1);
    return Buffer.from(added[0], "hex");
  };
  const tagOf = (me: PS, peer: Uint8Array) => pureCircuits.likeTag(shared(me, sim.l.cards.lookup(peer).dhPk));

  beforeEach(() => {
    op = person("operator"); A = person("alice.kim"); B = person("bob_99"); C = person("charlie");
    sim = new Sim(op);
    for (const u of [A, B, C]) sim.call(op, "issueTicket", pureCircuits.ticketLeaf(u.ticket));
    hA = join(A); hB = join(B); hC = join(C);
  });

  it("운영자 외에는 티켓을 등록할 수 없다", () => {
    expect(() => sim.call(A, "issueTicket", randomBytes(32))).toThrow(/not operator/);
  });

  it("티켓 없이 카드를 만들 수 없고, 티켓 1장으로 카드 2장을 만들 수 없다", () => {
    expect(() => sim.call(person("nobody"), "joinEvent", randomBytes(32), randomBytes(32), randomBytes(32))).toThrow(/not a ticket holder/);
    expect(() => sim.call(A, "joinEvent", randomBytes(32), randomBytes(32), randomBytes(32))).toThrow(/ticket already used/);
  });

  it("원장에는 인스타 원문이 없고 커밋만 있다", () => {
    for (const [, card] of sim.l.cards) {
      expect(Buffer.from(card.instaCommit).toString("utf8")).not.toContain("alice");
    }
  });

  it("한쪽 좋아요만으로는 매칭되지 않고, 누구를 좋아했는지 원장에 남지 않는다", () => {
    sim.call(A, "like", hB);
    expect([...sim.l.matches]).toHaveLength(0);
    const [[, liker]] = [...sim.l.pendingLikes];
    expect(Buffer.from(liker)).toEqual(Buffer.from(hA));
    // 원장의 대기 좋아요 값에는 대상(hB)이 없다
    expect([...sim.l.pendingLikes].some(([k, v]) => Buffer.from(k).equals(Buffer.from(hB)) || Buffer.from(v).equals(Buffer.from(hB)))).toBe(false);
  });

  it("서로 좋아요하면 매칭되고, 암호화된 인스타를 교환해 가입 때 커밋과 대조할 수 있다", () => {
    sim.call(A, "like", hB);
    sim.call(B, "like", hA);
    const tag = tagOf(A, hB);
    expect(sim.l.matches.member(tag)).toBe(true);

    const sA = shared(A, sim.l.cards.lookup(hB).dhPk);
    const sB = shared(B, sim.l.cards.lookup(hA).dhPk);
    sim.call(A, "revealContact", tag, encryptContact(sA, A.insta, A.instaSalt));
    sim.call(B, "revealContact", tag, encryptContact(sB, B.insta, B.instaSalt));

    // B의 단말: A가 올린 암호문을 복호화해 A의 카드 커밋과 대조
    // (A의 난수를 테스트가 직접 쓰지 않고, 암호문에서 꺼낸 값만 쓴다)
    const got = decryptContact(sB, sim.l.contacts.lookup(pureCircuits.contactKey(tag, hA)));
    expect(got.insta).toBe("alice.kim");
    expect(pureCircuits.instaCommitment(pad32(got.insta), got.salt)).toEqual(sim.l.cards.lookup(hA).instaCommit);
    // A의 카드 커밋과 다른 ID를 보내면(바꿔치기) B가 알아챈다
    const fake = decryptContact(sB, encryptContact(sA, "fake.account", A.instaSalt));
    expect(pureCircuits.instaCommitment(pad32(fake.insta), fake.salt)).not.toEqual(sim.l.cards.lookup(hA).instaCommit);
    // 제3자(C)는 공유 비밀을 계산할 수 없어 복호화에 실패한다
    const sC = shared(C, sim.l.cards.lookup(hA).dhPk);
    expect(() => decryptContact(sC, sim.l.contacts.lookup(pureCircuits.contactKey(tag, hA)))).toThrow();
  });

  it("tag를 원장에서 복사한 제3자는 공유 비밀을 몰라 매칭을 가로챌 수 없다", () => {
    sim.call(A, "like", hB);
    // C는 A를 좋아요하지만 C-A 공유 비밀은 A-B tag와 다르다
    sim.call(C, "like", hA);
    expect([...sim.l.matches]).toHaveLength(0);
    // 임의 비밀로 위조해도 A-B tag가 되지 않는다
    sim.call({ ...C, forgeSecret: randomBytes(32) }, "like", hB);
    expect([...sim.l.matches]).toHaveLength(0);
  });

  it("같은 상대를 두 번 좋아요해 혼자 매칭을 만들 수 없다", () => {
    sim.call(A, "like", hB);
    expect(() => sim.call(A, "like", hB)).toThrow(/already liked/);
  });

  it("자기 자신·없는 상대를 좋아요할 수 없다", () => {
    expect(() => sim.call(A, "like", hA)).toThrow(/self/);
    expect(() => sim.call(A, "like", randomBytes(32))).toThrow(/unknown peer/);
  });

  it("1인당 좋아요 수 제한(3회)을 넘을 수 없다", () => {
    const D = person("d"); const E = person("e");
    for (const u of [D, E]) sim.call(op, "issueTicket", pureCircuits.ticketLeaf(u.ticket));
    const hD = join(D); const hE = join(E);
    sim.call(A, "like", hB); sim.call(A, "like", hC); sim.call(A, "like", hD);
    expect(() => sim.call(A, "like", hE)).toThrow(/like limit/);
  });

  it("매칭 전·제3자·두 번째 공개는 거절된다", () => {
    const tag = tagOf(A, hB);
    expect(() => sim.call(A, "revealContact", tag, new Uint8Array(96))).toThrow(/not matched/);
    sim.call(A, "like", hB); sim.call(B, "like", hA);
    expect(() => sim.call(C, "revealContact", tag, new Uint8Array(96))).toThrow(/not a match participant/);
    sim.call(A, "revealContact", tag, new Uint8Array(96));
    expect(() => sim.call(A, "revealContact", tag, new Uint8Array(96))).toThrow(/already revealed/);
  });

  it("행사 종료 후에는 좋아요와 공개가 거절된다", () => {
    sim.call(A, "like", hB); sim.call(B, "like", hA);
    sim.time = Number(END);
    expect(() => sim.call(C, "like", hA)).toThrow(/event closed/);
    expect(() => sim.call(A, "revealContact", tagOf(A, hB), new Uint8Array(96))).toThrow(/event closed/);
  });
});
