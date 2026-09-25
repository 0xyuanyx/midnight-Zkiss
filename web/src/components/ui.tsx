import { Link, useLocation } from 'react-router-dom';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useSession } from '../state/session';

export function Button({ children, variant = 'dark', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'dark' | 'lime' | 'outline' }) {
  return <button className={`button button--${variant} ${className}`} {...props}>{children}</button>;
}

export function EventBadge() {
  return <span className="event-badge"><span className="live-dot" />MIDNIGHT SEOUL 2026</span>;
}

export function Header({ back }: { back?: string }) {
  return <header className="header">
    {back ? <Link className="back" to={back} aria-label="이전 화면">‹</Link> : <Link className="wordmark" to="/" aria-label="ZKiss 행사 입장">ZKISS</Link>}
    <EventBadge />
  </header>;
}

export function Progress({ step, total = 3 }: { step: number; total?: number }) {
  return <div className="progress" aria-label={`프로필 생성 ${step}/${total}단계`}>
    {Array.from({ length: total }, (_, index) => index + 1).map(n => <span className={n <= step ? 'is-complete' : ''} key={n} />)}
  </div>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}

export function Avatar({ name, image, pink = false, className = '' }: { name: string; image?: string; pink?: boolean; className?: string }) {
  return <span aria-hidden="true" className={`avatar ${pink ? 'avatar--pink' : ''} ${className}`}>{image ? <img src={image} alt="" /> : Array.from(name)[0]}</span>;
}

type NavIconName = 'home' | 'likes' | 'chats' | 'profile';

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z" /><path d="M9 21v-6h6v6" /></>,
    likes: <path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.5l8.9-8.9a5.5 5.5 0 0 0-.1-7.8Z" />,
    chats: <path d="M6 5h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-7l-5 3.5V15a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" />,
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function LoadingDots() {
  return <svg className="loading-dots" viewBox="0 0 48 48" aria-hidden="true">
    <circle cx="24" cy="5" r="2.8" /><circle cx="32.5" cy="7.3" r="2.8" /><circle cx="38.7" cy="15.5" r="2.8" /><circle cx="41" cy="24" r="2.8" />
    <circle cx="38.7" cy="32.5" r="2.8" /><circle cx="32.5" cy="38.7" r="2.8" /><circle cx="24" cy="41" r="2.8" /><circle cx="15.5" cy="38.7" r="2.8" />
    <circle cx="9.3" cy="32.5" r="2.8" /><circle cx="7" cy="24" r="2.8" /><circle cx="9.3" cy="15.5" r="2.8" /><circle cx="15.5" cy="7.3" r="2.8" />
  </svg>;
}

export function BottomNav({ active }: { active?: 'home' | 'likes' | 'chats' | 'profile' }) {
  const { matched } = useSession();
  const location = useLocation();
  const selected = active ?? (location.pathname.startsWith('/chats') ? 'chats' : location.pathname === '/likes' ? 'likes' : 'home');
  const items = [
    { key: 'home' as const, to: '/home', label: '피드' },
    { key: 'likes' as const, to: '/likes', label: '호감' },
    { key: 'chats' as const, to: matched ? '/chats/matched' : '/chats', label: '대화' },
    { key: 'profile' as const, to: '/me', label: '내 정보' },
  ];
  return <nav className="bottom-nav" aria-label="주요 메뉴">
    {items.map(item => <Link key={item.key} to={item.to} className={selected === item.key ? 'is-active' : ''} aria-current={selected === item.key ? 'page' : undefined}>
      <NavIcon name={item.key} /><span>{item.label}</span>
    </Link>)}
  </nav>;
}

export function PageHeading({ title, description }: { title: string; description: string }) {
  return <div className="page-heading"><h1>{title}</h1><p>{description}</p></div>;
}

export function EmptyState({ kind }: { kind: 'likes' | 'chats' }) {
  return <section className="empty-state">
    {kind === 'likes' ? <span className="empty-icon empty-icon--likes" aria-hidden="true">♡</span> : <span className="empty-icon empty-icon--chats"><LoadingDots /></span>}
    <h2>{kind === 'likes' ? '아직 보낸 호감이 없어요' : '첫 대화를 기다리고 있어요'}</h2>
    <p>{kind === 'likes' ? <>피드에서 궁금한 사람에게<br />가볍게 마음을 표현해 보세요.</> : <>서로 호감을 보내면<br />익명으로 대화를 시작할 수 있어요.</>}</p>
  </section>;
}
