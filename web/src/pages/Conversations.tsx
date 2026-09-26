import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Avatar, BottomNav, Button, EmptyState, Header, PageHeading } from '../components/ui';
import { ImpressionCard } from '../components/ImpressionCard';
import { canReveal, emptyConversation, sampleProfile, useSession } from '../state/session';


const SNS_REQUEST_MIN_MESSAGES = 4;

export function MyPage() {
  const { profile, profileCreated, ownImpression, live, midnightAvailable, saveContact, contactConfigured, busy } = useSession();
  const [contact, setContact] = useState(profile.snsId);
  const [saved, setSaved] = useState(false);
  const displayedProfile = profileCreated ? profile : sampleProfile;
  return <div className="screen tab-page my-profile-page">
    <Header />
    <main className="page-content" aria-label="내 정보 화면">
      <PageHeading title="내 프로필" description="상대방에게 보이는 나의 AI 인상 프로필이에요" />
      <ImpressionCard name={displayedProfile.nickname} age={displayedProfile.age} gender={displayedProfile.gender} mbti={displayedProfile.mbti} introduction={displayedProfile.introduction} impression={ownImpression} />
      {live && midnightAvailable && <form className="contact-settings" onSubmit={event => { event.preventDefault(); void saveContact?.(contact).then(ok => setSaved(ok)); }}>
        <label htmlFor="private-contact">공개할 SNS 아이디</label>
        <input id="private-contact" autoComplete="off" value={contact} onChange={event => { setContact(event.target.value); setSaved(false); }} placeholder="예: @zkiss" maxLength={64} required />
        <p>아이디는 이 기기에서 암호화해 저장해요. 대화 상대와 서로 승인해야 공개돼요.</p>
        <Button disabled={busy || !contact.trim()} type="submit">{busy ? '암호화해 저장하고 있어요' : 'SNS 저장하기'}</Button>
        {(saved || contactConfigured) && <p role="status">암호화된 SNS가 저장되어 있어요.</p>}
        <details className="device-data-note"><summary>기기 데이터 삭제 전 알아둘 점</summary><p>브라우저의 사이트 데이터나 비공개 모드 데이터를 지우면 이 기기의 참가 키와 암호화된 SNS를 복구할 수 없어요. 처음 참가한 브라우저에서 다시 접속할 수 없다면 새 참가 절차가 필요할 수 있어요.</p></details>
      </form>}
      <div className="my-profile-actions"><Link className="button button--dark" to="/profile">수정하기</Link></div>
    </main>
    <BottomNav active="profile" />
  </div>;
}

export function revealRecoveryGuidance(error?: string) {
  const code = error ?? '';
  if (code === 'TRANSACTION_OUTCOME_UNKNOWN_DO_NOT_RESUBMIT') return '중복 거래를 막기 위해 새 증명을 만들지 않았어요. 연결이 돌아오면 처리 상태 다시 확인하기를 눌러 주세요.';
  if (code === 'SAFE_TO_REPROVE') return '거래가 relay에 도착하지 않은 것이 확인됐어요. 처리 상태 다시 확인하기를 누르면 같은 요청으로 다시 증명할 수 있어요.';
  if (['DEVICE_STATE_LOST', 'DEVICE_KEY_LOST', 'DEVICE_TICKET_MISMATCH', 'DEVICE_STATE_UNREADABLE'].includes(code)) return '이 브라우저의 참가 비밀을 찾지 못했어요. 삭제된 기기 데이터는 이 화면에서 복구할 수 없으며, 처음 참가한 브라우저가 필요해요.';
  if (['CONSENT_EXPIRED', 'REVEAL_EXPIRED'].includes(code)) return '공개 요청이 만료되어 새 증명이나 자동 복구를 하지 않았어요. 두 사람이 새 요청을 시작해야 해요.';
  if (['ROOM_CLOSED_ON_CHAIN', 'BILATERAL_CHAIN_APPROVAL_REQUIRED'].includes(code)) return '방 또는 체인 승인이 더 이상 유효하지 않아 SNS를 공개하지 않았어요. 이 대화에서는 새 요청을 진행할 수 없어요.';
  if (['LOCAL_PROOF_FAILED', 'LOCAL_PROVER_UNAVAILABLE', 'PROOF_ASSET_UNAVAILABLE'].includes(code)) return '이 기기에서 증명을 끝내지 못했어요. 네트워크와 브라우저 저장 공간을 확인한 뒤 처리 상태를 다시 확인해 주세요.';
  return '새 증명을 자동으로 만들지 않았어요. 처리 상태를 다시 확인해도 해결되지 않으면 요청을 새로 시작해 주세요.';
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
  const { profile, conversations, people, ownImpression, live } = useSession();
  const { consent, reveal } = conversations[peerId] ?? emptyConversation;
  const partner = people.find(p => p.id === peerId)!;
  const [notice, setNotice] = useState('');
  // The visibility gate is enforced here as well as at the route boundary.
  if (!canReveal(consent) || (live && (reveal?.status !== 'released' || !reveal.peerContact))) return null;
  if (live) return <section className="shared-panel" aria-label="SNS 상호 공개 완료"><span className="success-check" aria-hidden="true">✓</span><h2>서로 동의했어요</h2><p>두 사람의 승인을 확인하고 SNS를 복호화했어요.</p><div className="revealed-contact"><strong>{partner.name}님의 SNS</strong><p>{reveal!.peerContact}</p><Button onClick={() => { void navigator.clipboard.writeText(reveal!.peerContact!).then(() => setNotice('SNS 아이디를 복사했어요.')).catch(() => setNotice('아이디를 길게 눌러 복사해 주세요.')); }}>아이디 복사하기</Button></div>{notice && <p role="status">{notice}</p>}</section>;
  return <section className="shared-panel" aria-label="SNS 상호 공개 완료">
    <span className="success-check" aria-hidden="true">✓</span>
    <h2>서로 동의했어요</h2>
    <p>두 사람의 SNS가 공개됐어요.<br />행사가 끝난 뒤에도 대화를 이어가 보세요.</p>
    <div className="social-cards">
      {[{ name: partner.name, image: partner.image, pink: false }, { name: profile.nickname, image: ownImpression.image, pink: true }].map(person => <button key={person.name + person.pink} className="social-card" onClick={() => setNotice('이 화면은 상호 공개 예시예요. 연결된 실제 SNS 계정은 없습니다.')}>
        <Avatar name={person.name} image={person.image} pink={person.pink} /><span>{person.name}<br />SNS 바로가기</span>
      </button>)}
    </div>
    {notice && <p className="social-notice" role="status">{notice}</p>}
  </section>;
}

function RequestPanel({ peerId }: { peerId: string }) {
  const { conversations, updateConversation } = useSession();
  const { consent } = conversations[peerId] ?? emptyConversation;
  return <section className="request-panel" aria-live="polite">
    <h2>{consent.mine ? '상대방의 동의를 기다리고 있어요' : '대화를 계속 이어가고 싶나요?'}</h2>
    <p>{consent.mine ? '아직 SNS는 공개되지 않았어요. 데모에서는 상대방 동의를 재현해 다음 화면을 확인할 수 있어요.' : '서로 동의해야 SNS가 공개돼요. 먼저 요청해도 내 SNS가 바로 보이지 않아요.'}</p>
    {consent.mine ? <>
      <Button onClick={() => updateConversation(peerId, current => ({ ...current, consent: { ...current.consent, partner: true } }))}>상대방 동의 시뮬레이션</Button>
      <Button variant="outline" className="demo-cancel" onClick={() => updateConversation(peerId, current => ({ ...current, consent: { ...current.consent, mine: false } }))}>공개 요청 취소하기</Button>
    </> : <Button onClick={() => updateConversation(peerId, current => ({ ...current, consent: { ...current.consent, mine: true } }))}>SNS 공개 요청하기</Button>}
  </section>;
}


function LiveRequestPanel({ peerId }: { peerId: string }) {
  const { conversations, requestReveal, decideReveal, retryReveal, busy, chainBusy, contactConfigured } = useSession();
  const conversation = conversations[peerId] ?? emptyConversation;
  const r = conversation.reveal;
  const terminal = !r || ['cancelled', 'rejected', 'expired'].includes(r.status);
  const retryable = !['CONSENT_EXPIRED', 'REVEAL_EXPIRED', 'ROOM_CLOSED_ON_CHAIN', 'BILATERAL_CHAIN_APPROVAL_REQUIRED'].includes(r?.error ?? '');
  const messages: Record<string, string> = {
    collecting: '두 기기의 암호화 정보를 준비하고 있어요.',
    requested: r?.myDecision === 'accepted' ? '상대방의 동의를 기다리고 있어요.' : '상대방이 SNS 공개를 요청했어요.',
    awaiting_chain: '양측 동의를 Midnight에서 확인하고 있어요. 이 화면을 열어 두세요.',
    authorized: '양측 승인이 확인됐어요. 암호화된 SNS를 교환하고 있어요.',
    released: '암호문을 검증하고 있어요.',
    cancelled: 'SNS 공개 요청이 취소됐어요.', rejected: 'SNS 공개 요청을 거절했어요.', expired: '공개 요청 시간이 지났어요.',
    error: 'Midnight 처리를 확인하지 못했어요. 상태를 다시 확인해 주세요.',
  };
  const progress = r?.status === 'awaiting_chain' ? 1 : r?.status === 'authorized' ? 2 : r?.status === 'released' ? 3 : 0;
  if (!conversation.revealAvailable && !r) return null;
  return <section className="request-panel" aria-live="polite">
    <h2>{terminal ? '대화를 계속 이어가고 싶나요?' : 'SNS 상호 공개'}</h2>
    <p>{r ? messages[r.status] ?? '공개 상태를 확인하고 있어요.' : '서로 명시적으로 동의한 뒤, 두 기기에서 승인 거래를 제출해요.'}</p>
    {r && ['awaiting_chain', 'authorized', 'released'].includes(r.status) && <ol className="reveal-progress" aria-label="SNS 공개 진행 단계"><li className={progress >= 1 ? 'is-current' : ''}>1. 단말 증명</li><li className={progress >= 2 ? 'is-current' : ''}>2. 거래 제출</li><li className={progress >= 3 ? 'is-current' : ''}>3. 체인 확인</li></ol>}
    {!contactConfigured ? <Link className="button button--dark" to="/me">내 SNS 암호화해 저장하기</Link> : terminal ? <Button disabled={busy || chainBusy} onClick={() => void requestReveal?.(peerId)}>SNS 공개 요청하기</Button> : <>
      {r.status === 'requested' && r.myDecision === 'pending' && <Button disabled={busy} onClick={() => void decideReveal?.(peerId, 'accept')}>동의하고 승인 거래 제출하기</Button>}
      {['collecting', 'requested'].includes(r.status) && r.myDecision === 'pending' && <Button variant="outline" disabled={busy} onClick={() => void decideReveal?.(peerId, 'reject')}>거절하기</Button>}
      {['collecting', 'requested', 'awaiting_chain', 'authorized'].includes(r.status) && r.myDecision === 'accepted' && <Button variant="outline" onClick={() => void decideReveal?.(peerId, 'cancel')}>공개 요청 취소하기</Button>}
      {r.status === 'error' && <><p className="reveal-recovery" role="status">{revealRecoveryGuidance(r.error)}</p>{retryable && <Button disabled={busy} onClick={() => void retryReveal?.(peerId)}>처리 상태 다시 확인하기</Button>}</>}
    </>}
    {!terminal && <p className="photo-help">승인과 암호문 교환이 끝나기 전에는 SNS가 공개되지 않아요.</p>}
  </section>;
}

export function ChatRoomPage({ sharedRoute = false }: { sharedRoute?: boolean }) {
  const { peerId = 'lime' } = useParams();
  return <ChatRoom key={peerId} peerId={peerId} sharedRoute={sharedRoute} />;
}

function ChatRoom({ peerId, sharedRoute }: { peerId: string; sharedRoute: boolean }) {
  const { matchedIds, conversations, updateConversation, people, live, sendMessage, busy } = useSession();
  const partner = people.find(p => p.id === peerId);
  const { messages, consent, unreadCount } = conversations[peerId] ?? emptyConversation;
  const matched = matchedIds.includes(peerId);
  const [draft, setDraft] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const previousMessageCount = useRef(messages.length);
  const shared = canReveal(consent);
  const snsRequestAvailable = !live && messages.length >= SNS_REQUEST_MIN_MESSAGES;
  const navigate = useNavigate();

  useEffect(() => { if (matched && unreadCount > 0) updateConversation(peerId, current => ({ ...current, unreadCount: 0 })); }, [matched, peerId, unreadCount, updateConversation]);

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

  function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (live) { void sendMessage?.(peerId, text).then(sent => { if (sent) setDraft(''); }); return; }
    updateConversation(peerId, current => ({ ...current, messages: [...current.messages, { id: crypto.randomUUID(), author: 'me', text }] }));
    setDraft('');
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
      {shared ? <SharedPanel peerId={peerId} /> : live ? <LiveRequestPanel peerId={peerId} /> : snsRequestAvailable ? <RequestPanel peerId={peerId} /> : null}
    </main>
    <form className="composer" onSubmit={send}>
      <input aria-label="메시지" placeholder="메시지를 입력하세요" value={draft} onChange={e => setDraft(e.target.value)} maxLength={1000} autoComplete="off" />
      <button className="send-button" aria-label="메시지 보내기" type="submit" disabled={busy || !draft.trim()}>↗</button>
    </form>
    <BottomNav active="chats" />
  </div>;
}
