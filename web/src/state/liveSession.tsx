import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, eventPath as E, eventId, restoreSession, setCsrf, type LiveMe, type FeedItem, type PublicProfile, type Room, type Page, type Message as ApiMessage } from '../liveApi';
import { SessionContext, type Session, type Profile, type Conversation } from './session';
import type { Person } from './people';

type Event = { name: string; mode: string; aiMode: string; aiReady: boolean; participantCount: number; features?: { snsReveal: boolean } };
type MidnightFlow = ReturnType<typeof import('../midnight-flow')['createMidnightFlow']>;
type Like = { id: string; source?: PublicProfile; target?: PublicProfile; state: string };
const blank: Profile = { nickname: '', age: '', gender: '', mbti: '', snsId: '', introduction: '', photoReady: false };
const person = (p: PublicProfile): Person => ({ id: p.id, name: p.nickname, age: p.age, mbti: p.mbti ?? '', introduction: p.introduction ?? '', image: '', lines: [p.intro], tags: p.tags ?? [], summary: p.intro });
async function pages<T>(path: string): Promise<T[]> {
  const items: T[] = []; let cursor: string | null = null;
  do { const page: Page<T> = await api(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return items;
}
async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 1000)); }
  throw new Error('처리가 지연되고 있어요. 잠시 후 다시 시도해 주세요.');
}

/** A photo is uploaded once. The server retries the same job while it remains processing. */
export async function waitForAiJob(
  check: () => Promise<{ status: string }>,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
) {
  for (;;) {
    const result = await check();
    if (result.status === 'succeeded') return;
    if (result.status === 'failed') throw new Error('AI_ANALYSIS_FAILED');
    await pause(1000);
  }
}
export function LiveSessionProvider({ children }: { children: ReactNode; scene?: string }) {
  const navigate = useNavigate(), location = useLocation();
  const [me, setMe] = useState<LiveMe | null>(null), [event, setEvent] = useState<Event | null>(null);
  const [profile, setProfile] = useState<Profile>(blank), [photo, setPhoto] = useState<File | null>(null);
  const [people, setPeople] = useState<Person[]>([]), [interests, setInterests] = useState({ sent: [] as string[], received: [] as string[] });
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [rooms, setRooms] = useState<Room[]>([]), [pendingMatch, setPendingMatch] = useState<string | null>(null);
  const [booting, setBooting] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyRef = useRef(false), previousMatches = useRef<Set<string> | null>(null);
  const meRef = useRef(me); meRef.current = me;
  const flowRef = useRef<{ owner: string; flow: Promise<MidnightFlow> } | null>(null);
  const [chainBusy, setChainBusy] = useState(false);
  const refreshGeneration = useRef(0);
  const bootComplete = useRef(false);
  const revealGeneration = useRef(new Map<string, number>());
  const currentRooms = useRef<Room[]>([]);
  const nextRevealGeneration = (peer: string) => { const next = (revealGeneration.current.get(peer) ?? 0) + 1; revealGeneration.current.set(peer, next); return next; };
  const getFlow = () => {
    const current = meRef.current;
    if (!current) throw Error('SESSION_REQUIRED');
    if (flowRef.current?.owner !== current.participantId) flowRef.current = { owner: current.participantId, flow: import('../midnight-flow').then(m => m.createMidnightFlow(current)) };
    return flowRef.current.flow;
  };
  const route = useRef(location.pathname); route.current = location.pathname;
  const messageKeys = useRef(new Map<string, { text: string; id: string }>());
  const refreshMe = async () => { const value = await restoreSession(); meRef.current = value; setMe(value); return value; };
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const [feed, sent, received, roomItems, info] = await Promise.all([
      pages<FeedItem>(`${E}/feed`), pages<Like>(`${E}/me/likes?direction=sent`), pages<Like>(`${E}/me/likes?direction=received`), pages<Room>(`${E}/conversations`), api<Event>(E),
    ]);
    if (generation !== refreshGeneration.current) return;
    const map = new Map<string, Person>();
    feed.forEach(item => map.set(item.id, person({ ...item.profile, id: item.id })));
    [...sent, ...received].forEach(item => { const p = item.source ?? item.target; if (p) map.set(item.id, person({ ...p, id: item.id })); });
    const activeRooms = roomItems.filter(r => r.origin === 'mutual_like' && r.peer.profile);
    activeRooms.forEach(r => { const p = r.peer.profile!; map.set(p.id, person(p)); });
    const matched = new Set(activeRooms.map(r => r.peer.profile!.id));
    const newlyMatched = [...matched].find(id => previousMatches.current && !previousMatches.current.has(id));
    if (newlyMatched) setPendingMatch(newlyMatched);
    previousMatches.current = matched;
    setPeople([...map.values()]); setInterests({ sent: sent.map(x => x.id), received: received.map(x => x.id) }); setRooms(activeRooms); currentRooms.current = activeRooms; setEvent(info);
    const peerId = route.current.split('/')[2];
    const updates: Record<string, Conversation> = {};
    for (const room of activeRooms) {
      const id = room.peer.profile!.id;
      const messages: ApiMessage[] = [];
      if (id === peerId) {
        let after = 0, more = true;
        while (more) { const page = await api<{items: ApiMessage[]; nextAfterSequence: number; hasMore: boolean}>(`${E}/conversations/${room.id}/messages?limit=100&afterSequence=${after}`); messages.push(...page.items); after = page.nextAfterSequence; more = page.hasMore; }
      }
      updates[id] = { messages: messages.length ? messages.map(m => ({ id: m.id, author: m.sender === 'self' ? 'me' : 'partner', text: m.text })) : room.lastMessage ? [{ id: 'latest', author: 'partner', text: room.lastMessage.text }] : [], consent: { mine: false, partner: false }, revealAvailable: info.mode === 'real' && room.allowedActions.includes('request_reveal'), unreadCount: room.unreadCount };
    }
    if (generation !== refreshGeneration.current) return;
    setConversations(previous => Object.fromEntries(Object.entries(updates).map(([id, value]) => {
      const room = activeRooms.find(r => r.peer.profile?.id === id);
      const old = previous[id]?.reveal;
      const retain = room?.status === 'active' && room.revealRequestId && old?.id === room.revealRequestId && (!room.chatUntil || Date.parse(room.chatUntil) > Date.now());
      return [id, { ...value, reveal: retain ? old : null, consent: retain ? previous[id].consent : value.consent }];
    })));
    const currentRoom = activeRooms.find(r => r.peer.profile!.id === peerId);
    if (bootComplete.current && info.mode === 'real' && currentRoom?.revealRequestId && meRef.current) {
      const revealVersion = nextRevealGeneration(peerId);
      const owner = meRef.current.participantId;
      const isCurrent = () => revealGeneration.current.get(peerId) === revealVersion && meRef.current?.participantId === owner && currentRooms.current.some(r => r.id === currentRoom.id && r.status === 'active' && r.revealRequestId === currentRoom.revealRequestId);
      setChainBusy(true);
      // Proof can take minutes. Keep the normal refresh loop alive to observe revocation.
      void (async () => {
        try {
          const reveal = await (await getFlow()).advanceReveal(currentRoom);
          if (!isCurrent()) return;
          setConversations(previous => ({ ...previous, [peerId]: { ...(previous[peerId] ?? updates[peerId]), reveal, consent: { mine: !!reveal?.peerContact && reveal.status === 'released', partner: !!reveal?.peerContact && reveal.status === 'released' } } }));
        } catch (cause) {
          if (!isCurrent()) return;
          const message = cause instanceof Error ? cause.message : 'MIDNIGHT_FAILED';
          setConversations(previous => {
            const current = previous[peerId]; if (!current) return previous;
            return { ...previous, [peerId]: { ...current, consent: {mine:false,partner:false}, reveal: { id: currentRoom.revealRequestId!, status: 'error', myDecision: 'pending', peerDecision: 'pending', error: message } } };
          });
        } finally { if (revealGeneration.current.get(peerId) === revealVersion) setChainBusy(false); }
      })();
    }

  }, []);
  useEffect(() => { let mounted = true; void (async () => {
    try {
      const info = await api<Event>(E); if (!mounted) return; setEvent(info);
      const current = await restoreSession(); if (!mounted) return; meRef.current = current; setMe(current);
      if (current) setProfile({ ...blank, nickname: current.profile.nickname ?? '', age: String(current.profile.age ?? ''), gender: current.profile.gender === 'female' ? '여성' : current.profile.gender === 'male' ? '남성' : '', mbti: current.profile.mbti ?? '', introduction: current.profile.introduction ?? '', photoReady: !!current.profile.intro });
      if (current?.profile.status === 'published' && current.admissionStatus === 'active') await refresh();
    } catch { if (mounted) setError('서버에 연결하지 못했어요. 새로고침해 주세요.'); }
    finally { if (mounted) { bootComplete.current = true; setBooting(false); } }
  })(); return () => { mounted = false; }; }, [refresh]);
  useEffect(() => {
    if (booting || me?.profile.status !== 'published' || me.admissionStatus !== 'active') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await refresh(); } catch { if (!stopped) setError('최신 데이터를 불러오지 못했어요. 다시 연결하고 있어요.'); } if (!stopped) timer = setTimeout(poll, 8000); };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [booting, me?.profile.status, me?.admissionStatus, location.pathname, refresh]);
  useEffect(() => {
    if (booting || !event) return;
    if (!me && location.pathname !== '/') navigate('/', { replace: true });
    else if (me && ['/home','/likes','/chats','/me'].some(p => location.pathname.startsWith(p)) && me.profile.status !== 'published') navigate(me.profile.intro ? '/profile/preview' : '/profile', { replace: true });
  }, [booting, me, event, location.pathname, navigate]);
  async function run(action: () => Promise<void>, urgent = false): Promise<boolean> {
    if (!urgent && busyRef.current) return false; if (!urgent) { busyRef.current = true; setBusy(true); } setError('');
    try { await action(); return true; } catch (cause) { const code = cause instanceof Error ? cause.message : ''; setError(({ AI_UNAVAILABLE: 'AI 분석을 시작할 수 없어요. 잠시 후 다시 시도해 주세요.', AI_ANALYSIS_FAILED: '사진 분석에 실패했어요. 다른 사진으로 다시 시도해 주세요.', CONTACT_REQUIRED: '두 사람 모두 내 정보에서 SNS를 저장한 뒤 요청해 주세요.', DEVICE_STATE_MISSING: '이 기기의 참가 키를 찾을 수 없어요. 처음 참가한 브라우저에서 접속해 주세요.', RELAY_UNAVAILABLE: 'Midnight 거래 서버가 준비되지 않았어요.', VERSION_CONFLICT: '프로필이 변경됐어요. 새로고침 후 다시 시도해 주세요.' } as Record<string,string>)[code] ?? `요청을 완료하지 못했어요: ${code}`); return false; }
    finally { if (!urgent) { busyRef.current = false; setBusy(false); } }
  }
  async function enter() { await run(async () => {
    const current = me ?? await api<LiveMe>('/sessions', { method: 'POST', body: { eventId } }); setMe(current); setCsrf(current.csrfToken);
    navigate(current.profile.status === 'published' ? '/home' : current.profile.intro ? '/profile/preview' : '/profile');
  }); }
  async function analyze() { await run(async () => {
    if (!me || !photo) throw Error('사진을 선택해 주세요.');
    navigate('/analysis');
    const saved = await api<LiveMe['profile']>(`${E}/me/profile`, { method: 'PUT', body: { expectedVersion: me.profile.version, nickname: profile.nickname.trim(), age: Number(profile.age), gender: profile.gender === '여성' ? 'female' : 'male', mbti: profile.mbti || null, introduction: profile.introduction.trim() } });
    setMe({ ...me, profile: saved });
    const form = new FormData(); form.set('expectedVersion', String(saved.version)); form.set('photo', photo);
    const job = await api<{id:string}>(`${E}/me/ai-jobs`, { method: 'POST', form });
    await waitForAiJob(() => api<{status:string}>(`${E}/me/ai-jobs/${job.id}`));
    await refreshMe(); setPhoto(null); navigate('/profile/preview', { replace: true });
  }); }
  async function publish() { await run(async () => {
    let current = me; if (!current) return;
    if (current.admissionStatus !== 'active') {
      if (event?.mode === 'real') {
        await (await getFlow()).admit(); current = await refreshMe();
      } else {
      if (event?.mode !== 'demo') throw Error('행사 정보를 확인하지 못했어요.');
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
      await api(`${E}/midnight/ticket`, { method: 'POST', body: { ticketLeaf: current.ticket.leaf ?? hex } });
      await waitUntil(async () => { current = await refreshMe(); return current?.ticket.status === 'issued'; });
      const storageKey = `zkiss-demo-device:${eventId}`;
      const key = localStorage.getItem(storageKey) ?? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))); localStorage.setItem(storageKey,key);
      const intent = await api<{id:string}>(`${E}/chain-intents`, { method: 'POST', body: { purpose: 'admission', devicePublicKey: key, deviceKeyVersion: 1 } });
      await api(`${E}/demo/chain-intents/${intent.id}/resolution`, { method: 'POST', body: { outcome: 'succeeded' } }); current = await refreshMe();
      }
    }
    await api(`${E}/me/profile/publication`, { method: 'POST', body: { expectedVersion: current!.profile.version } });
    // The original flow collects the SNS ID with the profile; encrypt it on this device once admitted.
    const contact = profile.snsId.trim();
    if (event?.mode === 'real' && contact && !current?.contact?.configured) {
      try { await (await getFlow()).saveContact(contact); } catch { /* It can still be saved from 내 정보. */ }
    }
    await refreshMe(); await refresh(); navigate('/home');
  }); }
  function sendInterest(id: string) { void run(async () => { await api(`${E}/likes`, { method: 'POST', body: { targetProfileId: id }, idempotencyKey: `like-${id}` }); await refresh(); }); }
  async function sendMessage(peerId: string, text: string) { return run(async () => {
    const room = rooms.find(r => r.peer.profile?.id === peerId); if (!room) throw Error('대화방을 찾을 수 없어요.');
    const prior = messageKeys.current.get(peerId); const pending = prior?.text === text ? prior : { text, id: crypto.randomUUID() }; messageKeys.current.set(peerId,pending);
    await api(`${E}/conversations/${room.id}/messages`, { method: 'POST', body: { clientMessageId: pending.id, text }, idempotencyKey: pending.id }); messageKeys.current.delete(peerId); await refresh();
  }); }
  const saveContact = (contact: string) => run(async () => {
    await (await getFlow()).saveContact(contact); await refreshMe();
    setProfile(p => ({...p, snsId: contact.trim()})); await refresh();
  });
  const revealAction = (peerId: string, action: 'request' | 'accept' | 'reject' | 'cancel' | 'retry') => run(async () => {
    const room = rooms.find(r => r.peer.profile?.id === peerId); if (!room) throw Error('대화방을 찾을 수 없어요.');
    const generation = nextRevealGeneration(peerId);
    const flow = await getFlow();
    const reveal = action === 'request' ? await flow.requestReveal(room) : action === 'retry' ? await flow.advanceReveal(room, true) : await flow.decideReveal(room, action);
    if (revealGeneration.current.get(peerId) !== generation) return;
    setConversations(previous => ({...previous, [peerId]: {...previous[peerId], reveal, consent: {mine: !!reveal?.peerContact && reveal.status==='released', partner: !!reveal?.peerContact && reveal.status==='released'}}}));
    await refresh();
  }, action === 'cancel' || action === 'reject');
  const state: Session = { live: true, midnightAvailable: event?.mode === 'real', busy, chainBusy, error, saveContact, contactConfigured: !!me?.contact?.configured, requestReveal: peer => revealAction(peer,'request'), decideReveal: (peer,action) => revealAction(peer,action), retryReveal: peer => revealAction(peer,'retry'), enter, analyze, publish, sendMessage, setPhoto: file => { setPhoto(file); setProfile(p => ({...p, photoReady: !!file})); }, participantCount: event?.participantCount ?? 0,
    profile, setProfile, profileCreated: !!me?.profile.intro, setProfileCreated: () => {}, people, ownImpression: { image: '', lines: [me?.profile.intro ?? ''], tags: [] },
    interests, conversations, matchedIds: rooms.map(r => r.peer.profile!.id), matched: rooms.length > 0, pendingMatch, dismissMatch: () => setPendingMatch(null), sendInterest, updateConversation: () => {}, scene: undefined };
  if (booting) return <main className="screen page-content" role="status">행사와 세션을 확인하고 있어요…</main>;
  return <SessionContext.Provider value={state}><div className="api-app">{event && <p className="api-status">{event.aiMode === 'real' ? '사진 분석 · Gemini' : '사진 분석 · 데모'}{event.mode === 'demo' ? ' / Midnight 참가 확인 · 데모' : ''}</p>}{error && <p className="api-error" role="alert">{error}</p>}{children}</div></SessionContext.Provider>;
}
