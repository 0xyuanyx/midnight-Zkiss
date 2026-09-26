import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Avatar, BottomNav, Button, EmptyState, Header, PageHeading } from '../components/ui';
import { ImpressionCard } from '../components/ImpressionCard';
import { copyText } from '../state/clipboard';
import { canReveal, emptyConversation, sampleProfile, useSession } from '../state/session';

const SNS_REQUEST_MIN_MESSAGES = 4;

export function MyPage() {
  const { profile, profileCreated, ownImpression, scene } = useSession();
  const displayedProfile = profileCreated || !scene ? profile : sampleProfile;
  return <div className="screen tab-page my-profile-page">
    <Header />
    <main className="page-content" aria-label="내 정보 화면">
      <PageHeading title="내 프로필" description="상대방에게 보이는 나의 AI 인상 프로필이에요" />
      <ImpressionCard name={displayedProfile.nickname} age={displayedProfile.age} gender={displayedProfile.gender} mbti={displayedProfile.mbti} introduction={displayedProfile.introduction} impression={ownImpression} />
      <div className="my-profile-actions"><Link className="button button--dark" to="/profile">수정하기</Link></div>
    </main>
    <BottomNav active="profile" />
  </div>;
}

export function ChatsPage() {
  const { matchedIds, conversations, people } = useSession();
  return <div className="screen tab-page chats-page">
    <Header />
    <main className="page-content">
      <PageHeading title="나의 대화" description="서로의 호감에서 시작된 익명 대화" />
      {matchedIds.length > 0 ? <>
        {matchedIds.map(id => {
          const person = people.find(p => p.id === id)!;
          const conversation = conversations[id] ?? emptyConversation;
          const latest = conversation.messages.at(-1);
          return <Link className="conversation-row" to={`/chats/${id}`} key={id}>
            <Avatar name={person.name} image={person.image} />
            <span className="conversation-copy"><strong>{person.name}</strong><span>{latest ? latest.text.replaceAll('\n', ' ') : '서로 호감이 닿았어요. 먼저 인사해보세요!'}</span></span>
            {conversation.unreadCount > 0 && <span className="unread" aria-label={`읽지 않은 메시지 ${conversation.unreadCount}개`}>{conversation.unreadCount}</span>}<span className="row-arrow" aria-hidden="true">›</span>
          </Link>;
        })}
        <aside className="privacy-note"><strong>🔒 대화 중에도 개인정보는 안전해요.</strong><p>SNS는 자동으로 공개되지 않아요.<br />두 사람 모두 동의한 경우에만 확인할 수 있어요.</p></aside>
      </> : <EmptyState kind="chats" />}
    </main>
    <BottomNav active="chats" />
  </div>;
}

function SharedPanel({ peerId }: { peerId: string }) {
  const { profile, conversations, people, ownImpression, scene } = useSession();
  const { consent } = conversations[peerId] ?? emptyConversation;
  const partner = people.find(p => p.id === peerId)!;
  const [notice, setNotice] = useState('');
  // The visibility gate is enforced here as well as at the route boundary.
  if (!canReveal(consent)) return null;
  return <section className="shared-panel" aria-label="SNS 상호 공개 완료">
    <span className="success-check" aria-hidden="true">✓</span>
    <h2>서로 동의했어요</h2>
    <p>두 사람의 SNS가 공개됐어요.<br />행사가 끝난 뒤에도 대화를 이어가 보세요.</p>
    <div className="social-cards">
      {[{ name: partner.name, image: partner.image, pink: false }, { name: profile.nickname, image: ownImpression.image, pink: true }].map(person => <button key={person.name + person.pink} className="social-card" onClick={async () => {
        if (scene) { setNotice('미리보기에서는 SNS ID를 복사하지 않아요.'); return; }
        const sns = person.pink ? profile.snsId : conversations[peerId]?.peerSns;
        try { await copyText(sns ?? ''); setNotice(`${sns} 복사했어요.`); }
        catch { setNotice('복사하지 못했어요. 다시 눌러 주세요.'); }
      }}>
        <Avatar name={person.name} image={person.image} pink={person.pink} /><span>{person.name}<br />SNS ID 복사</span>
      </button>)}
    </div>
    {notice && <p className="social-notice" role="status">{notice}</p>}
  </section>;
}

function RequestPanel({ peerId }: { peerId: string }) {
  const { conversations, updateConversation, scene, requestReveal, busy } = useSession();
  const { consent } = conversations[peerId] ?? emptyConversation;
  if (!scene) {
    const c = conversations[peerId];
    if (!c?.canRequestReveal) return null;
    const active = ['collecting', 'requested', 'awaiting_chain', 'authorized'].includes(c.revealStatus ?? '');
    return <section className="request-panel" aria-live="polite"><h2>SNS 상호 공개</h2>
      <p>{['awaiting_chain', 'authorized'].includes(c.revealStatus ?? '') ? '서로의 SNS를 공개할 준비를 하고 있어요.' : c.revealStatus === 'collecting' ? '공개 요청을 준비하고 있어요.' : consent.mine ? '상대방의 동의를 기다리고 있어요.' : '두 사람 모두 동의하면 SNS를 확인할 수 있어요.'}</p>
      {!consent.mine && <Button disabled={busy || (active && c.revealStatus !== 'requested')} onClick={() => void requestReveal(peerId)}>{c.revealStatus === 'requested' ? 'SNS 공개 동의하기' : 'SNS 공개 요청하기'}</Button>}
      {active && <Button variant="outline" disabled={busy} onClick={() => void requestReveal(peerId, true)}>공개 요청 취소하기</Button>}
    </section>;
  }
  return <section className="request-panel" aria-live="polite">
    <h2>{consent.mine ? '상대방의 동의를 기다리고 있어요' : '대화를 계속 이어가고 싶나요?'}</h2>
    <p>{consent.mine ? '아직 SNS는 공개되지 않았어요. 데모에서는 상대방 동의를 재현해 다음 화면을 확인할 수 있어요.' : '서로 동의해야 SNS가 공개돼요. 먼저 요청해도 내 SNS가 바로 보이지 않아요.'}</p>
    {consent.mine ? <>
      <Button onClick={() => updateConversation(peerId, current => ({ ...current, consent: { ...current.consent, partner: true } }))}>상대방 동의 시뮬레이션</Button>
      <Button variant="outline" className="demo-cancel" onClick={() => updateConversation(peerId, current => ({ ...current, consent: { ...current.consent, mine: false } }))}>공개 요청 취소하기</Button>
    </> : <Button onClick={() => updateConversation(peerId, current => ({ ...current, consent: { ...current.consent, mine: true } }))}>SNS 공개 요청하기</Button>}
  </section>;
}

export function ChatRoomPage({ sharedRoute = false }: { sharedRoute?: boolean }) {
  const { peerId = 'lime' } = useParams();
  return <ChatRoom key={peerId} peerId={peerId} sharedRoute={sharedRoute} />;
}

function ChatRoom({ peerId, sharedRoute }: { peerId: string; sharedRoute: boolean }) {
  const { matchedIds, conversations, markRead, sendMessage, people, busy, scene } = useSession();
  const partner = people.find(p => p.id === peerId);
  const { messages, consent, unreadCount } = conversations[peerId] ?? emptyConversation;
  const matched = matchedIds.includes(peerId);
  const [draft, setDraft] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const previousMessageCount = useRef(messages.length);
  const shared = canReveal(consent);
  const snsRequestAvailable = messages.length >= SNS_REQUEST_MIN_MESSAGES || (!scene && Boolean(conversations[peerId]?.revealStatus));
  const navigate = useNavigate();

  useEffect(() => { if (matched && unreadCount > 0) markRead(peerId); }, [matched, peerId, unreadCount, markRead]);

  useEffect(() => {
    if (thread.current && (shared || messages.length > previousMessageCount.current)) {
      thread.current.scrollTop = thread.current.scrollHeight;
    }
    previousMessageCount.current = messages.length;
  }, [messages.length, shared]);

  useEffect(() => {
    if (shared && !sharedRoute) navigate(`/chats/${peerId}/shared`, { replace: true });
  }, [shared, sharedRoute, navigate, peerId]);

  if (!matched || !partner) return <Navigate to="/chats" replace />;
  if (sharedRoute && !shared) return <Navigate to={`/chats/${peerId}`} replace />;

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await sendMessage(peerId, text)) setDraft('');
  }

  return <div className={`screen chat-room ${shared ? 'chat-room--shared' : ''}`}>
    <header className="chat-header">
      <Link className="back" to="/chats/matched" aria-label="대화 목록으로">‹</Link>
      <Avatar name={partner.name} image={partner.image} />
      <div><h1>{partner.name}</h1><p>서로 호감이 닿아 대화를 시작했어요</p></div>
    </header>
    <main className="chat-body" ref={thread}>
      <div className="message-list" role="log" aria-label="익명 대화 메시지" aria-live="polite" aria-relevant="additions">
        {messages.map(message => <p className={`message message--${message.author}`} key={message.id}><span className="sr-only">{message.author === 'me' ? '나' : partner.name}: </span>{message.text}</p>)}
      </div>
      {messages.length === 0 && <p className="chat-welcome">서로 호감이 닿았어요.<br />가벼운 인사로 대화를 시작해 보세요.</p>}
      {shared ? <SharedPanel peerId={peerId} /> : snsRequestAvailable ? <RequestPanel peerId={peerId} /> : null}
    </main>
    <form className="composer" onSubmit={send}>
      <input disabled={busy} aria-label="메시지" placeholder="메시지를 입력하세요" value={draft} onChange={e => setDraft(e.target.value)} maxLength={1000} autoComplete="off" />
      <button className="send-button" aria-label="메시지 보내기" type="submit" disabled={!draft.trim() || busy || (!scene && !conversations[peerId]?.canSend)}>↗</button>
    </form>
    <BottomNav active="chats" />
  </div>;
}
