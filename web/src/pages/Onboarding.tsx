import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Header, Progress } from '../components/ui';
import { useSession } from '../state/session';
import { ImpressionCard } from '../components/ImpressionCard';

export function EntryPage() {
  const navigate = useNavigate();
  const { live, enter } = useSession();
  return <div className="screen entry-page">
    <Header />
    <main className="page-content">
      <Badge>{live ? '✦ 행사 참여' : '✦ 현장 QR 인증 완료'}</Badge>
      <h1>오늘의 행사에서<br />새로운 인연을 만나봐요.</h1>
      <p className="entry-description">실명과 SNS는 숨긴 채, AI가 만든 첫인상 프로필로 가볍게 시작해요.</p>
      <section className="event-card" aria-label="MIDNIGHT SEOUL 행사 카드">
        <div className="event-card-heading"><span>MIDNIGHT SEOUL</span><span className="event-live">● LIVE</span></div>
        <div className="qr-visual" aria-hidden="true"><span>Z</span></div>
        <p>2026.09.22 · 성수 S-FACTORY</p>
      </section>
      <Button variant="lime" onClick={() => live ? void enter?.() : navigate('/profile')}>행사 프로필 만들기 <span aria-hidden="true">→</span></Button>
      <p className="entry-note">◈ &nbsp; {live ? '행사 프로필을 만들고 참여해 주세요.' : '행사 참가 인증은 완료됐어요.'}<br />{live ? '사진은 Gemini 분석에 사용되며 원본은 피드에 공개하지 않아요.' : '프로필 입력에 필요한 개인정보와 SNS는 외부로 전송되지 않아요.'}</p>
    </main>
  </div>;
}

export function ProfilePage() {
  const { profile, setProfile, live, setPhoto, analyze, busy } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [formStep, setFormStep] = useState<1 | 2>(() => searchParams.get('step') === '2' ? 2 : 1);
  const nicknameValid = profile.nickname.trim().length >= 1 && profile.nickname.trim().length <= 12;
  const ageValid = /^\d{1,3}$/.test(profile.age) && Number(profile.age) >= 18 && Number(profile.age) <= 100;
  const mbtiValid = /^[A-Za-z]{4}$/.test(profile.mbti.trim());
  const snsIdValid = profile.snsId.trim().length >= 1 && profile.snsId.trim().length <= 30;
  const introductionValid = profile.introduction.trim().length >= 1 && profile.introduction.trim().length <= 20;
  const basicReady = nicknameValid && ageValid && Boolean(profile.gender);
  const ready = basicReady && (live ? (!profile.mbti || /^[IE][NS][FT][JP]$/.test(profile.mbti)) : mbtiValid && snsIdValid && introductionValid) && profile.photoReady && !busy;

  function markPhotoReady() {
    setProfile(current => ({ ...current, photoReady: true }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (formStep === 1) {
      if (basicReady) setFormStep(2);
      return;
    }
    if (!ready) return;
    if (live) { void analyze?.(); return; }
    setProfile(current => ({
      ...current,
      nickname: current.nickname.trim(),
      mbti: current.mbti.trim().toUpperCase(),
      snsId: current.snsId.trim(),
      introduction: current.introduction.trim(),
    }));
    navigate('/analysis');
  }

  return <div className="screen profile-page">
    <Header back="/" />
    <main className="page-content">
      <div className="form-progress"><Progress step={formStep} total={2} /><span aria-live="polite">{formStep}/2</span></div>
      <h1>{formStep === 1 ? '프로필을 완성해 주세요.' : '나를 조금 더 알려주세요.'}</h1>
      <p className="profile-subtitle">상대에게는 AI가 만든 인상 카드만 보여요</p>
      <form onSubmit={submit} data-step={formStep}>
        {formStep === 1 ? <>
          <label className="field">닉네임
            <input autoComplete="off" value={profile.nickname} onChange={e => setProfile(current => ({ ...current, nickname: e.target.value }))} placeholder="예: 소다" maxLength={12} required />
          </label>
          <label className="field">나이
            <input inputMode="numeric" value={profile.age} onChange={e => setProfile(current => ({ ...current, age: e.target.value }))} placeholder="예: 24" pattern="[0-9]{1,3}" maxLength={3} aria-describedby={profile.age && !ageValid ? 'age-hint' : undefined} required />
          </label>
          {profile.age && !ageValid && <p id="age-hint" className="field-error">18~100 사이의 나이를 입력해 주세요.</p>}
          <label className="field">성별
            <select aria-label="성별" value={profile.gender} onChange={e => setProfile(current => ({ ...current, gender: e.target.value }))} required>
              <option value="" disabled>선택해 주세요</option><option>여성</option><option>남성</option>
            </select>
          </label>
          <Button disabled={!basicReady} type="submit">다음</Button>
        </> : <>
          <label className="field">MBTI
            <input autoComplete="off" value={profile.mbti} onChange={e => setProfile(current => ({ ...current, mbti: e.target.value.toUpperCase() }))} placeholder="예: ENFP" maxLength={4} pattern="[A-Za-z]{4}" aria-describedby={profile.mbti && !mbtiValid ? 'mbti-hint' : undefined} required={!live} />
          </label>
          {profile.mbti && !mbtiValid && <p id="mbti-hint" className="field-error">MBTI 4글자를 입력해 주세요.</p>}
          {!live && <><label className="field">SNS ID
            <input autoComplete="off" value={profile.snsId} onChange={e => setProfile(current => ({ ...current, snsId: e.target.value }))} placeholder="예: @zkiss" maxLength={30} required />
          </label>
          <p className="sns-privacy-notice" role="note"><strong>🔒 SNS ID는 상호 공개 전까지 비공개예요.</strong><br />상대방은 물론 관리자도 확인할 수 없어요.</p>
          <div className="field field--introduction">
            <label htmlFor="introduction">간단한 자기소개</label>
            <textarea id="introduction" value={profile.introduction} onChange={e => setProfile(current => ({ ...current, introduction: e.target.value }))} placeholder="예: 전시와 음악을 좋아해요." maxLength={20} aria-describedby="introduction-count" required />
            <span id="introduction-count" className="character-count">{profile.introduction.length}/20</span>
          </div>
          </>}
          <div className="photo-field">
            <span className="field-label">AI 인상 분석용 사진</span>
            {live ? <input aria-label="AI 인상 분석용 사진" className="photo-picker" type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setPhoto?.(e.target.files?.[0] ?? null)} /> : <button className={`photo-picker ${profile.photoReady ? 'photo-picker--ready' : ''}`} type="button" onClick={markPhotoReady} aria-describedby="photo-help">
              <span aria-live="polite">{profile.photoReady ? '사진이 준비되었어요!' : '사진 한 장 추가하기'}</span>
            </button>}
            <p id="photo-help" className="photo-help">{live ? '사진은 Google Gemini로 전송해 분석합니다. 우리 서버는 처리 후 사진을 삭제하며, Google의 보관 정책이 별도로 적용됩니다. 피드에는 원본 사진을 공개하지 않습니다.' : <>사진은 AI 분석 후 즉시 삭제되며 보관되지 않아요.<br />피드에는 원본 사진이 나타나지 않아요.</>}</p>
          </div>
          <div className="profile-step-actions"><Button variant="outline" type="button" onClick={() => setFormStep(1)}>이전</Button><Button disabled={!ready} type="submit">AI 프로필 만들기</Button></div>
        </>}
      </form>
    </main>
  </div>;
}

export function AnalysisPage() {
  const { profile, setProfileCreated, scene, live, error } = useSession();
  const navigate = useNavigate();
  const hold = scene === 'analysis';
  useEffect(() => {
    if (live || !profile.photoReady || hold) return;
    const timer = window.setTimeout(() => {
      setProfileCreated(true);
      navigate('/profile/preview', { replace: true });
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [profile.photoReady, hold, navigate, setProfileCreated, live]);
  if (!profile.photoReady) return <Navigate to="/profile" replace />;
  return <div className="screen analysis-page">
    <Header back="/profile" />
    <main className="analysis-content" role="status" aria-live="polite">
      <div className="analysis-art" aria-hidden="true">
        <img className="analysis-orb" src="/assets/analysis-orb.svg" alt="" width={155} height={155} />
        <img className="analysis-ring" src="/assets/analysis-ring.svg" alt="" width={191} height={191} />
        <strong>AI</strong>
      </div>
      <h1>{error ? '분석을 완료하지 못했어요' : '첫인상을 만들고 있어요'}</h1>{error && <Link className="button button--outline" to="/profile?step=2">사진 다시 선택하기</Link>}
      <p>표정과 분위기를 바탕으로<br />부담 없는 소개 문구를 작성하는 중이에요.</p>
      <div className={`scan-progress ${hold ? 'scan-progress--still' : ''}`} aria-hidden="true"><span /></div>
      {!live && <span className="sr-only">실제 AI 분석 없이 예시 프로필로 연결되는 체험입니다.</span>}
    </main>
  </div>;
}

export function ProfilePreviewPage() {
  const { profile, profileCreated, ownImpression, live, publish, busy } = useSession();
  if (!profileCreated) return <Navigate to="/profile" replace />;
  return <div className="screen profile-preview-page">
    <div className="profile-decoration" aria-hidden="true">
      <span className="glow glow--violet"><img src="/assets/profile-violet.svg" alt="" width={230} height={230} /></span>
      <span className="glow glow--blue"><img src="/assets/profile-blue.svg" alt="" width={230} height={230} /></span>
      <span className="glow glow--pink"><img src="/assets/profile-pink.svg" alt="" width={354} height={354} /></span>
    </div>
    <Header back="/profile" />
    <main className="page-content">
      <Badge>AI PROFILE READY</Badge>
      <h1>상대방에게 보일 내 프로필</h1>
      <ImpressionCard name={profile.nickname} age={profile.age} gender={profile.gender} mbti={profile.mbti} introduction={profile.introduction} impression={ownImpression} />
      <div className="preview-actions">
        <Link className="button button--outline" to="/profile?step=2">수정</Link>
        {live ? <Button variant="lime" disabled={busy} onClick={() => void publish?.()}>{busy ? '참가를 확인하고 있어요…' : '이 프로필로 시작'}</Button> : <Link className="button button--lime" to="/home">이 프로필로 시작</Link>}
      </div>
    </main>
  </div>;
}
