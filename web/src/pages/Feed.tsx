import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BottomNav, Button, Header, PageHeading } from '../components/ui';
import { type Person } from '../state/people';
import { useSession } from '../state/session';

function FilterTabs({ label, items, value, onChange }: { label: string; items: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[next].id);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
  }
  return <div className="filter-tabs" role="tablist" aria-label={label}>{items.map((item, index) =>
    <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={value === item.id} aria-controls={label === '피드 분류' ? 'panel-feed' : 'panel-likes'} tabIndex={value === item.id ? 0 : -1} className={value === item.id ? 'is-selected' : ''} onClick={() => onChange(item.id)} onKeyDown={event => move(event, index)}>{item.label}</button>
  )}</div>;
}

function PrivacyNotice() {
  return <aside className="feed-privacy">🔒 호감은 익명으로 전달돼요.<br />서로 이어진 뒤에도 SNS 공개는 양쪽의 동의가 필요해요.</aside>;
}

function useInterestNotice(initial = '') {
  const [notice, setNotice] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function notify(text: string) {
    clearTimeout(timer.current);
    setNotice(text);
    timer.current = setTimeout(() => setNotice(''), 3500);
  }
  return { notice, notify };
}

function InterestAction({ person, notify }: { person: Person; notify: (text: string) => void }) {
  const { interests, matchedIds, sendInterest, busy } = useSession();
  const sent = interests.sent.includes(person.id);
  const matched = matchedIds.includes(person.id);
  if (matched) return <Link className="button button--dark" to={`/chats/${person.id}`}>대화 시작하기<span className="sr-only"> · {person.name}</span></Link>;
  return <Button variant="outline" className={`interest-button ${sent ? 'interest-button--sent' : ''}`} disabled={sent || busy} onClick={() => {
    sendInterest(person.id);
    if (!interests.received.includes(person.id)) notify('호감을 보냈어요!');
  }}>{sent ? '♥ 호감 보냄' : '♡ 호감 보내기'}<span className="sr-only"> · {person.name}</span></Button>;
}

export function HomePage() {
  const { profile, interests, scene, people, live, participantCount } = useSession();
  const [filter, setFilter] = useState('all');
  const [params] = useSearchParams();
  const focusedId = params.get('person');
  const { notice, notify } = useInterestNotice(scene === 'home-sent' ? '호감을 보냈어요!' : '');
  const filteredPeople = people.filter(person => filter === 'all' || (filter === 'received' ? interests.received.includes(person.id) : Math.abs(person.age - Number(profile.age || 26)) <= 1));
  useEffect(() => {
    if (!focusedId) return;
    setFilter('all');
    const frame = requestAnimationFrame(() => document.getElementById(`person-${focusedId}`)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [focusedId]);
  return <div className="screen tab-page feed-page">
    <Header />
    <main className="page-content">
      <div className="feed-heading"><PageHeading title="지금 만날 사람들" description="마음에 드는 프로필에 호감을 보내보세요" /><span className="participant-count">● {participantCount ?? people.length}명 참여 중</span></div>
      <PrivacyNotice />
      <FilterTabs label="피드 분류" items={[{ id: 'all', label: '전체' }, { id: 'received', label: '나에게 호감 보낸' }, { id: 'similar', label: '나와 비슷한' }]} value={filter} onChange={setFilter} />
      {filter === 'similar' && <p className="filter-hint">나이 차이가 1살 이내인 프로필이에요.</p>}
      <div className="feed-list" role="tabpanel" id="panel-feed" aria-labelledby={`tab-${filter}`}>
        {filteredPeople.map(person => <section className="feed-profile" id={`person-${person.id}`} key={person.id} aria-label={`${person.name} 프로필`}>
          <article className="feed-art" aria-label={`${person.name} AI 인상 프로필${live ? '' : ' 예시'}`}>
            <img className="feed-art-image" src={person.image || '/assets/anonymous-profile.svg'} alt={`${person.name} AI 프로필 예시`} width={1254} height={1254} />
            <span className="feed-ai-badge">AI PROFILE</span>
            <div className="feed-art-info">
              <div className="feed-person"><h2>{person.name} · {person.age}</h2>{person.introduction && <p className="feed-introduction">{person.introduction}</p>}</div>
              <div className="feed-description">
              <p className="feed-impression-label">AI가 설명하는 매력</p>
              <p className="feed-impression" aria-label="AI 인상 분석">{person.lines.map(line => <span key={line}>{line}</span>)}</p>
              <div className="feed-tags">{[...person.tags.slice(0, 2), person.mbti].map(tag => <span key={tag}># {tag}</span>)}</div>
              </div>
            </div>
          </article>
          <div className="feed-action"><InterestAction person={person} notify={notify} /></div>
        </section>)}
        {filteredPeople.length === 0 && <div className="interest-empty"><h2>아직 해당하는 프로필이 없어요</h2><p>전체 탭에서 다른 프로필을 만나보세요.</p></div>}
      </div>
    </main>
    {notice && <div className="interest-toast" role="status">{notice}</div>}
    <BottomNav active="home" />
  </div>;
}

export function LikesPage() {
  const { interests, matchedIds, scene, people } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'sent' || (!params.has('tab') && scene === 'likes-sent') ? 'sent' : 'received';
  const { notice, notify } = useInterestNotice();
  const selected = tab === 'received' ? interests.received : interests.sent;
  const visible = people.filter(person => selected.includes(person.id));
  return <div className="screen tab-page likes-page">
    <Header />
    <main className="page-content">
      <PageHeading title="나의 호감" description="서로의 마음이 닿으면 대화를 시작할 수 있어요" />
      <FilterTabs label="호감 분류" items={[{ id: 'received', label: `받은 호감 ${interests.received.length}` }, { id: 'sent', label: `보낸 호감 ${interests.sent.length}` }]} value={tab} onChange={value => setParams({ tab: value }, { replace: true })} />
      <div className="interest-list" role="tabpanel" id="panel-likes" aria-labelledby={`tab-${tab}`}>
        {visible.map(person => {
          const matched = matchedIds.includes(person.id);
          return <article className="interest-card" aria-label={`${person.name} ${tab === 'received' ? '받은' : '보낸'} 호감`} key={person.id}>
            <div className="interest-card-header">
              <img src={person.image || '/assets/anonymous-profile.svg'} alt={`${person.name} AI 프로필 예시`} width={44} height={44} />
              <div><h2>{person.name} · {person.age}</h2><p>{person.mbti} · 현재 행사 참여 중</p></div>
              <span className={matched ? 'interest-status interest-status--matched' : 'interest-status'}>{matched ? '서로 호감이 닿았어요' : tab === 'received' ? '나에게 도착한 호감' : '상대 응답 대기 중'}</span>
            </div>
            <p className="interest-summary">{person.summary}</p>
            <div className="interest-card-actions">
              <Link className={`button button--${tab === 'sent' && !matched ? 'dark' : 'outline'}`} to={`/home?person=${person.id}`}>피드에서 다시 보기</Link>
              {(tab === 'received' || matched) && <InterestAction person={person} notify={notify} />}
            </div>
          </article>;
        })}
        {visible.length === 0 && <div className="interest-empty"><span aria-hidden="true">♡</span><h2>{tab === 'received' ? '아직 받은 호감이 없어요' : '아직 보낸 호감이 없어요'}</h2><p>{tab === 'received' ? '내 프로필에 닿을 마음을 기다려 보세요.' : '피드에서 궁금한 사람에게 가볍게 마음을 표현해 보세요.'}</p><Link to="/home">피드 둘러보기 →</Link></div>}
      </div>
      <PrivacyNotice />
    </main>
    {notice && <div className="interest-toast" role="status">{notice}</div>}
    <BottomNav active="likes" />
  </div>;
}
