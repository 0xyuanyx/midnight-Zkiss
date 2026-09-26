import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Header, Progress } from '../components/ui';
import { useSession } from '../state/session';
import { ImpressionCard } from '../components/ImpressionCard';

export function EntryPage() {
  const { join, busy, scene, profileCreated, profilePublished, eventName, mode } = useSession();
  const navigate = useNavigate();
  return <div className="screen entry-page">
    <Header />
    <main className="page-content">
      <Badge>{scene ? '✦ 현장 QR 인증 완료' : '✦ 행사 입장'}</Badge>
      <h1>오늘의 행사에서<br />새로운 인연을 만나봐요.</h1>
      <p className="entry-description">실명과 SNS는 숨긴 채, AI가 만든 첫인상 프로필로 가볍게 시작해요.</p>
      <section className="event-card" aria-label="MIDNIGHT SEOUL 행사 카드">
        <div className="event-card-heading"><span>{eventName}</span><span className="event-live">● LIVE</span></div>
        <div className="qr-visual" aria-hidden="true"><span>Z</span></div>
        <p>{scene ? '2026.09.22 · 성수 S-FACTORY' : mode === 'demo' ? '지금 같은 행사에서 만나요' : '같은 행사에서 새로운 인연을 만나요'}</p>
      </section>
      <Button variant="lime" disabled={busy} onClick={async () => { if (await join()) navigate(profilePublished ? '/home' : profileCreated ? '/profile/preview' : '/profile'); }}>행사 프로필 만들기 <span aria-hidden="true">→</span></Button>
      <p className="entry-note">◈ &nbsp; 프로필은 행사 서버에 저장돼요.<br />SNS는 브라우저에서 암호화한 후 전송해요.</p>
    </main>
  </div>;
}

export function ProfilePage() {
  const { profile, setProfile, selectPhoto, scene } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [formStep, setFormStep] = useState<1 | 2>(() => searchParams.get('step') === '2' ? 2 : 1);
  const nicknameValid = profile.nickname.trim().length >= 1 && profile.nickname.trim().length <= 12;
  const ageValid = /^\d{1,3}$/.test(profile.age) && Number(profile.age) >= 18 && Number(profile.age) <= 100;
  const mbtiValid = /^[IE][NS][FT][JP]$/i.test(profile.mbti.trim());
  const snsIdValid = profile.snsId.trim().length >= 1 && profile.snsId.trim().length <= 30;
  const introductionValid = profile.introduction.trim().length >= 1 && profile.introduction.trim().length <= 20;
  const basicReady = nicknameValid && ageValid && Boolean(profile.gender);
  const ready = basicReady && mbtiValid && snsIdValid && introductionValid && profile.photoReady;

  function markPhotoReady() {
    if (scene) setProfile(current => ({ ...current, photoReady: true }));
    else fileInput.current?.click();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (formStep === 1) {
      if (basicReady) setFormStep(2);
      return;
    }
    if (!ready) return;
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
            <input autoComplete="off" value={profile.mbti} onChange={e => setProfile(current => ({ ...current, mbti: e.target.value.toUpperCase() }))} placeholder="예: ENFP" maxLength={4} pattern="[A-Za-z]{4}" aria-describedby={profile.mbti && !mbtiValid ? 'mbti-hint' : undefined} required />
          </label>
          {profile.mbti && !mbtiValid && <p id="mbti-hint" className="field-error">MBTI 4글자를 입력해 주세요.</p>}
          <label className="field">SNS ID
            <input autoComplete="off" value={profile.snsId} onChange={e => setProfile(current => ({ ...current, snsId: e.target.value }))} placeholder="예: @zkiss" maxLength={30} required />
          </label>
          <p className="sns-privacy-notice" role="note"><strong>🔒 SNS ID는 상호 공개 전까지 비공개예요.</strong><br />상대방은 물론 관리자도 확인할 수 없어요.</p>
          <div className="field field--introduction">
            <label htmlFor="introduction">간단한 자기소개</label>
            <textarea id="introduction" value={profile.introduction} onChange={e => setProfile(current => ({ ...current, introduction: e.target.value }))} placeholder="예: 전시와 음악을 좋아해요." maxLength={20} aria-describedby="introduction-count" required />
            <span id="introduction-count" className="character-count">{profile.introduction.length}/20</span>
          </div>
          <div className="photo-field">
            <span className="field-label">AI 인상 분석용 사진</span>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="분석용 사진 선택" onChange={e => { const file = e.target.files?.[0]; if (file) selectPhoto(file); }} />
            <button className={`photo-picker ${profile.photoReady ? 'photo-picker--ready' : ''}`} type="button" onClick={markPhotoReady} aria-describedby="photo-help">
              <span aria-live="polite">{profile.photoReady ? '사진이 준비되었어요!' : '사진 한 장 추가하기'}</span>
            </button>
            <p id="photo-help" className="photo-help">5MB 이하 PNG·JPEG·WebP 사진을 선택해 주세요.<br />서버의 사진은 분석 후 삭제돼요. 외부 AI 제공자의 보관 여부는 확인되지 않았어요.</p>
          </div>
          <div className="profile-step-actions"><Button variant="outline" type="button" onClick={() => setFormStep(1)}>이전</Button><Button disabled={!ready} type="submit">AI 프로필 만들기</Button></div>
        </>}
      </form>
    </main>
  </div>;
}

export function AnalysisPage() {
  const { profile, setProfileCreated, scene, analyze, busy, error } = useSession();
  const navigate = useNavigate();
  const hold = scene === 'analysis';
  const started = useRef(false);
  useEffect(() => {
    if (!profile.photoReady || hold) return;
    if (!scene) {
      if (!started.current) { started.current = true; void analyze().then(ok => { if (ok) navigate('/profile/preview', { replace: true }); }); }
      return;
    }
    const timer = window.setTimeout(() => {
      setProfileCreated(true);
      navigate('/profile/preview', { replace: true });
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [profile.photoReady, hold, navigate, setProfileCreated]);
  if (!profile.photoReady) return <Navigate to="/profile" replace />;
  return <div className="screen analysis-page">
    <Header back="/profile" />
    <main className="analysis-content" role="status" aria-live="polite">
      <div className="analysis-art" aria-hidden="true">
        <img className="analysis-orb" src="/assets/analysis-orb.svg" alt="" width={155} height={155} />
        <img className="analysis-ring" src="/assets/analysis-ring.svg" alt="" width={191} height={191} />
        <strong>AI</strong>
      </div>
      <h1>첫인상을 만들고 있어요</h1>
      <p>표정과 분위기를 바탕으로<br />소개 문구와 프로필 이미지를 만들고 있어요.</p>
      <div className={`scan-progress ${hold ? 'scan-progress--still' : ''}`} aria-hidden="true"><span /></div>
      {scene && <span className="sr-only">실제 AI 분석 없이 예시 프로필로 연결되는 체험입니다.</span>}
      {!scene && !busy && error && <Link className="button button--outline" to="/profile?step=2">사진을 다시 선택해 재시도</Link>}
    </main>
  </div>;
}

export function ProfilePreviewPage() {
  const { profile, profileCreated, ownImpression, publish, busy, scene, aiMode } = useSession();
  const navigate = useNavigate();
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
      <p className="photo-help">{scene || aiMode === 'demo' ? '이미지와 소개 문구는 미리보기 예시예요.' : '소개는 사진 분석 결과이며, 이미지는 사진의 헤어·표정·포즈·옷을 반영한 가상의 3D 캐릭터예요.'}</p>
      <div className="preview-actions">
        <Link className="button button--outline" to="/profile?step=2">수정</Link>
        <Button variant="lime" disabled={busy} onClick={async () => { if (await publish()) navigate('/home'); }}>이 프로필로 시작</Button>
      </div>
    </main>
  </div>;
}
