/** Opt-in Local Devnet integration. Real HTTP/Postgres/worker/ZK/HPKE; synthetic AI.
 * One synchronized genesis fee wallet, sequential submissions, separate participant states.
 * Never use on a public network. MIDNIGHT_SOURCE_DIR points to the Midnight package.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { database } from '../test/helpers.js';
import { migrate } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { localConfig } from '../src/config.js';
import { loadProviders } from '../src/providers.js';
import { reconcile, processChainJobs } from '../src/worker.js';

if (!process.env.MIDNIGHT_SOURCE_DIR) throw new Error('MIDNIGHT_SOURCE_DIR_REQUIRED');
const root = resolve(process.env.MIDNIGHT_SOURCE_DIR);
const moduleAt = (p: string) => import(pathToFileURL(resolve(root, p)).href);
// Node's ESM conditions are required: the SDK CJS export references missing assets.
const sdk = (p: string) => import(import.meta.resolve(p, pathToFileURL(resolve(root, 'package.json')).href));
const { setNetworkId } = await sdk('@midnight-ntwrk/midnight-js/network-id');
const { findDeployedContract } = await sdk('@midnight-ntwrk/midnight-js/contracts');
const { buildWallet, configureProviders, localConfig: endpoints } = await moduleAt('src/node/wallet.ts');
const { createOperatorRuntime, compiledZkiss, ZK_PATH } = await moduleAt('src/node/operator.ts');
const device = await moduleAt('src/device.ts');
const crypto = await moduleAt('src/envelope.ts');
const { bytesToHex: hex, hexToBytes: bytes, randomBytes32, decodeContact } = await moduleAt('src/encoding.ts');
const { ledger, pureCircuits } = await moduleAt('contract/managed/zkiss/contract/index.js');
const report: any = { startedAt: new Date().toISOString(), network: 'undeployed', ai: 'synthetic fixture', feeWallet: 'single shared local genesis provider', steps: [] };
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  console.log(`START ${name}`);
  const start = Date.now();
  const value = await fn();
  report.steps.push({ name, ms: Date.now() - start });
  console.log(`PASS ${name} (${Date.now() - start}ms)`);
  return value;
};
let db: Awaited<ReturnType<typeof database>> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let wallet: any;
let runtime: any;
let base = '';
type User = { id: string; cookie: string; csrf: string; ps: any; contact: string; ownerKey: any; setup?: any; material?: any; handle?: any };
async function request(path: string, method = 'GET', body?: unknown, u?: User, expected?: number) {
  const res = await fetch(base + '/api/v1' + path, {
    method, headers: { ...(u ? { cookie: u.cookie, 'X-CSRF-Token': u.csrf } : {}), 'Idempotency-Key': randomUUID(), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
  });
  const json: any = res.status === 204 ? {} : await res.json();
  if (expected !== undefined) assert.equal(res.status, expected, `${method} ${path}: ${json.error?.code}`);
  else assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(json.error)}`);
  return { data: json.data, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
try {
  setNetworkId('undeployed');
  wallet = await step('sync shared local genesis wallet', () => buildWallet(endpoints, '0'.repeat(63) + '1'));
  const providers = await configureProviders(wallet, endpoints, ZK_PATH, `backend-e2e-${randomUUID()}`);
  runtime = createOperatorRuntime({ network: 'undeployed', endpoints, operatorSecret: randomBytes32(), providers });
  const end = new Date(Date.now() + 6 * 3600000);
  const deployed: any = await step('deploy event', () => runtime.deployEvent(end));
  const event = { network: deployed.network, contractAddress: deployed.contractAddress, eventScope: deployed.eventScope };
  report.event = event;
  report.deploymentTransactionId = deployed.transactionId;
  Object.assign(process.env, { MIDNIGHT_NETWORK: 'undeployed', MIDNIGHT_INDEXER_URL: endpoints.indexer, MIDNIGHT_CAPABILITIES: 'admission,reveal', MIDNIGHT_CONTRACT_ALLOWLIST: event.contractAddress });
  const config = { ...localConfig, mode: 'real' as const, secureCookies: true, midnightAdapterModule: resolve(root, 'src/node/adapter.module.ts') };
  const { midnight } = await loadProviders(config);
  assert.ok(midnight);
  db = await database();
  const pool = db.pool;
  await migrate(pool);
  const eventId = `e2e_${randomUUID()}`;
  const E = `/events/${eventId}`;
  await pool.query(`INSERT INTO events(id,name,join_until,discover_until,chat_until,modes,sns_reveal,midnight_network,midnight_contract_address,midnight_event_scope) VALUES($1,'Synthetic integration event',$2,$2,$2,'["mutual_like"]',true,$3,$4,$5)`, [eventId, end, event.network, event.contractAddress, event.eventScope]);
  app = await buildApp({ pool, config, midnight, ai: { mode: 'real', async analyze() { return { intro: '[Integration fixture] Synthetic image; no AI inference.', modelVersion: 'integration-fixture' }; } } });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await request(E)).data.mode, 'real');
  const tick = () => processChainJobs(pool, midnight, runtime.operator);
  const handle = (id: string, ps: any) => findDeployedContract(providers, { contractAddress: event.contractAddress, compiledContract: compiledZkiss, privateStateId: id, initialPrivateState: ps });
  const context = { network: event.network, contractAddress: event.contractAddress, eventScope: bytes(event.eventScope, 32) };
  const confirm = async (u: User, intent: any, tx: any) => {
    await request(E + `/chain-intents/${intent.id}/transactions`, 'POST', { transactionId: tx.transactionId }, u);
    for (let i = 0; i < 30; i++) {
      await reconcile(pool, midnight);
      const op = (await request(E + `/operations/${intent.operationId}`, 'GET', undefined, u)).data;
      if (op.status === 'succeeded') { assert.equal(op.effectApplied, true); return; }
      assert.ok(['submitted', 'confirming', 'reconciling'].includes(op.status), JSON.stringify(op));
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('CONFIRM_TIMEOUT');
  };
  const onboard = async (name: string): Promise<User> => {
    const s = await request('/sessions', 'POST', { eventId });
    const u: User = { id: s.data.participantId, cookie: s.cookie, csrf: s.data.csrfToken, ps: device.newParticipant(), contact: `synthetic.${name.toLowerCase()}`, ownerKey: await crypto.generateRoomKey() };
    await request(E + '/midnight/ticket', 'POST', { ticketLeaf: hex(device.ticketLeafFor(u.ps)) }, u);
    await step(`worker issues ticket ${name}`, tick);
    assert.equal((await request('/me', 'GET', undefined, u)).data.ticket.status, 'issued');
    const intent = (await request(E + '/chain-intents', 'POST', { purpose: 'admission', devicePublicKey: Buffer.from(u.ownerKey.publicKey).toString('base64'), deviceKeyVersion: 1 }, u)).data;
    u.handle = await handle(name, u.ps);
    const tx = await step(`device admission ${name}`, () => device.submitAdmission(u.handle, intent, context));
    await confirm(u, intent, tx);
    assert.equal((await request('/me', 'GET', undefined, u)).data.admissionStatus, 'active');
    await request(E + `/demo/chain-intents/${intent.id}/resolution`, 'POST', { outcome: 'succeeded' }, u, 404);
    await request(E + '/me/profile', 'PUT', { expectedVersion: 0, nickname: `Integration ${name}`, age: 24, gender: 'unspecified' }, u);
    const form = new FormData();
    form.set('expectedVersion', '1');
    form.set('photo', new Blob([new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#888888' } }).png().toBuffer())], { type: 'image/png' }), 'synthetic.png');
    let ai = (await request(E + '/me/ai-jobs', 'POST', form, u)).data;
    for (let n = 0; n < 100 && ai.status === 'processing'; n++) {
      await new Promise(r => setTimeout(r, 100));
      ai = (await request(E + '/me/ai-jobs/' + ai.id, 'GET', undefined, u)).data;
    }
    assert.equal(ai.status, 'succeeded');
    await request(E + '/me/profile/publication', 'POST', { expectedVersion: ai.profileVersion }, u);
    // A separate self-encrypted vault envelope; room disclosure keys are generated later.
    const [vaultPs, vaultSetup] = await device.setupRoom(u.ps, new Uint8Array(32), u.contact);
    const secret = vaultPs.roomSecrets['0'.repeat(64)];
    const ownerCommit = pureCircuits.recipientKeyCommit(u.ownerKey.publicKey);
    const ownerEnvelope = await crypto.sealContact({ recipientPub: u.ownerKey.publicKey, recipientKeyCommit: ownerCommit, recipientKeyVersion: 1, transcript: new Uint8Array(32), contact: secret.contact, contactSalt: secret.contactSalt, keyCommit: pureCircuits.recipientKeyCommit });
    await request(E + '/me/contact-vault', 'PUT', { expectedVersion: 0, commitment: hex(vaultSetup.contactCommit), ownerEnvelope }, u);
    return u;
  };
  const a = await step('HTTP onboard A', () => onboard('A'));
  const b = await step('HTTP onboard B', () => onboard('B'));
  await request(E + '/likes', 'POST', { targetProfileId: b.id }, a);
  const match = (await request(E + '/likes', 'POST', { targetProfileId: a.id }, b)).data;
  const room = E + '/conversations/' + match.conversationId;
  await request(room + '/messages', 'POST', { clientMessageId: randomUUID(), text: 'Synthetic integration message' }, a);
  assert.equal((await request(room + '/messages', 'GET', undefined, b)).data.items[0].sender, 'peer');
  let r = (await request(room + '/reveal-requests', 'POST', { expectedVersion: 1, ownContactVersion: 1, consent: true }, a)).data;
  assert.equal(r.status, 'collecting');
  const rp = E + '/reveal-requests/' + r.id;
  const roomId = bytes(r.chainRoomId, 32);
  for (const u of [a, b]) {
    [u.ps, u.setup] = await device.setupRoom(u.ps, roomId, u.contact);
    u.material = device.roomMaterial(u.ps, context.eventScope, roomId, u.setup);
    await request(rp + '/room-material', 'PUT', u.material, u);
    u.handle = await handle(u.id + '-room', u.ps);
  }
  await step('worker opens room and builds terms', tick);
  r = (await request(rp, 'GET', undefined, a)).data;
  assert.equal(r.status, 'requested');
  await request(rp + '/decisions', 'POST', { expectedVersion: r.version, transcriptHash: r.transcriptHash, action: 'accept' }, b);
  for (const [i, u] of [a, b].entries()) {
    const intent = (await request(E + '/chain-intents', 'POST', { purpose: 'reveal_approval', revealRequestId: r.id, transcriptHash: r.transcriptHash }, u)).data;
    const state = ledger((await providers.publicDataProvider.queryContractState(event.contractAddress)).data);
    const tx = await step(`device reveal approval ${i + 1}`, () => device.submitRevealApproval(u.handle, intent, r.terms, { ...context, ledger: state, mine: u.setup }));
    await confirm(u, intent, tx);
    if (i === 0) {
      assert.equal((await request(rp, 'GET', undefined, a)).data.status, 'awaiting_chain');
      await request(rp + '/peer-envelope', 'GET', undefined, a, 409);
    }
  }
  assert.equal((await request(rp, 'GET', undefined, a)).data.status, 'authorized');
  await request(rp + '/peer-envelope', 'GET', undefined, a, 409);
  for (const [i, u] of [a, b].entries()) {
    r = (await request(rp, 'GET', undefined, u)).data;
    const peer = u === a ? b : a;
    assert.equal(r.peerEncryptionKey.publicKey, peer.material.roomPublicKey);
    const secret = u.ps.roomSecrets[hex(roomId)];
    const envelope = await crypto.sealContact({ recipientPub: Buffer.from(r.peerEncryptionKey.publicKey, 'base64'), recipientKeyCommit: bytes(peer.material.keyCommit, 32), recipientKeyVersion: 1, transcript: bytes(r.transcriptHash, 32), contact: secret.contact, contactSalt: secret.contactSalt, keyCommit: pureCircuits.recipientKeyCommit });
    await request(rp + '/my-envelope', 'PUT', { expectedVersion: r.version, transcriptHash: r.transcriptHash, envelope }, u);
    if (i === 0) await request(rp + '/peer-envelope', 'GET', undefined, b, 409);
  }
  await step('HTTP release and bilateral HPKE decryption', async () => {
    assert.equal((await request(rp, 'GET', undefined, a)).data.status, 'released');
    for (const u of [a, b]) {
      const peer = u === a ? b : a;
      const envelope = (await request(rp + '/peer-envelope', 'GET', undefined, u)).data;
      const input = { recipientKey: u.setup.roomKey, recipientKeyCommit: u.setup.keyCommit, transcript: bytes(r.transcriptHash, 32), envelope, expectedContactCommit: peer.setup.contactCommit, contactCommit: pureCircuits.contactCommit };
      const opened = await crypto.openContact(input);
      assert.equal(opened.ok, true);
      assert.equal(decodeContact(opened.contact), peer.contact);
      assert.equal((await crypto.openContact({ ...input, recipientKey: await crypto.generateRoomKey() })).ok, false);
    }
  });
  await request(room + '/leave', 'POST', { expectedVersion: 1 }, a);
  await request(rp + '/peer-envelope', 'GET', undefined, b, 409);
  await step('worker closes on-chain room', tick);
  assert.equal(await runtime.operator.roomState(event, hex(roomId)), 'closed');
  assert.equal(await midnight.revealStatus(event, r.transcriptHash), 'closed');
  report.operations = (await pool.query('SELECT i.purpose,o.status,o.effect_applied,o.transaction_id FROM operations o JOIN chain_intents i ON i.id=o.intent_id ORDER BY i.created_at')).rows;
  report.jobs = (await pool.query('SELECT kind,status,failure_code,transaction_id FROM chain_jobs ORDER BY created_at')).rows;
  assert.equal(report.operations.length, 4);
  assert.ok(report.operations.every((o: any) => o.status === 'succeeded' && o.effect_applied));
  assert.equal(report.jobs.length, 4);
  assert.ok(report.jobs.every((j: any) => j.status === 'done'));
  assert.equal(new Set([report.deploymentTransactionId, ...report.operations.map((o: any) => o.transaction_id), ...report.jobs.map((j: any) => j.transaction_id)]).size, 9);
  await tick();
  assert.deepEqual((await pool.query('SELECT kind,status,failure_code,transaction_id FROM chain_jobs ORDER BY created_at')).rows, report.jobs);
  report.checks = ['real mode rejects demo resolution', 'both participants active through verified chain operations', 'mutual match and peer chat', 'single approval cannot release', 'single envelope cannot release', 'bilateral HPKE decrypt', 'wrong recipient key rejected', 'leave immediately denies envelope access', 'on-chain closed readback', 'four applied operations', 'four completed durable jobs', 'additional worker tick is idempotent'];
  report.result = 'PASS';
} catch (e) {
  report.result = 'FAIL';
  report.error = e instanceof Error ? e.message : 'UNKNOWN_ERROR';
  console.error(e);
  process.exitCode = 1;
} finally {
  await app?.close();
  await runtime?.stop();
  await wallet?.wallet.stop();
  await db?.close();
  report.finishedAt = new Date().toISOString();
  await mkdir('reports', { recursive: true });
  await writeFile('reports/backend-real-devnet.json', JSON.stringify(report, null, 2));
  console.log(`REAL_DEVNET_${report.result}: reports/backend-real-devnet.json`);
}
process.exit(process.exitCode ?? 0);
