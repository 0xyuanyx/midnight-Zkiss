import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Api, ApiError, errorMessage, pause, type ApiProfile, type ApiMessage, type Me, type Room, type EventInfo, type Reveal } from './api';
import { decrypt, digest, encrypt, identity, saveIdentity, type Envelope } from './crypto';
import { SessionContext, emptyProfile, type Conversation, type Profile, type Session } from './session';
import type { Person, Impression } from './people';
const toPerson = (p: ApiProfile): Person => ({ id: p.id, name: p.nickname ?? '', age: p.age ?? 18, mbti: p.mbti ?? '', introduction: p.introduction ?? '', summary: p.intro ?? '', image: p.imageUrl ?? '/assets/profile-ai-example.png', example: !p.imageUrl, lines: (p.intro ?? '').split('\n'), tags: p.tags ?? [] });
const blankImpression: Impression = { image: '/assets/profile-ai-example.png', lines: [], tags: [] };
export function LiveSessionProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const pathname = useRef(location.pathname);
  pathname.current = location.pathname;
  const reading = useRef(new Set<string>());
  const [api] = useState(() => new Api());
  const bootstrap = useRef<Promise<Me> | null>(null);
  const me = useRef<Me | null>(null);
  const rooms = useRef<Room[]>([]);
  const knownRooms = useRef<Set<string> | null>(null);
  const [profile, setProfile] = useState<Profile>({ ...emptyProfile });
  const [profileCreated, setProfileCreated] = useState(false);
  const [ownImpression, setImpression] = useState<Impression>(blankImpression);
  const [people, setPeople] = useState<Person[]>([]);
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [interests, setInterests] = useState({ sent: [] as string[], received: [] as string[] });
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [pendingMatch, setPendingMatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const photo = useRef<File | null>(null);
  const locked = useRef(false);
  const revealCache = useRef(new Map<string, Partial<Conversation>>());
  const refreshLock = useRef<Promise<void> | null>(null);
  const approval = useRef(new Set<string>());
  const proving = useRef(new Set<string>());
  const alive = useRef(true);
  const adopt = useCallback((value: Me, hydrate = false) => {
    me.current = value; api.csrf = value.csrfToken; api.eventId = value.eventId;
    setProfileCreated(Boolean(value.profile.intro));
    setImpression({ ...blankImpression, image: value.profile.imageUrl ?? blankImpression.image, example: !value.profile.imageUrl, lines: (value.profile.intro ?? '').split('\n'), tags: value.profile.tags ?? [] });
    if (hydrate) setProfile({ ...emptyProfile, nickname: value.profile.nickname ?? '', age: String(value.profile.age ?? ''), gender: value.profile.gender === 'female' ? '여성' : value.profile.gender === 'male' ? '남성' : '', mbti: value.profile.mbti ?? '', introduction: value.profile.introduction ?? '', photoReady: false });
  }, [api]);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError('');
    try { await refreshLock.current?.catch(() => {}); await action(); return true; } catch (e) { setError(errorMessage(e)); return false; }
    finally { locked.current = false; setBusy(false); }
  };
  async function chain(purpose: 'admission' | 'reveal_approval', fields: object) {
    if (me.current?.mode !== 'demo') throw new ApiError('WALLET_REQUIRED');
    const intent = await api.event<{ id: string }>('/chain-intents', 'POST', { purpose, ...fields });
    await api.event(`/demo/chain-intents/${intent.id}/resolution`, 'POST', { outcome: 'succeeded' });
  }
  async function advanceReveal(room: Room): Promise<Partial<Conversation>> {
    if (!room.revealRequestId) return {};
    let r = await api.event<Reveal>(`/reveal-requests/${room.revealRequestId}`);
    const live = ['collecting', 'requested', 'awaiting_chain', 'authorized', 'released'].includes(r.status);
    if (!live) return { revealStatus: r.status };
    const cached = revealCache.current.get(r.id);
    if (r.status === 'released' && cached) return cached;
    const local = await identity(me.current!.participantId);
    if (r.status === 'collecting' && !r.myMaterialReady) {
      // Demo room commitments only. Real Compact commitments require the wallet/prover bridge.
      if (me.current!.mode === 'real') {
        if (!local.contact) throw new ApiError('KEYS_MISSING');
        const sns = await decrypt(local.contact, local, local.contact.contextHash);
        const client = await import('../midnight/client');
        r = await api.event<Reveal>(`/reveal-requests/${r.id}/room-material`, 'PUT', await client.material(me.current!.participantId, r, sns));
      } else {
      const roomKey = await identity(`${me.current!.participantId}:${r.id}`, true);
      r = await api.event<Reveal>(`/reveal-requests/${r.id}/room-material`, 'PUT', { slot: await digest(local.salt + room.id), roomPublicKey: roomKey.publicKey, keyCommit: await digest(roomKey.publicKey), contactCommit: local.commitment });
      }
    }
    if (r.status === 'awaiting_chain' && r.myDecision === 'accepted' && !approval.current.has(r.id)) {
      if (me.current!.mode === 'real') {
        if (!proving.current.has(r.id)) {
          proving.current.add(r.id);
          const snapshot = r;
          void import('../midnight/client').then(client => client.approve(api, me.current!.participantId, snapshot)).then(() => approval.current.add(snapshot.id)).catch(e => { setError(errorMessage(e)); });
        }
        return { consent: { mine: true, partner: false }, revealStatus: 'awaiting_chain' };
      }
      await chain('reveal_approval', { revealRequestId: r.id, transcriptHash: r.transcriptHash });
      approval.current.add(r.id);
      r = await api.event<Reveal>(`/reveal-requests/${r.id}`);
    }
    if (r.status === 'authorized' && !r.myEnvelopeReady && r.peerEncryptionKey && local.contact) {
      const sns = await decrypt(local.contact, local, local.contact.contextHash);
      const envelope = me.current!.mode === 'real' ? await (await import('../midnight/client')).envelope(me.current!.participantId, r) : await encrypt(sns, r.peerEncryptionKey.publicKey, r.transcriptHash!, r.peerEncryptionKey.version);
      r = await api.event<Reveal>(`/reveal-requests/${r.id}/my-envelope`, 'PUT', { expectedVersion: r.version, transcriptHash: r.transcriptHash, envelope });
    }
    let peerSns: string | undefined;
    if (r.status === 'released') {
      const envelope = await api.event<Envelope>(`/reveal-requests/${r.id}/peer-envelope`);
      peerSns = me.current!.mode === 'real' ? await (await import('../midnight/client')).open(me.current!.participantId, r, envelope) : await decrypt(envelope, await identity(`${me.current!.participantId}:${r.id}`), r.transcriptHash!);
    }
    const result = { consent: { mine: r.myDecision === 'accepted', partner: r.status === 'released' && Boolean(peerSns) }, revealStatus: r.status, peerSns };
    if (r.status === 'released') revealCache.current.set(r.id, result);
    return result;
  }
  const refresh = useCallback((full = true): Promise<void> => {
    if (refreshLock.current) return refreshLock.current;
    const task = (async () => {
      if (me.current?.admissionStatus !== 'active') return;
      const [feed, sent, received, list, info] = await Promise.all([
        full ? api.all<{ profile: ApiProfile }>('/feed') : Promise.resolve([]),
        full ? api.all<{ target: ApiProfile }>('/me/likes?direction=sent') : Promise.resolve([]),
        full ? api.all<{ source: ApiProfile }>('/me/likes?direction=received') : Promise.resolve([]),
        api.all<Room>('/conversations'), full ? api.event<EventInfo>('') : Promise.resolve(null),
      ]);
      const active = list.filter(r => r.status === 'active' && r.peer.profile);
      const next: Record<string, Conversation> = {};
      for (const room of active) {
        const messages: ApiMessage[] = []; let sequence = 0; let more = true;
        while (more) {
          const page = await api.event<{ items: ApiMessage[]; nextAfterSequence: number; hasMore: boolean }>(`/conversations/${room.id}/messages?limit=100&afterSequence=${sequence}`);
          messages.push(...page.items); sequence = page.nextAfterSequence; more = page.hasMore;
        }
        let reveal: Partial<Conversation> = {};
        try { reveal = await advanceReveal(room); } catch (e) { if (!(e instanceof ApiError && e.code === 'VERSION_CONFLICT')) setError(errorMessage(e)); }
        next[room.peer.profile!.id] = { messages: messages.map(m => ({ id: m.id, author: m.sender === 'self' ? 'me' : 'partner', text: m.text })), consent: { mine: false, partner: false }, unreadCount: room.unreadCount, canSend: room.allowedActions.includes('send_message'), canRequestReveal: room.allowedActions.includes('request_reveal'), ...reveal };
      }
      if (!alive.current) return;
      const profiles = [...feed.map(f => f.profile), ...sent.map(l => l.target), ...received.map(l => l.source), ...active.map(r => r.peer.profile!)];
      setPeople(current => [...new Map([...(full ? [] : current), ...profiles.map(toPerson)].map(p => [p.id, p])).values()]);
      if (full) setInterests({ sent: sent.map(l => l.target.id), received: received.map(l => l.source.id) });
      setConversations(next); if (info) setEvent(info); rooms.current = active;
      if (knownRooms.current) {
        const added = active.find(r => !knownRooms.current!.has(r.id));
        if (added) setPendingMatch(added.peer.profile!.id);
      }
      knownRooms.current = new Set(active.map(r => r.id));
    })().finally(() => { refreshLock.current = null; });
    refreshLock.current = task; return task;
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try { const value = await (bootstrap.current ??= api.request<Me>('/me')); if (!alive.current) return; adopt(value, true);
        try { const key = await identity(value.participantId); if (key.contact) { const snsId = await decrypt(key.contact, key, key.contact.contextHash); if (alive.current) setProfile(p => ({ ...p, snsId })); } } catch { /* A new tab may not have SNS keys. */ }
        await refresh(); }
      catch (e) { if (!(e instanceof ApiError && e.status === 401)) setError(errorMessage(e)); }
      finally { if (alive.current) setLoading(false); }
    })();
    const timer = setInterval(() => { if ((!document.hidden || rooms.current.some(room => room.revealRequestId)) && !locked.current) void refresh(['/home', '/likes'].includes(pathname.current)).catch(e => setError(errorMessage(e))); }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [api, adopt, refresh]);
  const join = () => run(async () => {
    if (!me.current) {
      const key = await identity('pending', true);
      const value = await api.request<Me>('/sessions', 'POST', { devicePublicKey: key.publicKey });
      if (value.devicePublicKey === key.publicKey) {
        saveIdentity(value.participantId, key);
        sessionStorage.removeItem('zkiss.identity.v1:pending');
      }
      adopt(value, true);
    }
    setEvent(await api.event<EventInfo>(''));
    if (me.current!.admissionStatus !== 'active') throw new ApiError('ADMISSION_REQUIRED');
    await refresh();
  });
  const analyze = () => run(async () => {
    if (!me.current || me.current.admissionStatus !== 'active') throw new ApiError('SESSION_REQUIRED');
    if (!photo.current) throw new ApiError('PHOTO_REQUIRED');
    const saved = await api.event<ApiProfile>('/me/profile', 'PUT', { expectedVersion: me.current.profile.version, nickname: profile.nickname.trim(), age: Number(profile.age), gender: profile.gender === '여성' ? 'female' : 'male', mbti: profile.mbti.toUpperCase(), introduction: profile.introduction.trim() });
    me.current.profile = saved;
    if (event?.features.snsReveal && profile.snsId.trim()) {
      const local = await identity(me.current.participantId);
      const commitment = await digest(local.salt + profile.snsId.trim());
      const ownerEnvelope = await encrypt(profile.snsId.trim(), local.publicKey, commitment, me.current.contact.keyVersion);
      me.current.contact = await api.event('/me/contact-vault', 'PUT', { expectedVersion: me.current.contact.version, commitment, ownerEnvelope });
      saveIdentity(me.current.participantId, { ...local, contact: ownerEnvelope, commitment });
    }
    const data = new FormData(); data.append('expectedVersion', String(saved.version)); data.append('photo', photo.current);
    const job = await api.event<{ id: string }>('/me/ai-jobs', 'POST', data);
    photo.current = null;
    for (let n = 0; n < 210; n++) {
      const result = await api.event<{ status: string; failureCode: string }>(`/me/ai-jobs/${job.id}`);
      if (result.status === 'failed') throw new ApiError(result.failureCode);
      if (result.status === 'succeeded') { adopt(await api.request<Me>('/me')); return; }
      await pause();
    }
    throw new ApiError('AI_UNAVAILABLE');
  });
  const publish = () => run(async () => {
    await api.event('/me/profile/publication', 'POST', { expectedVersion: me.current!.profile.version });
    adopt(await api.request<Me>('/me')); await refresh();
  });
  const roomFor = (id: string) => { const room = rooms.current.find(r => r.peer.profile?.id === id); if (!room) throw new ApiError('CONVERSATION_CLOSED'); return room; };
  const matchedIds = Object.keys(conversations);
  const state: Session = {
    scene: undefined, profilePublished: me.current?.profile.status === 'published', profile, setProfile, profileCreated, setProfileCreated, ownImpression, people,
    participantCount: event?.participantCount ?? 0, eventName: event?.name ?? 'ZKiss', mode: me.current?.mode ?? '', aiMode: event?.aiMode ?? '', loading, busy, error,
    interests, matchedIds, matched: matchedIds.length > 0, conversations, pendingMatch, dismissMatch: () => setPendingMatch(null), join, analyze, publish,
    selectPhoto: file => { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { photo.current = null; setProfile(p => ({ ...p, photoReady: false })); setError('5MB 이하의 PNG, JPEG, WebP 사진을 선택해 주세요.'); return; } photo.current = file; setError(''); setProfile(p => ({ ...p, photoReady: true })); },
    sendInterest: id => run(async () => { await api.event('/likes', 'POST', { targetProfileId: id }); await refresh(); }),
    sendMessage: (id, text) => run(async () => {
      const message = await api.event<ApiMessage>(`/conversations/${roomFor(id).id}/messages`, 'POST', { text, clientMessageId: crypto.randomUUID() });
      setConversations(current => ({ ...current, [id]: { ...current[id], messages: [...current[id].messages.filter(m => m.id !== message.id), { id: message.id, author: 'me', text: message.text }] } }));
    }),
    markRead: id => { const room = roomFor(id); if (reading.current.has(id)) return; reading.current.add(id); void api.event(`/conversations/${room.id}/read`, 'PUT', { throughSequence: room.lastSequence }).then(() => setConversations(current => ({ ...current, [id]: { ...current[id], unreadCount: 0 } }))).catch(e => setError(errorMessage(e))).finally(() => reading.current.delete(id)); },
    updateConversation: () => {},
    requestReveal: (id, cancel = false) => run(async () => {
      const room = roomFor(id);
      let r = room.revealRequestId ? await api.event<Reveal>(`/reveal-requests/${room.revealRequestId}`) : null;
      if (!r || ['cancelled', 'rejected', 'expired'].includes(r.status)) {
        await api.event(`/conversations/${room.id}/reveal-requests`, 'POST', { expectedVersion: room.version, ownContactVersion: me.current!.contact.version, consent: true });
      } else {
        await api.event(`/reveal-requests/${r.id}/decisions`, 'POST', { expectedVersion: r.version, transcriptHash: r.transcriptHash, action: cancel ? 'cancel' : 'accept' });
      }
      await refresh();
    }),
  };
  return <SessionContext.Provider value={state}>{me.current?.mode === 'demo' && <aside className="integration-mode" role="note">테스트 모드{event?.aiMode === 'demo' ? ' · 예시 프로필' : ''}</aside>}{loading ? <main className="page-content" role="status">행사 정보를 불러오고 있어요…</main> : !me.current && !['/', '/preview'].includes(location.pathname) ? <Navigate to="/" replace /> : children}{error && <div className="api-error" role="alert">{error}<button onClick={() => setError('')} aria-label="오류 닫기">×</button></div>}</SessionContext.Provider>;
}
