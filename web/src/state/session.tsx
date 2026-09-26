import { createContext, useContext, useState, type ReactNode } from 'react';
import { findPerson, people, ownImpression } from './people';
import { LiveSessionProvider } from './live-session';

export interface Profile {
  nickname: string;
  age: string;
  gender: string;
  mbti: string;
  snsId: string;
  introduction: string;
  photoReady: boolean;
}

export interface Message { id: string; author: 'me' | 'partner'; text: string }
export type Consent = { mine: boolean; partner: boolean };
export const canReveal = (consent: Consent) => consent.mine && consent.partner;

export const sampleProfile: Profile = { nickname: '유진', age: '26', gender: '여성', mbti: 'ENFP', snsId: '@yujin', introduction: '새로운 사람과 가벼운 대화를 좋아해요.', photoReady: true };
export const emptyProfile: Profile = { nickname: '', age: '', gender: '', mbti: '', snsId: '', introduction: '', photoReady: false };
export const initialMessages: Message[] = [
  { id: 'hello', author: 'partner', text: '안녕하세요! 오늘 행사에서\n어떤 부스가 가장 기억에 남았어요?' },
  { id: 'reply', author: 'me', text: '저는 전시 부스가 제일 좋았어요 🙂\n라임님은요?' },
  { id: 'similar', author: 'partner', text: '저도요! 취향이 비슷한 것 같아서\n더 이야기해 보고 싶어요.' },
];
export const sharedMessages: Message[] = [
  ...initialMessages,
  { id: 'request', author: 'me', text: '나랑 스껄할래? 🤭\nSNS를 서로 공개해 볼까요?' },
  { id: 'agree', author: 'partner', text: '좋아요! 저도 동의할게요.' },
];

function useSessionState(scene?: string) {
  const [profile, setProfile] = useState<Profile>(scene && scene !== 'profile' && scene !== 'entry' ? { ...sampleProfile } : { ...emptyProfile });
  const [profileCreated, setProfileCreated] = useState(Boolean(scene && ['profile-preview', 'home', 'likes', 'chats', 'matched', 'room', 'shared'].includes(scene)));
  const fixtureMatch = Boolean(scene && ['matched', 'room', 'shared'].includes(scene));
  const [interests, setInterests] = useState(() => ({
    sent: fixtureMatch || scene === 'mutual-match' || scene === 'home-sent' ? ['lime'] : scene === 'likes-sent' ? ['lime', 'mocha'] : [],
    received: fixtureMatch || scene === 'mutual-match' ? ['lime', 'mocha'] : scene === 'likes-sent' || scene === 'chats' || scene === 'likes-empty' ? [] : ['mocha'],
  }));
  const [conversations, setConversations] = useState<Record<string, Conversation>>((): Record<string, Conversation> => fixtureMatch ? {
    lime: { messages: scene === 'shared' ? sharedMessages : initialMessages, consent: { mine: scene === 'shared', partner: scene === 'shared' }, unreadCount: scene === 'matched' ? 1 : 0 },
  } : {});
  const [pendingMatch, setPendingMatch] = useState<string | null>(scene === 'mutual-match' ? 'lime' : null);
  const matchedIds = interests.sent.filter(id => interests.received.includes(id));
  async function sendInterest(id: string) {
    if (!findPerson(id) || interests.sent.includes(id)) return false;
    if (interests.received.includes(id)) setPendingMatch(id);
    setInterests(current => current.sent.includes(id) ? current : { ...current, sent: [...current.sent, id] });
    return true;
  }
  function updateConversation(id: string, update: (current: Conversation) => Conversation) {
    if (!matchedIds.includes(id)) return;
    setConversations(current => ({ ...current, [id]: update(current[id] ?? emptyConversation) }));
  }
  return { profilePublished: profileCreated, people, ownImpression, participantCount: people.length, loading: false, busy: false, error: '', eventName: 'MIDNIGHT SEOUL', mode: 'preview' as string, aiMode: 'demo' as string,
    selectPhoto: (_file: File) => setProfile(current => ({ ...current, photoReady: true })),
    join: async () => true, analyze: async () => true, publish: async () => true,
    sendMessage: async (id: string, text: string) => { updateConversation(id, current => ({ ...current, messages: [...current.messages, { id: crypto.randomUUID(), author: 'me', text }] })); return true; },
    markRead: (id: string) => updateConversation(id, current => ({ ...current, unreadCount: 0 })),
    requestReveal: async (_id: string, _cancel = false) => false,
    pendingMatch, dismissMatch: () => setPendingMatch(null), profile, setProfile, profileCreated, setProfileCreated, matched: matchedIds.length > 0, matchedIds, interests, sendInterest, conversations, updateConversation, scene };
}

export interface Conversation { messages: Message[]; consent: Consent; unreadCount: number; revealStatus?: string; peerSns?: string; canRequestReveal?: boolean; canSend?: boolean }
export const emptyConversation: Conversation = { messages: [], consent: { mine: false, partner: false }, unreadCount: 0 };

export type Session = ReturnType<typeof useSessionState>;
export const SessionContext = createContext<Session | null>(null);

/** In-memory demo state only. Photos, messages, and identity are never persisted. */
export function SessionProvider({ children, scene }: { children: ReactNode; scene?: string }) {
  if (!scene) return <LiveSessionProvider>{children}</LiveSessionProvider>;
  return <PreviewSessionProvider scene={scene}>{children}</PreviewSessionProvider>;
}
function PreviewSessionProvider({ children, scene }: { children: ReactNode; scene: string }) {
  const state = useSessionState(scene);
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is required');
  return session;
}
