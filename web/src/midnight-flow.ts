import { api, type LiveMe, type Room } from './liveApi';
import type { PreparedIntent } from '../../midnight/src/adapter-contract';
import type { Envelope } from '../../midnight/src/envelope';

export type RevealView = { id: string; status: string; myDecision: string; peerDecision: string; peerContact?: string; ownContact?: string; error?: string };
export type RevealRecord = RevealView & { version: number; conversationId: string; transcriptHash: string | null; terms: string | null; chainRoomId: string; eventScope: string; network: string; contractAddress: string; expiresAt: string; myContactVersion: number; peerContactVersion: number; myMaterialReady: boolean; myEnvelopeReady: boolean; peerEncryptionKey: { publicKey: string; version: number } | null };
export type ChainIntent = PreparedIntent & { id: string; operationId: string; mode: string; expiresAt: string; [key: string]: unknown };
type Operation = { status: string; effectApplied: boolean; failureCode?: string };
export interface FlowRuntime {
  ticket(): Promise<{ ticketLeaf: string; admissionNullifier: string; devicePublicKey: string; deviceKeyVersion: number }>;
  saveContact(contact: string): Promise<{ commitment: string; ownerEnvelope: unknown }>;
  getContact(): Promise<string>;
  roomMaterial(reveal: RevealRecord): Promise<unknown>;
  recoverSubmission?(intent: ChainIntent): Promise<{ transactionId: string } | null>;
  submitAdmission(intent: ChainIntent): Promise<{ transactionId: string }>;
  submitApproval(intent: ChainIntent, reveal: RevealRecord): Promise<{ transactionId: string }>;
  sealPeer(reveal: RevealRecord): Promise<unknown>;
  openPeer(reveal: RevealRecord, envelope: Envelope): Promise<string>;
}
type Journal = { key: string; intent?: ChainIntent; submitting?: boolean; transactionId?: string; registered?: boolean };
type Dependencies = { request?: typeof api; runtime?: () => Promise<FlowRuntime>; storage?: Storage };
const running = new Set<string>();
const views = new Map<string, RevealView>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Durable journals contain public intent/transaction metadata only. Secrets belong to the runtime vault. */
export function createMidnightFlow(me: LiveMe, dependencies: Dependencies = {}) {
  const request = dependencies.request ?? api;
  const storage = dependencies.storage ?? localStorage;
  const E = `/events/${encodeURIComponent(me.eventId)}`;
  const scope = `zkiss:flow:v1:${me.eventId}:${me.participantId}:`;
  let runtimePromise: Promise<FlowRuntime> | undefined;
  const runtime = (): Promise<FlowRuntime> => runtimePromise ??= dependencies.runtime ? dependencies.runtime() : import('./midnight/runtime').then(m => m.createBrowserRuntime({ eventId: me.eventId, participantId: me.participantId, ticketLeaf: me.ticket.leaf }));
  const read = (name: string): Journal => { const raw = storage.getItem(scope + name); return raw ? JSON.parse(raw) : { key: crypto.randomUUID() }; };
  const write = (name: string, value: Journal) => storage.setItem(scope + name, JSON.stringify(value));
  const freshMe = async () => {
    const current = await request<LiveMe>('/me');
    if (current.participantId !== me.participantId || current.eventId !== me.eventId) throw new Error('SESSION_CHANGED');
    return current;
  };
  async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = scope + name;
    if (running.has(key)) throw new Error('MIDNIGHT_OPERATION_IN_PROGRESS');
    running.add(key);
    try {
      if (!navigator.locks) throw new Error('SECURE_BROWSER_LOCKS_REQUIRED');
      return await navigator.locks.request(key, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('MIDNIGHT_OPERATION_IN_PROGRESS');
        return fn();
      });
    } finally { running.delete(key); }
  }
  async function transact(name: string, body: unknown, submit: (intent: ChainIntent) => Promise<{ transactionId: string }>, allowSafeReproof = false): Promise<boolean> {
    const journal = read(name);
    write(name, journal); // Save the idempotency key before any network side effect.
    if (!journal.intent) {
      journal.intent = await request<ChainIntent>(E + '/chain-intents', { method: 'POST', body, idempotencyKey: journal.key });
      if (journal.intent.mode !== 'real') throw new Error('REAL_MIDNIGHT_REQUIRED');
      write(name, journal);
    }
    const intent = journal.intent;
    if (!journal.transactionId) {
      if (journal.submitting) {
        try {
          const recovered = await (await runtime()).recoverSubmission?.(intent);
          if (!recovered) throw new Error('TRANSACTION_OUTCOME_UNKNOWN_DO_NOT_RESUBMIT');
          journal.transactionId = recovered.transactionId;
          write(name, journal);
        } catch (error) {
          // The runtime proves no bytes could reach the relay: its encrypted staging
          // write precedes every upload, and the relay reports absent under its lock.
          // Only a user-triggered retry may spend time proving again.
          if (!allowSafeReproof || !(error instanceof Error) || error.message !== 'SAFE_TO_REPROVE') throw error;
          journal.submitting = false;
          write(name, journal);
        }
      }
    }
    if (!journal.transactionId) {
      if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('CONSENT_EXPIRED');
      journal.submitting = true;
      write(name, journal);
      // A crash/ambiguous wallet result deliberately remains blocked instead of paying twice.
      const tx = await submit(intent);
      journal.transactionId = tx.transactionId;
      write(name, journal);
    }
    if (!journal.registered) {
      await request(E + `/chain-intents/${intent.id}/transactions`, { method: 'POST', body: { transactionId: journal.transactionId }, idempotencyKey: journal.key + ':transaction' });
      journal.registered = true;
      write(name, journal);
    }
    const operation = await request<Operation>(E + `/operations/${intent.operationId}`);
    if (['failed', 'expired', 'partial_failure'].includes(operation.status)) throw new Error(operation.failureCode ?? 'CHAIN_OPERATION_FAILED');
    return operation.status === 'succeeded' && operation.effectApplied;
  }
  const rp = (id: string) => E + `/reveal-requests/${encodeURIComponent(id)}`;
  const get = (id: string) => request<RevealRecord>(rp(id));
  const view = (r: RevealRecord): RevealView => ({ id: r.id, status: r.status, myDecision: r.myDecision, peerDecision: r.peerDecision, error: r.error });
  async function advance(room: Room, initial?: RevealRecord, allowSafeReproof = false): Promise<RevealView | null> {
    if (room.status !== 'active' || (room.chatUntil && Date.parse(room.chatUntil) <= Date.now())) return null;
    const id = initial?.id ?? room.revealRequestId;
    if (!id) return null;
    let r = initial ?? await get(id);
    if (r.conversationId !== room.id) throw new Error('REVEAL_ROOM_MISMATCH');
    let result = view(r);
    views.set(scope + room.id, result);
    if (!['released', 'cancelled', 'rejected', 'expired'].includes(r.status) && Date.parse(r.expiresAt) <= Date.now()) return { ...result, status: 'expired' };
    if (r.status === 'collecting' && !r.myMaterialReady) {
      const material = await (await runtime()).roomMaterial(r);
      r = await request<RevealRecord>(rp(id) + '/room-material', { method: 'PUT', body: material });
    }
    if (r.status === 'awaiting_chain' && r.myDecision === 'accepted' && r.peerDecision === 'accepted') {
      await transact('reveal:' + id, { purpose: 'reveal_approval', revealRequestId: id, transcriptHash: r.transcriptHash }, async intent => (await runtime()).submitApproval(intent, r), allowSafeReproof);
      r = await get(id);
    }
    if (r.status === 'authorized' && !r.myEnvelopeReady) {
      const envelope = await (await runtime()).sealPeer(r);
      // Refresh after cryptography so a concurrent cancellation cannot reuse an old version.
      r = await get(id);
      if (r.status === 'authorized' && !r.myEnvelopeReady) r = await request<RevealRecord>(rp(id) + '/my-envelope', { method: 'PUT', body: { expectedVersion: r.version, transcriptHash: r.transcriptHash, envelope } });
    }
    result = view(r);
    if (r.status === 'released') {
      const envelope = await request<Envelope>(rp(id) + '/peer-envelope');
      const contact = await (await runtime()).openPeer(r, envelope);
      const [latest, latestRoom] = await Promise.all([get(id), request<Room>(E + '/conversations/' + encodeURIComponent(room.id))]);
      result = view(latest);
      if (latest.status === 'released' && latestRoom.status === 'active' && latestRoom.revealRequestId === id && (!latestRoom.chatUntil || Date.parse(latestRoom.chatUntil) > Date.now())) result.peerContact = contact;
    }
    views.set(scope + room.id, result);
    return result;
  }
  return {
    admit: () => exclusive('admission', async () => {
      if ((await freshMe()).admissionStatus === 'active') return;
      const device = await (await runtime()).ticket();
      await request(E + '/midnight/ticket', { method: 'POST', body: { ticketLeaf: device.ticketLeaf } });
      const deadline = Date.now() + 10 * 60_000;
      while ((await freshMe()).ticket.status !== 'issued') { if (Date.now() >= deadline) throw new Error('TICKET_ISSUANCE_PENDING'); await delay(2000); }
      while (!await transact('admission', { purpose: 'admission', admissionNullifier: device.admissionNullifier, devicePublicKey: device.devicePublicKey, deviceKeyVersion: device.deviceKeyVersion }, async intent => (await runtime()).submitAdmission(intent), true)) {
        if (Date.now() >= deadline) throw new Error('CHAIN_CONFIRMATION_PENDING');
        await delay(2000);
      }
    }),
    saveContact: (contact: string) => exclusive('contact', async () => {
      if (!contact.trim()) throw new Error('CONTACT_REQUIRED');
      const current = await freshMe();
      const vault = await (await runtime()).saveContact(contact.trim());
      await request(E + '/me/contact-vault', { method: 'PUT', body: { expectedVersion: current.contact?.version ?? 0, ...vault } });
      for (const key of views.keys()) if (key.startsWith(scope)) views.delete(key);
    }),
    requestReveal: (room: Room) => exclusive('room:' + room.id, async () => {
      const current = await freshMe();
      const freshRoom = await request<Room>(E + '/conversations/' + encodeURIComponent(room.id));
      if (freshRoom.revealRequestId) {
        const existing = await get(freshRoom.revealRequestId);
        if (['collecting', 'requested', 'awaiting_chain', 'authorized', 'ready', 'released'].includes(existing.status)) return (await advance(freshRoom, existing))!;
      }
      const journal = read('request:' + room.id);
      write('request:' + room.id, journal);
      const r = await request<RevealRecord>(E + `/conversations/${room.id}/reveal-requests`, { method: 'POST', idempotencyKey: journal.key, body: { expectedVersion: freshRoom.version, ownContactVersion: current.contact?.version ?? 0, consent: true } });
      storage.removeItem(scope + 'request:' + room.id);
      return (await advance(freshRoom, r))!;
    }),
    decideReveal: (room: Room, action: 'accept' | 'reject' | 'cancel') => exclusive((action === 'accept' ? 'room:' : 'decision:') + room.id, async () => {
      if (!room.revealRequestId) throw new Error('REVEAL_NOT_FOUND');
      const r = await get(room.revealRequestId);
      const updated = await request<RevealRecord>(rp(r.id) + '/decisions', { method: 'POST', body: { expectedVersion: r.version, transcriptHash: r.transcriptHash, action } });
      views.set(scope + room.id, view(updated));
      // Publish the explicit decision immediately; the next progress poll owns proving.
      return view(updated);
    }),
    advanceReveal: async (room: Room, allowSafeReproof = false): Promise<RevealView | null> => {
      if (room.status !== 'active') { views.delete(scope + room.id); return null; }
      if (running.has(scope + 'room:' + room.id)) {
        if (!room.revealRequestId) return null;
        const latest = view(await get(room.revealRequestId));
        views.set(scope + room.id, latest);
        return latest;
      }
      return exclusive('room:' + room.id, () => advance(room, undefined, allowSafeReproof));
    },
  };
}
