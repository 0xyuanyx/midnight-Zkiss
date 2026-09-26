import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';

export function MatchDialog() {
  const { pendingMatch, dismissMatch, profile, matchedIds, people } = useSession();
  const dialog = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const person = pendingMatch && matchedIds.includes(pendingMatch) ? people.find(p => p.id === pendingMatch) : undefined;
  const peerId = person?.id;

  useEffect(() => {
    const element = dialog.current;
    if (!element || !peerId) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [peerId]);

  if (!person) return null;
  return <dialog ref={dialog} className="match-dialog" aria-labelledby="match-title" aria-describedby="match-description" onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }} onCancel={event => { event.preventDefault(); dismissMatch(); }}>
    <div className="match-heart" aria-hidden="true">♥️</div>
    <h2 id="match-title">서로의 호감이 닿았어요!</h2>
    <p id="match-description">{person.name}님도 {profile.nickname ? `${profile.nickname}님에게` : '회원님에게'} 호감을 보냈어요.<br />연락처를 공개하기 전에 먼저 이야기해 보세요.</p>
    <button className="button button--dark" autoFocus onClick={() => { dismissMatch(); navigate(`/chats/${person.id}`); }}>대화 시작하기</button>
    <button className="match-later" onClick={dismissMatch}>나중에 할게요</button>
  </dialog>;
}
