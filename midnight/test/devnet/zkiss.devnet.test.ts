// ZKiss Local Devnet E2E (연동 v2): 백엔드가 호출할 순서 그대로
// 운영자 모듈(배포·티켓·방 등록·종료) + 어댑터 v2(prepare/verify/revealTerms/revealStatus) + 단말 client + HPKE 봉투.
// 실제 ZK 증명(증명 서버) + 노드 거래 + 인덱서 readback. 수수료는 테스트 지갑(genesis)이 모두 낸다.
// 한 Node 프로세스에서 참가자별 private state를 나눠 실행한다(두 휴대폰 브라우저 검증이 아니다).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { ledger, pureCircuits } from '../../contract/managed/zkiss/contract/index.js';
import type { ZkissPrivateState } from '../../contract/witnesses.js';
import { buildWallet, configureProviders, localConfig, type WalletContext } from '../../src/node/wallet.js';
import { createOperatorRuntime, compiledZkiss, ZK_PATH } from '../../src/node/operator.js';
import { createMidnightAdapter } from '../../src/adapter.js';
import type { Binding, EventChain, MidnightAdapter, Verification, VerificationInput } from '../../src/adapter-contract.js';
import { zkissIndexerView, zkissTranscriptOf } from '../../src/ledger-decoder.js';
import { bytesToHex, decodeContact, hexToBytes, randomBytes32 } from '../../src/encoding.js';
import { openContact, sealContact } from '../../src/envelope.js';
import {
  newParticipant,
  parseTerms,
  roomMaterial,
  setupRoom,
  submitAdmission,
  submitRevealApproval,
  ticketLeafFor,
  transcriptFor,
  type RoomSetup,
  type ZkissHandle,
} from '../../src/device.js';

const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const NETWORK = 'undeployed';

type LogRow = { step: string; ms: number; txId?: string; error?: string; verify?: string };
const log: LogRow[] = [];
const hex = bytesToHex;

async function tx<T extends { public: { txId: unknown } } | { transactionId: string }>(step: string, f: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await f();
  const txId = 'transactionId' in r ? r.transactionId : String(r.public.txId);
  log.push({ step, ms: Date.now() - t, txId });
  return r;
}

async function rejected(step: string, f: () => Promise<unknown>, expected: RegExp) {
  const t = Date.now();
  let err: unknown;
  try {
    await f();
  } catch (e) {
    err = e;
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.push({ step, ms: Date.now() - t, error: err === undefined ? 'NOT REJECTED' : msg.slice(0, 160) });
  expect(err, `${step} must be rejected`).toBeDefined();
  expect(msg).toMatch(expected);
}

// 백엔드 canonical(키 정렬 JSON) + SHA-256과 같은 성질의 불투명 hex. 어댑터는 재계산하지 않는다.
const canonical = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
const bindingHashOf = (b: Binding) => createHash('sha256').update(canonical(b)).digest('hex');

describe('zkiss v2 integration on Local Devnet (proof server)', () => {
  let walletCtx: WalletContext;
  let providers: Awaited<ReturnType<typeof configureProviders>>;
  let event: EventChain;
  let adapter: MidnightAdapter;
  let rt: ReturnType<typeof createOperatorRuntime>;
  const chain = zkissIndexerView(localConfig.indexer);

  const handle = (id: string, ps: ZkissPrivateState): Promise<any> =>
    findDeployedContract(providers as any, { contractAddress: event.contractAddress, compiledContract: compiledZkiss, privateStateId: id, initialPrivateState: ps } as any);
  const state = async () => ledger((await providers.publicDataProvider.queryContractState(event.contractAddress))!.data);
  const scope = () => hexToBytes(event.eventScope, 32);

  const makeBinding = (participantId: string, purpose: Binding['purpose'], extra: Partial<Binding> = {}): Binding => ({
    version: 'zkiss-backend-binding-v1',
    intentId: `intent-${participantId}-${purpose}-${Math.random().toString(36).slice(2)}`,
    purpose,
    eventId: 'event-1',
    participantId,
    devicePublicKey: Buffer.from(randomBytes32()).toString('base64'),
    deviceKeyVersion: 1,
    revealRequestId: null,
    transcriptHash: null,
    nonce: Buffer.from(randomBytes32()).toString('base64url'),
    expiresAt: new Date((Math.floor(Date.now() / 1000) + 10 * 60) * 1000).toISOString(),
    ...extra,
  });

  const verifyUntilSettled = async (input: VerificationInput, step: string, a: MidnightAdapter = adapter): Promise<Verification> => {
    for (let i = 0; i < 30; i++) {
      const v = await a.verify(input);
      if (v.status !== 'pending' && v.status !== 'reconciling') {
        log.push({ step, ms: 0, verify: `${v.status}${'reasonCode' in v && v.reasonCode ? `:${v.reasonCode}` : ''}` });
        return v;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${step}: verify did not settle`);
  };

  // 백엔드 Z01(admission) → 단말 증명·제출 → Z02 txId → worker verify 입력(저장된 prepare 결과로 구성)
  const admitVia = async (who: string, h: ZkissHandle) => {
    const b = makeBinding(who, 'admission');
    const bh = bindingHashOf(b);
    const intent = await adapter.prepare(b, bh, { event });
    const sub = await tx(`${who} admit`, () => submitAdmission(h, intent, { network: NETWORK, contractAddress: event.contractAddress, eventScope: scope() }));
    const input: VerificationInput = { ...intent, intentId: b.intentId, purpose: 'admission', bindingHash: bh, expiresAt: b.expiresAt, transactionId: sub.transactionId };
    return { b, bh, intent, sub, input };
  };

  beforeAll(async () => {
    setNetworkId(NETWORK);
    walletCtx = await buildWallet(localConfig, GENESIS_SEED);
    providers = await configureProviders(walletCtx, localConfig, ZK_PATH, `zkiss-devnet-${Date.now()}`);
    rt = createOperatorRuntime({ network: NETWORK, endpoints: localConfig, operatorSecret: randomBytes32(), providers });
  });

  afterAll(async () => {
    await walletCtx?.wallet.stop();
    const out = path.resolve(import.meta.dirname, '../../reports/zkiss-devnet.json');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), event, log }, null, 2));
  });

  it('티켓 → 참가 → 방 material → terms → 양측 동의 → 공개 확인 → HPKE 봉투 → 종료, 공격 거절', async () => {
    // ---- 행사 배포(운영 CLI 경로와 같은 deployEvent) ----
    const t0 = Date.now();
    const deployed = await rt.deployEvent(new Date(Date.now() + 6 * 3600 * 1000));
    event = { network: deployed.network, contractAddress: deployed.contractAddress, eventScope: deployed.eventScope };
    log.push({ step: 'operator deployEvent', ms: Date.now() - t0, txId: deployed.transactionId });

    adapter = createMidnightAdapter({
      mode: 'real',
      network: NETWORK,
      zkManifestUrl: null,
      capabilities: { admission: true, reveal: true, anonymousReveal: true }, // 이 테스트 안에서만
      chain,
      transcriptOf: zkissTranscriptOf,
      contractAllowlist: [event.contractAddress],
    });

    // ---- A. 티켓: 단말은 leaf만 보낸다 → worker가 operator.issueTicket ----
    const A = newParticipant();
    const B = newParticipant();
    const C = newParticipant();
    for (const [n, p] of [['A', A], ['B', B], ['C', C]] as const) {
      const leaf = hex(ticketLeafFor(p));
      expect(await rt.operator.isTicketIssued(event, leaf)).toBe(false);
      await tx(`operator issueTicket ${n}`, () => rt.operator.issueTicket(event, leaf));
      expect(await rt.operator.isTicketIssued(event, leaf)).toBe(true); // 재시도 전 멱등성 확인 경로
    }
    const hA: ZkissHandle = await handle('A', A);
    const hB: ZkissHandle = await handle('B', B);
    const hC: ZkissHandle = await handle('C', C);

    // ---- M01 참가 ----
    const admA = await admitVia('A', hA);
    expect((await verifyUntilSettled(admA.input, 'verify A admission')).status).toBe('succeeded');
    const bForged = makeBinding('C', 'admission');
    const forged = await adapter.prepare(bForged, bindingHashOf(bForged), { event });
    const vForged = await adapter.verify({ ...forged, intentId: bForged.intentId, purpose: 'admission', bindingHash: bindingHashOf(bForged), expiresAt: bForged.expiresAt, transactionId: admA.sub.transactionId });
    log.push({ step: 'verify C intent with A tx id', ms: 0, verify: `${vForged.status}:${'reasonCode' in vForged ? vForged.reasonCode : ''}` });
    expect(vForged).toEqual({ status: 'failed', reasonCode: 'EFFECT_NOT_FOUND' });
    await rejected('unissued ticket admit', async () => admitVia('M', await handle('M', newParticipant())), /ticket not issued/);
    await rejected('same ticket second admit', () => admitVia('A', hA), /ticket already admitted/);
    await admitVia('B', hB);
    await admitVia('C', hC);

    // 백엔드가 불러갈 진입 모듈(MIDNIGHT_ADAPTER_MODULE) 자체로도 같은 판정이 나오는지
    process.env.MIDNIGHT_NETWORK = NETWORK;
    process.env.MIDNIGHT_INDEXER_URL = localConfig.indexer;
    process.env.MIDNIGHT_CAPABILITIES = 'admission';
    const moduleAdapter: MidnightAdapter = (await import('../../src/node/adapter.module.js')).default;
    expect(moduleAdapter.capabilities).toEqual({ admission: true, reveal: false, anonymousReveal: false });
    expect((await verifyUntilSettled(admA.input, 'module adapter verify A admission', moduleAdapter)).status).toBe('succeeded');

    // ---- B. SNS 공개 요청: 방 material 수집 ----
    const roomId = randomBytes32(); // conversations.chain_room_id
    let setA: RoomSetup, setB: RoomSetup, setC: RoomSetup;
    let A2: ZkissPrivateState, B2: ZkissPrivateState, C2: ZkissPrivateState;
    [A2, setA] = await setupRoom(A, roomId, 'alice.kim');
    [B2, setB] = await setupRoom(B, roomId, '밥_99');
    [C2, setC] = await setupRoom(C, roomId, 'mallory');
    const matA = roomMaterial(A2, scope(), roomId, setA); // PUT room-material 본문
    const matB = roomMaterial(B2, scope(), roomId, setB);
    for (const m of [matA, matB]) expect(Object.keys(m).sort()).toEqual(['contactCommit', 'keyCommit', 'roomPublicKey', 'slot']);

    // worker: roomState → openRoom → revealTerms
    expect(await rt.operator.roomState(event, hex(roomId))).toBe('absent');
    const roomExpires = new Date((Math.floor(Date.now() / 1000) + 3 * 3600) * 1000).toISOString();
    await tx('operator openRoom', () => rt.operator.openRoom(event, { roomId: hex(roomId), slotA: matA.slot, slotB: matB.slot, expiresAt: roomExpires }));
    expect(await rt.operator.roomState(event, hex(roomId))).toBe('open');
    const termsReq = {
      event,
      roomId: hex(roomId),
      slots: [matA.slot, matB.slot] as [string, string],
      keyCommits: [matA.keyCommit, matB.keyCommit] as [string, string],
      contactCommits: [matA.contactCommit, matB.contactCommit] as [string, string],
      expiresAt: roomExpires,
      policyVersion: 1,
    };
    const { transcriptHash, terms } = await adapter.revealTerms(termsReq);

    // 단말: 서버가 준 terms로 transcript를 스스로 계산해 대조
    const l0 = await state();
    expect(hex(transcriptFor(event.contractAddress, scope(), roomId, l0.rooms.lookup(roomId), parseTerms(terms)))).toBe(transcriptHash);

    const hA2: ZkissHandle = await handle('A-room', A2);
    const hB2: ZkissHandle = await handle('B-room', B2);
    const hC2: any = await handle('C-room', C2);
    const reveal = (slotIndex: 0 | 1) => ({ roomId: hex(roomId), slotIndex, anonymous: true });
    const approveVia = async (who: 'A' | 'B', h: ZkissHandle, mine: RoomSetup, termsWire: string, trHex: string, pre?: Binding) => {
      const b = pre ?? makeBinding(who, 'reveal_approval', { revealRequestId: 'req-1', transcriptHash: trHex });
      const bh = bindingHashOf(b);
      const intent = await adapter.prepare(b, bh, { event, reveal: reveal(who === 'A' ? 0 : 1) });
      const sub = await tx(`${who} approveReveal`, () =>
        submitRevealApproval(h, intent, termsWire, { network: NETWORK, contractAddress: event.contractAddress, eventScope: scope(), ledger: l0, mine }),
      );
      const input: VerificationInput = { ...intent, intentId: b.intentId, purpose: 'reveal_approval', bindingHash: bh, expiresAt: b.expiresAt, transactionId: sub.transactionId };
      return { b, bh, sub, input };
    };

    // 서버가 A 슬롯 키 커밋을 바꿔친 terms → 단말이 거래를 만들지 않는다
    const swapped = await adapter.revealTerms({ ...termsReq, keyCommits: [hex(setC.keyCommit), matB.keyCommit] });
    await rejected('device refuses swapped own key', () => approveVia('A', hA2, setA, swapped.terms, swapped.transcriptHash), /OWN_COMMIT_MISMATCH/);
    await rejected('third party approves', () => hC2.callTx.approveReveal(randomBytes32(), BigInt(Math.floor(Date.now() / 1000) + 600), roomId, parseTerms(terms)), /not a room member/);

    const apA = await approveVia('A', hA2, setA, terms, transcriptHash);
    expect((await verifyUntilSettled(apA.input, 'verify A approval')).status).toBe('succeeded');
    expect(await adapter.revealStatus(event, transcriptHash)).toBe('awaiting');

    // H1: A가 B의 bindingHash를 선점해도 B의 승인·verify는 영향 없음
    const bB = makeBinding('B', 'reveal_approval', { revealRequestId: 'req-1', transcriptHash });
    const other = await adapter.revealTerms(termsReq); // 다른 nonce의 terms
    await tx('A pre-empts B bindingHash', () =>
      (hA2 as any).callTx.approveReveal(hexToBytes(bindingHashOf(bB), 32), BigInt(Math.floor(Date.now() / 1000) + 600), roomId, parseTerms(other.terms)),
    );
    expect(await adapter.revealStatus(event, other.transcriptHash)).toBe('awaiting'); // 한쪽만 승인한 다른 terms
    const apB = await approveVia('B', hB2, setB, terms, transcriptHash, bB);
    expect((await verifyUntilSettled(apB.input, 'verify B approval')).status).toBe('succeeded');

    // 백엔드 released 직전 확인
    expect(await adapter.revealStatus(event, transcriptHash)).toBe('authorized');
    log.push({ step: 'revealStatus before release', ms: 0, verify: 'authorized' });

    // ---- 공개 transcript 검사: A 승인 거래 원문 ----
    const raw = await rawTx(apA.sub.transactionId);
    const trim = (h: string) => h.replace(/(00)+$/, '');
    const secrets = {
      ticketSecret: hex(A.ticketSecret),
      nullifier: hex(pureCircuits.nullifierOf(scope(), A.ticketSecret)),
      admittedLeaf: hex(pureCircuits.admittedLeafOf(scope(), A.ticketSecret)),
      contactSalt: hex(A2.roomSecrets[hex(roomId)].contactSalt),
      contact: hex(A2.roomSecrets[hex(roomId)].contact),
      roomPk: hex(A2.roomSecrets[hex(roomId)].recipientPk),
    };
    expect(raw.includes(trim(hex(roomId))), 'control: roomId in raw tx').toBe(true);
    const leaks = Object.entries(secrets).filter(([, v]) => raw.includes(trim(v))).map(([k]) => k);
    log.push({ step: 'A approveReveal raw tx leak scan', ms: 0, verify: `bytes=${raw.length / 2} leaks=${JSON.stringify(leaks)}` });
    expect(leaks).toEqual([]);

    // ---- HPKE 봉투: A → B (백엔드 envelope 형식) ----
    const t = parseTerms(terms);
    const envAtoB = await sealContact({
      recipientPub: Uint8Array.from(Buffer.from(matB.roomPublicKey, 'base64')),
      recipientKeyCommit: t.keyCommitB,
      recipientKeyVersion: 1,
      transcript: hexToBytes(transcriptHash, 32),
      contact: A2.roomSecrets[hex(roomId)].contact,
      contactSalt: A2.roomSecrets[hex(roomId)].contactSalt,
      keyCommit: pureCircuits.recipientKeyCommit,
    });
    expect(envAtoB.suite).toBe('hpke-x25519-hkdfsha256-aes128gcm-v1');
    const openAs = (key: RoomSetup, myCommit: Uint8Array) =>
      openContact({
        recipientKey: key.roomKey,
        recipientKeyCommit: myCommit,
        transcript: hexToBytes(transcriptHash, 32),
        envelope: envAtoB,
        expectedContactCommit: t.contactCommitA,
        contactCommit: pureCircuits.contactCommit,
      });
    const opened = await openAs(setB, t.keyCommitB);
    expect(opened.ok && decodeContact(opened.contact)).toBe('alice.kim');
    expect((await openAs(setC, t.keyCommitB)).ok).toBe(false);
    log.push({ step: 'HPKE envelope A→B open (B ok, C fail)', ms: 0, verify: 'ok' });

    // ---- C. 종료: 대화 종료 → worker가 operator.closeRoom ----
    await tx('operator closeRoom', () => rt.operator.closeRoom(event, hex(roomId)));
    expect(await rt.operator.roomState(event, hex(roomId))).toBe('closed');
    expect(await adapter.revealStatus(event, transcriptHash)).toBe('closed');
    expect(await verifyUntilSettled(apA.input, 'verify A approval after close')).toEqual({ status: 'failed', reasonCode: 'ROOM_CLOSED' });
    await rejected('approval after room closed', () => (hB2 as any).callTx.approveReveal(randomBytes32(), BigInt(Math.floor(Date.now() / 1000) + 600), roomId, parseTerms(other.terms)), /room closed/);
  });
});

const rawTx = async (identifier: string): Promise<string> => {
  const res = await fetch(localConfig.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query($o: TransactionOffset!){ transactions(offset: $o){ raw } }', variables: { o: { identifier } } }),
  });
  const body: any = await res.json();
  return String(body?.data?.transactions?.[0]?.raw ?? '').toLowerCase();
};
