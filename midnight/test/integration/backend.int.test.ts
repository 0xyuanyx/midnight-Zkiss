// 통합 E2E: 실제 Codex 백엔드(real 모드 API + worker) + Midnight 어댑터·운영자 모듈 + Local Devnet.
// 두 참가자 "단말"은 이 테스트가 흉내 낸다: HTTP로 백엔드를 부르고, 증명 거래는 src/device.ts로 직접 만든다.
// 운영자 거래(티켓·방 등록·종료)는 백엔드 worker가 operator 모듈로 낸다. 단말 거래 수수료는 genesis 테스트 지갑이 낸다.
// 필요: IT_BASE_URL(기본 http://127.0.0.1:3101), IT_EVENT_ID(기본 evt_it), 백엔드와 worker가 실행 중이어야 한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { ledger, pureCircuits } from '../../contract/managed/zkiss/contract/index.js';
import type { ZkissPrivateState } from '../../contract/witnesses.js';
import { buildWallet, configureProviders, localConfig, type WalletContext } from '../../src/node/wallet.js';
import { compiledZkiss, ZK_PATH } from '../../src/node/operator.js';
import { zkissIndexerView } from '../../src/ledger-decoder.js';
import { readRevealStatus } from '../../src/adapter.js';
import { bytesToHex, decodeContact, hexToBytes, randomBytes32 } from '../../src/encoding.js';
import { generateRoomKey, openContact, sealContact, type Envelope } from '../../src/envelope.js';
import { admissionNullifierFor, newParticipant, parseTerms, roomMaterial, setupRoom, submitAdmission, submitRevealApproval, ticketLeafFor, transcriptFor, type RoomSetup } from '../../src/device.js';

const BASE = process.env.IT_BASE_URL ?? 'http://127.0.0.1:3101';
const EVENT = process.env.IT_EVENT_ID ?? 'evt_it';
const E = `/events/${EVENT}`;
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

type Log = { step: string; ms: number; detail?: string };
const log: Log[] = [];
const step = async <T>(name: string, f: () => Promise<T>, detail?: (r: T) => string): Promise<T> => {
  const t = Date.now();
  const r = await f();
  log.push({ step: name, ms: Date.now() - t, detail: detail?.(r) });
  return r;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const poll = async <T>(what: string, f: () => Promise<T | undefined | false>, ms = 240_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as T;
    await sleep(1500);
  }
  throw new Error(`timeout waiting for ${what}`);
};

type User = { name: string; cookie: string; csrf: string; id: string };
const api = async (p: string, method = 'GET', body?: unknown, u?: User): Promise<any> => {
  const res = await fetch(BASE + '/api/v1' + p, {
    method,
    headers: {
      ...(u ? { cookie: u.cookie, 'X-CSRF-Token': u.csrf } : {}),
      'Idempotency-Key': crypto.randomUUID(),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
  return { data: json?.data ?? null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
};

// 합성 2x2 회색 PNG(사진 아님). sharp 없이 만든다.
const syntheticPng = (): Uint8Array<ArrayBuffer> => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.from([0, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88]);
  const idat = deflateSync(Buffer.concat([row, row]));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
};

describe(`backend(real) + midnight v2 integration (${BASE}, ${EVENT})`, () => {
  let walletCtx: WalletContext;
  let providers: Awaited<ReturnType<typeof configureProviders>>;
  const chain = zkissIndexerView(localConfig.indexer);

  beforeAll(async () => {
    setNetworkId('undeployed');
    walletCtx = await buildWallet(localConfig, GENESIS_SEED);
    providers = await configureProviders(walletCtx, localConfig, ZK_PATH, `zkiss-it-${Date.now()}`);
  });
  afterAll(async () => {
    await walletCtx?.wallet.stop();
    const out = path.resolve(import.meta.dirname, '../../reports/zkiss-integration.json');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), base: BASE, event: EVENT, log }, null, 2));
  });

  it('QR 세션 → 티켓(worker) → 참가 증명 → 게시·상호 호감 → SNS material → terms(worker) → 양측 체인 동의 → HPKE 봉투 released → 나가기 → 체인 방 종료', async () => {
    const ev = (await api(E)).data;
    expect(ev.id).toBe(EVENT);

    // 단말 한 대 = 세션 + 참가 비밀 + 체인 핸들
    const onboard = async (name: string) => {
      const s = await api('/sessions', 'POST', { eventId: EVENT });
      const u: User = { name, id: s.data.participantId, cookie: s.cookie, csrf: s.data.csrfToken };
      expect(u.cookie).toMatch(/^__Host-zkiss_session=/); // real 모드 쿠키
      await api(E + '/me/profile', 'PUT', { expectedVersion: 0, nickname: name, age: 24, gender: 'unspecified' }, u);
      const form = new FormData();
      form.set('expectedVersion', '1');
      form.set('photo', new Blob([new Uint8Array(syntheticPng())], { type: 'image/png' }), 'synthetic.png');
      let ai = (await api(E + '/me/ai-jobs', 'POST', form, u)).data;
      ai = await poll('ai job', async () => {
        const j = (await api(E + '/me/ai-jobs/' + ai.id, 'GET', undefined, u)).data;
        return j.status !== 'processing' && j;
      });
      expect(ai.status).toBe('succeeded');

      // 티켓: 단말은 leaf만 보낸다 → worker가 operator.issueTicket(실제 거래)
      const ps = newParticipant();
      await api(E + '/midnight/ticket', 'POST', { ticketLeaf: bytesToHex(ticketLeafFor(ps)) }, u);
      await step(`${name} ticket issued (worker→operator)`, () =>
        poll('ticket issued', async () => (await api('/me', 'GET', undefined, u)).data.ticket?.status === 'issued'),
      );

      // 참가: Z01 → 단말 증명·제출 → Z02 → worker verify → active
      const h: any = await findDeployedContract(providers as any, {
        contractAddress: (await eventChain()).contractAddress,
        compiledContract: compiledZkiss,
        privateStateId: `it-${name}-${Date.now()}`,
        initialPrivateState: ps,
      } as any);
      const ec = await eventChain();
      const intent = (await api(E + '/chain-intents', 'POST', { purpose: 'admission', admissionNullifier: bytesToHex(admissionNullifierFor(ps, hexToBytes(ec.eventScope, 32))), devicePublicKey: Buffer.from(randomBytes32()).toString('base64'), deviceKeyVersion: 1 }, u)).data;
      const sub = await step(`${name} admit tx (device proof)`, () =>
        submitAdmission(h, intent, { network: intent.network, contractAddress: intent.contractAddress, eventScope: hexToBytes(ec.eventScope, 32), privateState: ps }),
      );
      await api(E + `/chain-intents/${intent.id}/transactions`, 'POST', { transactionId: sub.transactionId }, u);
      await step(`${name} admission active (worker verify)`, () =>
        poll('admission active', async () => (await api('/me', 'GET', undefined, u)).data.admissionStatus === 'active'),
      );
      await api(E + '/me/profile/publication', 'POST', { expectedVersion: ai.profileVersion }, u);
      return { u, ps, h };
    };

    let chainCoords: { contractAddress: string; eventScope: string } | undefined;
    const eventChain = async () => chainCoords!;

    // 첫 intent를 만들기 전에는 체인 좌표를 알 수 없으므로 ticket 응답 대신 prepare 결과에서 얻는다.
    // (백엔드는 events 테이블의 좌표를 쓰며, 테스트 준비 단계에서 배포 CLI 결과로 채웠다.)
    chainCoords = { contractAddress: process.env.IT_CONTRACT_ADDRESS!, eventScope: process.env.IT_EVENT_SCOPE! };
    expect(chainCoords.contractAddress).toMatch(/^[0-9a-f]{64}$/);

    const A = await onboard('A');
    const B = await onboard('B');

    // 상호 호감 → 대화방
    await api(E + '/likes', 'POST', { targetProfileId: B.u.id }, A.u);
    const match = (await api(E + '/likes', 'POST', { targetProfileId: A.u.id }, B.u)).data;
    const roomPath = E + `/conversations/${match.conversationId}`;

    // 연락처 vault(백엔드 요구: 소유자 사본). 체인에는 쓰이지 않는다.
    for (const x of [A, B]) {
      const own = await generateRoomKey();
      const ownerEnvelope = await sealContact({
        recipientPub: own.publicKey,
        recipientKeyCommit: pureCircuits.recipientKeyCommit(own.publicKey),
        recipientKeyVersion: 1,
        transcript: randomBytes32(),
        contact: new Uint8Array(64).fill(0x61),
        contactSalt: randomBytes32(),
        keyCommit: pureCircuits.recipientKeyCommit,
      });
      await api(E + '/me/contact-vault', 'PUT', { expectedVersion: 0, commitment: bytesToHex(randomBytes32()), ownerEnvelope }, x.u);
    }

    // SNS 공개 요청(A) → 양측 room-material
    const conv = (await api(roomPath, 'GET', undefined, A.u)).data;
    let reveal = (await api(roomPath + '/reveal-requests', 'POST', { expectedVersion: conv.version, ownContactVersion: 1, consent: true }, A.u)).data;
    const revealPath = E + '/reveal-requests/' + reveal.id;
    expect(reveal.status).toBe('collecting');
    const roomId = hexToBytes(reveal.chainRoomId, 32);
    const scope = hexToBytes(reveal.eventScope, 32);
    expect(reveal.contractAddress).toBe(chainCoords.contractAddress);
    const setups = new Map<string, { ps: ZkissPrivateState; setup: RoomSetup; h: any }>();
    for (const [x, sns] of [[A, 'alice.kim'], [B, '밥_99']] as const) {
      const [ps2, setup] = await setupRoom(x.ps, roomId, sns);
      const h2: any = await findDeployedContract(providers as any, {
        contractAddress: reveal.contractAddress,
        compiledContract: compiledZkiss,
        privateStateId: `it-${x.u.name}-room-${Date.now()}`,
        initialPrivateState: ps2,
      } as any);
      setups.set(x.u.id, { ps: ps2, setup, h: h2 });
      await api(revealPath + '/room-material', 'PUT', roomMaterial(ps2, scope, roomId, setup), x.u);
    }

    // worker: openRoom(운영자 거래) + revealTerms → requested
    reveal = await step('terms ready (worker openRoom + revealTerms)', () =>
      poll('terms', async () => {
        const r = (await api(revealPath, 'GET', undefined, A.u)).data;
        return r.status !== 'collecting' && r;
      }),
    );
    expect(reveal.status).toBe('requested');
    // 단말: terms로 transcript를 스스로 계산해 서버 값과 대조
    const l0 = ledger((await providers.publicDataProvider.queryContractState(reveal.contractAddress))!.data);
    expect(bytesToHex(transcriptFor(reveal.contractAddress, scope, roomId, l0.rooms.lookup(roomId), parseTerms(reveal.terms)))).toBe(reveal.transcriptHash);

    // B 수락
    const rB = (await api(revealPath, 'GET', undefined, B.u)).data;
    await api(revealPath + '/decisions', 'POST', { expectedVersion: rB.version, transcriptHash: rB.transcriptHash, action: 'accept' }, B.u);

    // 양측 체인 동의: Z01 reveal_approval → 단말 증명(terms 재검사) → Z02 → worker verify
    for (const x of [A, B]) {
      const d = setups.get(x.u.id)!;
      const cur = (await api(revealPath, 'GET', undefined, x.u)).data;
      const ec = await eventChain();
      const intent = (await api(E + '/chain-intents', 'POST', { purpose: 'reveal_approval', revealRequestId: cur.id, transcriptHash: cur.transcriptHash }, x.u)).data;
      const sub = await step(`${x.u.name} approveReveal tx (device proof)`, () =>
        submitRevealApproval(d.h, intent, cur.terms, { network: intent.network, contractAddress: intent.contractAddress, eventScope: scope, ledger: l0, mine: d.setup }),
      );
      await api(E + `/chain-intents/${intent.id}/transactions`, 'POST', { transactionId: sub.transactionId }, x.u);
    }
    reveal = await step('reveal authorized (worker verify ×2)', () =>
      poll('authorized', async () => {
        const r = (await api(revealPath, 'GET', undefined, A.u)).data;
        if (['failed', 'expired', 'cancelled'].includes(r.status)) throw new Error(`reveal ${r.status}`);
        return r.status === 'authorized' && r;
      }),
    );
    expect(await readRevealStatus(chain, reveal.contractAddress, reveal.transcriptHash)).toEqual({ state: 'authorized' });

    // HPKE 봉투: 각자 상대 방 키로 봉인해 업로드 → released → 상대 봉투 개봉·커밋 확인
    const t = parseTerms(reveal.terms);
    for (const x of [A, B]) {
      const d = setups.get(x.u.id)!;
      const cur = (await api(revealPath, 'GET', undefined, x.u)).data;
      const iAmA = bytesToHex(d.setup.keyCommit) === bytesToHex(t.keyCommitA);
      const envelope = await sealContact({
        recipientPub: Uint8Array.from(Buffer.from(cur.peerEncryptionKey.publicKey, 'base64')),
        recipientKeyCommit: iAmA ? t.keyCommitB : t.keyCommitA,
        recipientKeyVersion: cur.peerEncryptionKey.version,
        transcript: hexToBytes(cur.transcriptHash, 32),
        contact: d.ps.roomSecrets[bytesToHex(roomId)].contact,
        contactSalt: d.ps.roomSecrets[bytesToHex(roomId)].contactSalt,
        keyCommit: pureCircuits.recipientKeyCommit,
      });
      await api(revealPath + '/my-envelope', 'PUT', { expectedVersion: cur.version, transcriptHash: cur.transcriptHash, envelope }, x.u);
    }
    const released = await step('released (backend revealStatus recheck)', () =>
      poll('released', async () => {
        const r = (await api(revealPath, 'GET', undefined, A.u)).data;
        return r.status === 'released' && r;
      }, 60_000),
    );
    expect(released.status).toBe('released');
    const got: Record<string, string> = {};
    for (const x of [A, B]) {
      const d = setups.get(x.u.id)!;
      const iAmA = bytesToHex(d.setup.keyCommit) === bytesToHex(t.keyCommitA);
      const env: Envelope = (await api(revealPath + '/peer-envelope', 'GET', undefined, x.u)).data;
      const opened = await openContact({
        recipientKey: d.setup.roomKey,
        recipientKeyCommit: iAmA ? t.keyCommitA : t.keyCommitB,
        transcript: hexToBytes(released.transcriptHash, 32),
        envelope: env,
        expectedContactCommit: iAmA ? t.contactCommitB : t.contactCommitA,
        contactCommit: pureCircuits.contactCommit,
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) got[x.u.name] = decodeContact(opened.contact);
    }
    expect(got).toEqual({ A: '밥_99', B: 'alice.kim' });
    log.push({ step: 'peer envelopes opened on both devices', ms: 0, detail: 'A←B, B←A, commitments match' });

    // 나가기 → worker close job → operator.closeRoom(실제 거래) → 체인 방 closed
    const conv2 = (await api(roomPath, 'GET', undefined, A.u)).data;
    await api(roomPath + '/leave', 'POST', { expectedVersion: conv2.version }, A.u);
    await step('chain room closed (worker→operator closeRoom)', () =>
      poll('room closed', async () => (await readRevealStatus(chain, reveal.contractAddress, reveal.transcriptHash)).state === 'closed'),
    );
  });
});
