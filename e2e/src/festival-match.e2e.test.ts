// 축제 번호팅 Local Devnet E2E: 실제 ZK 증명 + 노드 거래.
// PROVER=wasm 이면 증명 서버 대신 이 프로세스 안의 zkir-v2 WASM으로 증명한다(단말 내 증명 가능성 확인).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { Contract, ledger, pureCircuits } from '../../contract/src/managed/festival-match/contract/index.js';
import { buildWallet, configureProviders, localConfig, type WalletContext } from './wallet.js';
import { wasmProofProvider } from './wasm-prover.js';

const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const zkPath = path.resolve(import.meta.dirname, '../../contract/src/managed/festival-match');
const PROVER = process.env.PROVER === 'wasm' ? 'wasm' : 'server';

// 단말 비공개 상태. DH 개인키·인스타 원문·커밋 난수는 이 객체(단말) 밖으로 나가지 않는다
type PS = { opSk: Uint8Array; ticket: Uint8Array; dhSk: string; insta: string; instaSalt: Uint8Array };
type KP = ReturnType<typeof generateKeyPairSync>;
const keyPairs = new Map<string, KP>(); // dhSk(참조 id) → 키쌍. 비공개 상태는 직렬화되므로 키 객체 대신 id를 둔다

const pad32 = (s: string) => { const b = new Uint8Array(32); b.set(Buffer.from(s, 'utf8')); return b; };
const rawPk = (kp: KP) => new Uint8Array(kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const spki = (raw: Uint8Array) => Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(raw)]);
function sharedSecret(ps: PS, peerRawPk: Uint8Array) {
  const kp = keyPairs.get(ps.dhSk)!;
  const peer = { key: spki(peerRawPk), format: 'der', type: 'spki' } as const;
  return new Uint8Array(createHash('sha256').update(diffieHellman({ privateKey: kp.privateKey, publicKey: createPublicKey(peer) })).digest());
}

const witnesses = {
  operatorSecret: ({ privateState }: any) => [privateState, privateState.opSk],
  ticketSecret: ({ privateState }: any) => [privateState, privateState.ticket],
  ticketPath: ({ privateState, ledger: l }: any, leaf: Uint8Array) => [
    privateState,
    l.tickets.findPathForLeaf(leaf) ?? l.tickets.pathForLeaf(0n, leaf),
  ],
  // 상대 카드의 dhPk(원장)와 내 DH 개인키로 공유 비밀 계산
  pairSecret: ({ privateState, ledger: l }: any, peer: Uint8Array) => [privateState, sharedSecret(privateState, l.cards.lookup(peer).dhPk)],
};

const compiledContract = CompiledContract.make('festival-match', Contract).pipe(
  CompiledContract.withWitnesses(witnesses as any),
  CompiledContract.withCompiledFileAssets(zkPath),
);

function person(insta: string): PS {
  const id = randomBytes(8).toString('hex');
  keyPairs.set(id, generateKeyPairSync('x25519'));
  return { opSk: randomBytes(32), ticket: randomBytes(32), dhSk: id, insta, instaSalt: randomBytes(32) };
}

function encryptContact(s: Uint8Array, insta: string, salt: Uint8Array): Uint8Array {
  const key = createHash('sha256').update('contact-key').update(s).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.alloc(62);
  Buffer.from(insta, 'utf8').copy(plain, 0, 0, 30);
  Buffer.from(salt).copy(plain, 30);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const out = new Uint8Array(96);
  out.set(iv, 0); out.set(c.getAuthTag(), 12); out.set(body, 28);
  return out;
}
function decryptContact(s: Uint8Array, ct: Uint8Array) {
  const key = createHash('sha256').update('contact-key').update(s).digest();
  const d = createDecipheriv('aes-256-gcm', key, ct.subarray(0, 12));
  d.setAuthTag(ct.subarray(12, 28));
  const plain = Buffer.concat([d.update(ct.subarray(28, 90)), d.final()]);
  return { insta: plain.subarray(0, 30).toString('utf8').replace(/\0+$/, ''), salt: new Uint8Array(plain.subarray(30, 62)) };
}

const log: { step: string; ms: number; txId?: string; block?: string; error?: string }[] = [];
async function tx(step: string, f: () => Promise<any>) {
  const t = Date.now();
  const r = await f();
  log.push({ step, ms: Date.now() - t, txId: String(r.public.txId), block: String(r.public.blockHeight) });
  return r;
}
async function rejected(step: string, f: () => Promise<unknown>, expected: RegExp) {
  const t = Date.now();
  let err: unknown;
  try { await f(); } catch (e) { err = e; }
  const msg = err instanceof Error ? err.message : String(err);
  log.push({ step, ms: Date.now() - t, error: err === undefined ? 'NOT REJECTED' : msg.slice(0, 140) });
  expect(err, `${step} must be rejected`).toBeDefined();
  expect(msg).toMatch(expected);
}

describe(`festival-match on Local Devnet (prover=${PROVER})`, () => {
  let walletCtx: WalletContext;
  let providers: Awaited<ReturnType<typeof configureProviders>>;
  let address: string;
  const op = person('operator');
  const A = person('alice.kim');
  const B = person('bob_99');
  const C = person('charlie');

  const state = async () => ledger((await providers.publicDataProvider.queryContractState(address))!.data);
  const handle = (id: string, ps: PS) =>
    findDeployedContract(providers as any, { contractAddress: address, compiledContract, privateStateId: id, initialPrivateState: ps } as any) as Promise<any>;
  async function join(h: any, u: PS) {
    const before = new Set([...(await state()).cards].map(([k]) => Buffer.from(k).toString('hex')));
    const card = new Uint8Array(createHash('sha256').update(`card:${u.insta}`).digest());
    await tx(`${u.insta} joinEvent`, () => h.callTx.joinEvent(card, pureCircuits.instaCommitment(pad32(u.insta), u.instaSalt), rawPk(keyPairs.get(u.dhSk)!)));
    const added = [...(await state()).cards].map(([k]) => Buffer.from(k).toString('hex')).filter((k) => !before.has(k));
    expect(added).toHaveLength(1);
    return Buffer.from(added[0], 'hex');
  }

  beforeAll(async () => {
    setNetworkId('undeployed');
    walletCtx = await buildWallet(localConfig, GENESIS_SEED);
    providers = await configureProviders(
      walletCtx, localConfig, zkPath, `fm-e2e-${Date.now()}`,
      PROVER === 'wasm' ? (zk) => wasmProofProvider(zk) : undefined,
    );
  });

  afterAll(async () => {
    await walletCtx?.wallet.stop();
    const out = path.resolve(import.meta.dirname, `../reports/festival-${PROVER}.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), prover: PROVER, address, log }, null, 2));
  });

  it('티켓 → 카드 → 상호 좋아요 → 암호화 연락처 교환, 공격 거절', async () => {
    const t = Date.now();
    const end = BigInt(Math.floor(Date.now() / 1000) + 6 * 3600);
    const deployed: any = await deployContract(providers as any, {
      compiledContract, privateStateId: 'operator', initialPrivateState: op, args: [end, 5n],
    } as any);
    address = deployed.deployTxData.public.contractAddress;
    log.push({ step: 'deploy', ms: Date.now() - t, txId: String(deployed.deployTxData.public.txId) });

    for (const u of [A, B, C]) await tx(`issue ${u.insta}`, () => deployed.callTx.issueTicket(pureCircuits.ticketLeaf(u.ticket)));
    const a = await handle('A', A), b = await handle('B', B), c = await handle('C', C);
    const hA = await join(a, A), hB = await join(b, B), hC = await join(c, C);

    await rejected('no ticket joinEvent', async () => (await handle('M', person('mallory'))).callTx.joinEvent(randomBytes(32), randomBytes(32), randomBytes(32)), /not a ticket holder/);
    await rejected('same ticket second card', () => a.callTx.joinEvent(randomBytes(32), randomBytes(32), randomBytes(32)), /ticket already used/);

    await tx('A like B', () => a.callTx.like(hB));
    expect([...(await state()).matches]).toHaveLength(0);
    await rejected('A like B again', () => a.callTx.like(hB), /already liked/);
    await tx('C like A (one-sided)', () => c.callTx.like(hA));
    expect([...(await state()).matches]).toHaveLength(0);
    await tx('B like A', () => b.callTx.like(hA));

    const s = await state();
    const [[tag, m]] = [...s.matches];
    expect(new Set([Buffer.from(m.a).toString('hex'), Buffer.from(m.b).toString('hex')])).toEqual(new Set([hA.toString('hex'), hB.toString('hex')]));

    await rejected('C reveal to A-B match', () => c.callTx.revealContact(tag, new Uint8Array(96)), /not a match participant/);
    const sA = sharedSecret(A, s.cards.lookup(hB).dhPk);
    const sB = sharedSecret(B, s.cards.lookup(hA).dhPk);
    await tx('A revealContact', () => a.callTx.revealContact(tag, encryptContact(sA, A.insta, A.instaSalt)));
    await tx('B revealContact', () => b.callTx.revealContact(tag, encryptContact(sB, B.insta, B.instaSalt)));
    await rejected('A reveal again (swap)', () => a.callTx.revealContact(tag, new Uint8Array(96)), /already revealed/);

    // 각자 단말에서 상대 연락처 복호화 + 카드 커밋 대조
    const fin = await state();
    const aToB = decryptContact(sB, fin.contacts.lookup(pureCircuits.contactKey(tag, hA)));
    const bToA = decryptContact(sA, fin.contacts.lookup(pureCircuits.contactKey(tag, hB)));
    expect(aToB.insta).toBe('alice.kim');
    expect(bToA.insta).toBe('bob_99');
    expect(pureCircuits.instaCommitment(pad32(aToB.insta), aToB.salt)).toEqual(fin.cards.lookup(hA).instaCommit);
    // 제3자 C는 복호화할 수 없다
    expect(() => decryptContact(sharedSecret(C, fin.cards.lookup(hA).dhPk), fin.contacts.lookup(pureCircuits.contactKey(tag, hA)))).toThrow();
    void hC;
  });
});
