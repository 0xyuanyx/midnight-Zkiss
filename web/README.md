# ZKiss 모바일 웹

React + TypeScript + Vite, React Router, 일반 CSS로 구현한 모바일 프론트엔드입니다. Pretendard Variable과 Manrope는 npm 패키지에서 자체 제공하므로 런타임 외부 폰트 요청이 없습니다. 일반 화면은 백엔드 HTTP API를 호출하며 `/preview`는 독립된 예시 상태를 사용합니다.

## 실행과 확인

저장소 루트에서 `npm ci` 후 `npm run dev`로 실행합니다. `/`는 행사 입장, `/preview`는 화면별 디자인 확인 목록입니다. `npm run build`는 타입 검사와 프로덕션 빌드, `npm run test:web`는 Playwright 흐름 테스트를 실행합니다. 첫 테스트 전 `npx playwright install chromium webkit`가 필요합니다.

| 화면 | Figma 노드 | 직접 확인 |
|---|---|---|
| 바로 입장 | 2:18 | `/preview/entry` |
| 프로필 입력 | 2:53 | `/preview/profile` |
| 프로필 입력 완료 | 2:96 | `/preview/profile-ready` |
| 인상 분석 | 2:139 | `/preview/analysis` |
| 프로필 미리보기 | 18:164 | `/preview/profile-preview` |
| AI 프로필 피드 | 18:211 | `/preview/home` |
| 호감 전송 완료 | 18:391 | `/preview/home-sent` |
| 상호 호감 성사 | 2:348 | `/preview/mutual-match` |
| 내 프로필 | 기존 프로필 카드 | `/me` |
| 받은 호감 | 18:482 기반 | `/preview/likes` |
| 보낸 호감 | 18:482 | `/preview/likes-sent` |
| 호감 빈 상태 | 2:620 기반 | `/preview/likes-empty` |
| 대화 빈 상태 | 2:657 | `/preview/chats` |
| 매칭 후 대화 목록 | 2:742 | `/preview/matched` |
| 매칭 대화방 | 2:788 | `/preview/room` |
| SNS 상호 공개 | 2:833 | `/preview/shared` |

원본: [ZKiss Figma](https://www.figma.com/design/yUXUZElCOVQSdQV04jN8Ux?node-id=15-165).

## 동작과 데이터

- 바로 입장 → 프로필 저장 → 실제 파일 업로드 → 분석 작업 조회 → 미리보기 → 프로필 공개를 API에 연결합니다.
- 피드·참가자 수·호감·상호 매칭·메시지는 PostgreSQL에 저장된 서버 상태를 표시합니다. 갱신 주기는 5초이며, 전송 성공은 서버 응답으로 반영합니다.
- 자기소개와 AI 인상 소개는 별도 필드입니다. AI 제공자는 백엔드 설정을 따르고, 실제 AI 모드에서는 생성 이미지 URL을 사용합니다. 데모와 미리보기만 예시 이미지를 사용합니다.
- SNS는 브라우저에서 HPKE 암호화 후 전송합니다. 양측 동의·체인 승인·서버 공개 완료 후 상대 SNS를 복호화합니다. 세션 상태는 현재 탭에, SNS 공개용 기기 비밀은 IndexedDB에 보관합니다. 다른 기기에서의 복구는 제공하지 않습니다.
- 데모 모드 체인 승인은 시뮬레이션입니다. 실제 SNS 승인은 `midnight/sns/` 전용 계약과 브라우저 Worker·대납 워커로 연결됩니다. 입장에는 Midnight를 사용하지 않습니다.
- `/preview/:scene`에서만 고정 프로필, 타이머 분석, 상대 동의 시뮬레이션을 사용합니다.

API·DB·워커 실행 명령과 검증 방법은 [FRONTEND_INTEGRATION.md](../docs/FRONTEND_INTEGRATION.md)를 참고하세요.

## 레이아웃과 에셋

디자인 기준 너비는 402px, 가로 여백은 20px입니다. 넓은 화면에서는 모바일 화면을 중앙에 표시하고 좁은 화면에서는 폭에 맞춰 줄어듭니다. Figma에 그려진 iOS 상태바(상단)와 Safari 툴바(하단)는 제외하고 실제 브라우저가 표시합니다. 하단 메뉴는 safe-area를 반영합니다. 채팅은 메시지 영역만 스크롤되고 입력창과 하단 메뉴는 유지됩니다.

`public/assets/`에는 Figma SVG·PNG 원본과 밝은 톤으로 별도 생성한 모카 예시 이미지가 있습니다. `assets.json`에 노드, 위치, 원본 크기를 기록했습니다. 프로필 이미지는 1254px 정사각형 원본을 96px로 표시하며, 사진 준비 배경은 CSS 그라디언트입니다. MVP 입장은 QR이나 참가권 없이 바로 진행합니다.

Vercel 배포는 루트의 `npm run build:vercel`로 생성한 산출물을 사용합니다. SPA fallback과 공개 증명 자산을 포함하며, `ZKISS_API_ORIGIN`이 없으면 API 요청에는 연결 준비 중 오류를 반환합니다. `/preview`는 서버 없이 화면을 확인할 수 있습니다. 자세한 절차는 [루트 README](../README.md#vercel-배포)를 참고하세요.

## 연동 인계

현재 구현과 실모드 제약은 [FRONTEND_INTEGRATION.md](../docs/FRONTEND_INTEGRATION.md), 초기 범위 합의는 [FRONTEND_HANDOFF.md](../docs/FRONTEND_HANDOFF.md)에 정리했습니다.
