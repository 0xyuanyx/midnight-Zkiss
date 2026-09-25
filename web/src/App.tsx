import { useEffect, useRef } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { HomePage, LikesPage } from './pages/Feed';
import { MatchDialog } from './components/MatchDialog';
import { SessionProvider } from './state/session';
import { AnalysisPage, EntryPage, ProfilePage, ProfilePreviewPage } from './pages/Onboarding';
import { ChatRoomPage, ChatsPage, MyPage } from './pages/Conversations';

export const screens = [
  { id: 'entry', label: 'QR 행사 입장', node: '2:18', component: EntryPage },
  { id: 'profile', label: '프로필 입력', node: '2:53', component: ProfilePage },
  { id: 'profile-ready', label: '프로필 입력 완료', node: '2:96', component: ProfilePage },
  { id: 'analysis', label: '인상 분석', node: '2:139', component: AnalysisPage },
  { id: 'profile-preview', label: '프로필 미리보기', node: '18:164', component: ProfilePreviewPage },
  { id: 'home', label: '홈 · AI 프로필 피드', node: '18:211', component: HomePage },
  { id: 'home-sent', label: '호감 전송 완료', node: '18:391', component: HomePage },
  { id: 'mutual-match', label: '상호 호감 성사', node: '2:348', component: HomePage },
  { id: 'likes', label: '받은 호감', node: '18:482', component: LikesPage },
  { id: 'likes-sent', label: '보낸 호감', node: '18:482', component: LikesPage },
  { id: 'likes-empty', label: '호감 · 빈 상태', node: '2:620', component: LikesPage },
  { id: 'chats', label: '대화 · 빈 상태', node: '2:657', component: ChatsPage },
  { id: 'matched', label: '매칭 후 대화 목록', node: '2:742', component: ChatsPage },
  { id: 'room', label: '매칭 대화방', node: '2:788', component: ChatRoomPage },
  { id: 'shared', label: 'SNS 상호 공개', node: '2:833', component: () => <ChatRoomPage sharedRoute /> },
];

function PreviewIndex() {
  return <main className="preview-index">
    <Link className="wordmark" to="/">ZKISS</Link>
    <h1>화면 미리보기</h1>
    <p>Figma의 지정 화면과 상태를 하나씩 확인할 수 있어요.<br />이곳의 프로필·매칭·SNS 동의는 예시 데이터입니다.</p>
    <ol>{screens.map(screen => <li key={screen.id}><Link to={`/preview/${screen.id}`}><strong>{screen.label}</strong><span>{screen.node ?? '추후 구현'} <span aria-hidden="true">↗</span></span></Link></li>)}</ol>
    <p>프로필 수정은 제외했습니다. 피드에서 서로 호감을 보내면 대화로 연결됩니다.<br />사진은 서버에 보내거나 저장하지 않으며, 실제 AI·채팅·SNS 서비스는 연결되어 있지 않습니다.</p>
    <Link className="button button--dark" to="/">행사 입장부터 체험하기 →</Link>
  </main>;
}

function PreviewScreen() {
  const { scene } = useParams();
  const screen = screens.find(item => item.id === scene);
  if (!screen) return <Navigate to="/preview" replace />;
  const Component = screen.component;
  return <Component />;
}

const titles: Record<string, string> = {
  '/': '행사 입장', '/profile': '프로필 입력', '/analysis': '인상 분석', '/profile/preview': '프로필 미리보기', '/me': '내 정보',
  '/home': '홈', '/likes': '나의 호감', '/chats': '나의 대화', '/chats/matched': '나의 대화', '/chats/lime': '라임과의 대화', '/chats/lime/shared': 'SNS 상호 공개', '/preview': '화면 미리보기',
};

/** A preview initializes an isolated fixture, which survives navigation through its flow. */
function AppSession() {
  const location = useLocation();
  const scene = location.pathname.startsWith('/preview/') ? location.pathname.split('/')[2] : undefined;
  const sessionKey = useRef('session');
  const sessionScene = useRef<string | undefined>(undefined);
  const previousScene = useRef<string | undefined>(undefined);
  if (scene && scene !== previousScene.current) {
    sessionKey.current = `preview-${scene}-${location.key}`;
    sessionScene.current = scene;
  }
  previousScene.current = scene;

  useEffect(() => {
    document.title = `${titles[location.pathname] ?? screens.find(screen => screen.id === scene)?.label ?? 'ZKiss'} · ZKiss`;
    window.scrollTo(0, 0);
  }, [location.pathname, scene]);

  return <SessionProvider key={sessionKey.current} scene={sessionScene.current}>
    <Routes>
      <Route path="/" element={<EntryPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/analysis" element={<AnalysisPage />} />
      <Route path="/profile/preview" element={<ProfilePreviewPage />} />
      <Route path="/me" element={<MyPage />} />
      <Route path="/home" element={<HomePage />} />
      <Route path="/likes" element={<LikesPage />} />
      <Route path="/chats" element={<ChatsPage />} />
      <Route path="/chats/matched" element={<ChatsPage />} />
      <Route path="/chats/:peerId" element={<ChatRoomPage />} />
      <Route path="/chats/:peerId/shared" element={<ChatRoomPage sharedRoute />} />
      <Route path="/preview" element={<PreviewIndex />} />
      <Route path="/preview/:scene" element={<PreviewScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <MatchDialog />
  </SessionProvider>;
}

export default function App() { return <AppSession />; }
