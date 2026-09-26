# 프론트·백엔드 연동 현황

최신 실행 명령, 환경변수, 계약 구조 및 검증 범위는 [SNS_MVP.md](SNS_MVP.md)를 따른다.

일반 경로는 실제 HTTP API를 사용한다. `/preview/:scene`은 서버 요청이 없는 화면 예시다.

| 항목 | 구현 |
|---|---|
| 바로 입장 | 일반 쿠키 세션을 즉시 활성화. 티켓·체인 참가 등록 호출 없음 |
| 단일 공간 | 내부 기본 공간 사용. 행사 선택이나 ID 입력 없음 |
| 프로필·호감·매칭·대화 | 실제 API/DB 연결, 기존 수정 흐름 유지 |
| 인상 소개·이미지 | Gemini 연결 및 생성 이미지 저장·표시 구현. 개인 유료 프로젝트 키로 교체 후 실제 소개·이미지 생성 호출 성공 |
| SNS 상호 공개 | 새 SNS 전용 계약, 브라우저 증명, 서버 수수료 대납, 원장 승인 확인, 양측 암호문 전달·복호화 |
| SNS 복사 | 공개 카드 클릭 시 클립보드 복사, 실패 안내 |

SNS 요청 버튼은 기존대로 메시지 총 4개 이후에 표시한다. 요청 중·상대 동의 대기·공개 준비·완료 상태를 기존 UI에 연결했다. 사용자에게 지갑·ZKP 조작을 요구하지 않는다.

## 구성

- `backend/src/routes/sessions.ts`: 일반 세션과 암호화 공개키 등록.
- `backend/src/adapters/gemini.ts`, `ai-jobs.ts`: 사진 분석, 소개·이미지 생성, 저장.
- `backend/src/routes/profile-images.ts`: 인증된 생성 이미지 조회.
- `backend/src/routes/reveal.ts`, `chain.ts`: 동의·증명 intent·암호문 교환.
- `backend/src/relay-worker.ts`: 증명된 승인 거래의 대납 및 제출. 기존 reconciliation에서 원장 효과 확인.
- `midnight/sns/`: 참가권 없는 SNS 전용 계약과 어댑터.
- `web/src/midnight/`: Worker 증명, 기기 내 암호화 저장, 승인 거래 제출.
- `web/src/state/live-session.tsx`: 기존 화면과 서버 상태 연결.

생성 이미지만 WebP로 DB에 저장하며 업로드 원본은 DB에 저장하지 않는다. 실모드의 AI·체인 실패는 오류로 표시하며 예시 이미지나 가짜 승인으로 대체하지 않는다. 브라우저 테스트의 합성 AI는 별도 테스트 제공자다.

SNS 비밀과 개인키는 기기에 보관한다. WebKit의 X25519 IndexedDB 저장 제약을 위해 개인키를 기기 내 AES 키로 암호화해 저장한다. 서버에는 SNS 원문·슬롯 비밀·개인키를 보내지 않는다. 다른 기기로의 키 복구는 범위 밖이다.

## 실행 시 주의할 설정

기존 `backend/.env`를 덮어쓰지 않는다. `npm run sns:setup`, `sns:api`, `sns:worker`는 Gemini 설정을 읽되 DB와 Midnight 연결을 별도 로컬 MVP 환경으로 고정한다. 공유 DB에 마이그레이션을 실행하지 않는다. 테스트 서버와 실제 서버는 같은 포트·운영자 지갑을 사용하므로 동시에 실행하지 않는다.

프론트에는 비밀 환경변수가 필요 없다. HTTPS Vite의 `API_PROXY_TARGET`을 실제 로컬 API에 연결한다. 자세한 명령은 [SNS MVP 실행 안내](SNS_MVP.md#실제-gemini를-사용하는-로컬-mvp)를 참고한다.

행사 참가 자격 검증은 향후 피칭 항목이며 이번 구현에 포함하지 않는다. 거절 UI, 다른 화면 알림, 웹 푸시, 기기 변경 복구도 추가하지 않는다.
