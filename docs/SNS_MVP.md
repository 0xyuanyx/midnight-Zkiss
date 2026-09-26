# SNS 전용 MVP

## 구현 정책

입장은 일반 쿠키 세션이다. 행사 선택, QR, 참가권 발급, 체인 참가 등록을 하지 않는다. 행사 참가 자격 확인은 향후 피칭 항목이며 **이번 MVP의 구현 기능이 아니다**.

Midnight의 역할은 같은 대화방의 두 슬롯 소유자가 동일한 SNS 공개 조건에 동의했는지 확인하는 것이다. 서버가 웹 세션과 대화방 참여 관계를 알고 슬롯을 등록한다. 실명·행사 참가 자격을 증명하거나 운영자에게 관계를 숨기는 구조가 아니다.

`midnight/sns/zkiss.compact`는 `zkiss-sns-v1` 전용 계약이다. 회로는 openRoom, approveReveal, closeRoom, leaveRoom뿐이다. 기존 `midnight/contract/`의 참가권 계약은 비교용으로 남기며 MVP에서 배포하거나 호출하지 않는다. 새 계약은 기존 계약 주소·봉투·슬롯과 혼용하지 않는다.

단말의 무작위 비밀로 방별 슬롯을 계산하고, SNS 및 수신키 커밋을 증명한다. 브라우저 Worker가 ZK 증명을 생성한다. 서버에는 증명된 거래와 암호문만 보낸다. 운영자 지갑은 방 등록 및 승인 거래 수수료를 담당한다. 승인 효과를 원장에서 확인하고 양측 봉투가 모두 모여야 SNS를 전달한다.

## 로컬 재현

Node 22+, Docker, Compact compiler 0.31.1이 필요하다.

```sh
npm ci
npm ci --prefix midnight
npm run compact:sns --prefix midnight
# 독립된 SNS Devnet. 기존 팀원 Devnet과 포트가 겹치면 먼저 별도 포트를 설정한다.
docker compose -p zkiss-sns-mvp -f midnight/devnet.yml up -d
npm run backend:db:up
# 신규 SNS 계약 배포. 이미 배포한 환경에서는 반복하지 않는다.
(cd midnight && node --import tsx scripts/deploy-sns-local.ts)
npm run prepare:sns-assets
```

배포 결과는 `midnight/reports/sns-deployment.json`, 로컬 운영자 설정은 gitignored `midnight/.env.sns.local`에 저장한다. 공개 로컬 genesis 지갑은 로컬 Devnet에만 사용한다.

브라우저 검증용 서버는 **공유 backend/.env를 읽지 않으며**, 로컬 PostgreSQL의 별도 스키마를 생성한다. 실제 Devnet과 테스트용 합성 AI를 사용한다. 종료하면 해당 테스트 스키마만 삭제한다.

```sh
npm run sns:test-server
# 별도 터미널: 로컬 HTTPS 인증서 경로 설정
LOCAL_TLS_CERT=/path/local.pem LOCAL_TLS_KEY=/path/local.key \
  API_PROXY_TARGET=http://127.0.0.1:3003 npm run dev -- --host 127.0.0.1 --port 5176 --strictPort
# 별도 터미널
WEB_TEST_PORT=5176 WEB_TEST_HTTPS=1 ZKISS_LIVE_E2E=1 ZKISS_REAL_SNS=1 \
  ZKISS_EXPECT_GENERATED_IMAGES=1 npm run test:web -- backend.spec.ts
```

인증서는 127.0.0.1 SAN을 포함해야 한다. 실제 모드는 Secure 쿠키를 사용한다. 사용자 브라우저에서는 신뢰 가능한 HTTPS 인증서를 사용한다.

## 실제 Gemini를 사용하는 로컬 MVP

`backend/.env`의 Gemini 설정을 사용하고 DB는 강제로 로컬 `sns_mvp` 스키마로 분리하는 실행 명령이다. 위의 테스트 서버와 같은 포트·운영자 지갑을 사용하므로 동시에 실행하지 않는다.

```sh
npm run sns:setup
npm run sns:api
# 별도 터미널
npm run sns:worker
# 프론트는 위 HTTPS Vite 명령으로 5176 포트에서 실행
```

이 경로는 합성 AI를 사용하지 않는다. 2026-09-26 개인 유료 프로젝트 키로 교체 후 실제 소개·이미지 생성 호출을 확인했다. 운영자 설정은 `midnight/.env.sns.local`을 사용하며 별도 행사 참가권은 발급하지 않는다.

## 실제 API·워커 구성

- `ADMISSION_MODE=open`, `MIDNIGHT_PROTOCOL=zkiss-sns-v1`, `ZKISS_MODE=real`.
- `DEFAULT_EVENT_ID`: 단일 내부 공간 ID. 사용자에게 입력받지 않는다.
- `AUTO_CREATE_EVENT=false`: 공유 DB에 암묵적인 행사 생성을 하지 않는다.
- `MIDNIGHT_ADAPTER_MODULE`: 새 `midnight/sns/adapter.module.ts` 절대 경로.
- `MIDNIGHT_OPERATOR_MODULE`: 새 `midnight/sns/operator.module.ts` 절대 경로. 워커 전용.
- 배포 결과의 network·contractAddress·eventScope 및 allowlist를 설정한다. 운영자 비밀과 수수료 지갑은 서버 전용이다.
- `PUBLIC_ORIGIN=https://...`, `SECURE_COOKIES=true`.
- `AI_MODE=real`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `AI_TIMEOUT_MS=120000`.
- 생성 이미지 스키마 `006`, 대납 작업 스키마 `007`이 필요하다. 공유 DB에는 담당자와 별도 적용하며 자동 실행하지 않는다.

새 API: 인증된 `GET /events/:id/midnight/proof-context`는 공개 체인 상태만 제공한다. `POST /events/:id/chain-intents/:intentId/relay`는 `{transaction: base64}` 형식의 이미 증명된 SNS 승인 거래만 받는다. 일반 거래·다른 계약·다른 intent의 대납은 허용하지 않는다. 조회와 최종 검증은 기존 operations 경로를 사용한다.

## 검증 기록과 제한

- SNS 전용 계약 컴파일 및 계약 로직 테스트 22개, 기존 Midnight 단위 테스트 57개, 백엔드 테스트 75개 통과. 타입 검사와 프론트 빌드 통과.
- 브라우저 66개 항목 검증: 전체 실행에서 64개 통과 후 HTTPS 테스트 주소 비교를 수정하고 실패했던 2개를 재실행해 통과. 실제 Devnet 통합 2개는 전체 실행에서 모두 통과.
- 실제 로컬 Devnet 신규 계약 배포 성공. 공개 테스트넷 배포가 아니다.
- 이전 팀 키에서는 이미지 생성 무료 할당량 0으로 429가 반환됐다. 2026-09-26 사용자 지시로 개인 유료 프로젝트의 기존 키를 로컬 환경변수에 적용하고 API·워커를 재시작했다. 실제 Gemini 제공자 코드로 소개 문구와 이미지 생성에 성공했다. 결과는 gitignored `midnight/reports/gemini-personal/`에 보관한다. 이 검증은 실제 제공자 호출이며, 실제 Gemini를 포함한 전체 브라우저 흐름을 다시 실행한 것은 아니다.
- Chromium·WebKit 각각 실제 Devnet에서 두 사용자의 승인 거래, 서버 대납, 원장 효과 확인, 양측 복호화·복사 통합 테스트 통과. AI 응답은 테스트 제공자의 합성 이미지이며 실제 Gemini 생성 검증과 구분한다.
- 테스트에서 티켓·참가 등록 요청이 없고 SNS 원문·슬롯 비밀이 승인 요청에 포함되지 않는지 확인했다. 계약 테스트는 제3자·변조 조건·방 및 계약 간 재사용·중복 승인·만료·한쪽 동의만으로 공개되지 않는 조건을 검증한다.
- 휴대폰 실기기 검증, 공개 테스트넷 검증, 행사 자격 확인, 기기 변경 키 복구는 완료 범위에 포함하지 않는다.

### 현재 로컬 실행 환경

현재 머신의 HTTPS 인증서는 `/tmp/zkiss-sns-local.pem`, 키는 `/tmp/zkiss-sns-local.key`에 있다. 개발용 자체 서명 인증서이며 임시 파일 삭제·유효기간 만료 시 다시 준비해야 한다. 현재 배포는 7일 기한의 로컬 시연 계약이다. 만료 후에는 새 배포와 설정 갱신이 필요하다.

```sh
LOCAL_TLS_CERT=/tmp/zkiss-sns-local.pem LOCAL_TLS_KEY=/tmp/zkiss-sns-local.key \
  API_PROXY_TARGET=http://127.0.0.1:3003 npm run dev -- --host 127.0.0.1 --port 5176 --strictPort
```

클립보드 자동 테스트는 브라우저 API에 전달한 값과 실패 처리를 검증한다. OS 클립보드 권한 및 휴대폰 실기기 사용성 검증과는 구분한다.

### 프로필 생성 품질 조정

프로필에서 사용자가 선택한 성별을 이미지 생성 조건으로 전달한다. 사진으로 성별을 추정하지 않는다. 소개는 핵심 특징 2~3개를 담은 두 문장, 공백 포함 85~100자를 목표로 하며 줄바꿈을 제거한다. 100자를 넘으면 텍스트만 한 번 다시 생성하고, 계속 넘으면 저장하지 않는다. 테스트용 사진으로 실제 생성한 87자 소개를 기존 Pretendard 폰트·카드 CSS로 렌더링했을 때 320·390·402·1440px 화면에서 모두 네 줄이었다. 다른 문구와 폰트 설정에 따라 줄 수는 달라질 수 있다. 기존 저장 프로필에는 자동 적용되지 않으며 기존 수정→사진 재업로드→분석 흐름으로 갱신한다.

이미지 생성에는 두 참고 이미지를 역할을 나눠 전달한다. 사용자 사진에서는 헤어·표정·각도·손 포즈·옷을 가져오고, 번들된 `backend/assets/avatar-style.png`에서는 가상의 3D 얼굴 디자인·재질·조명을 참고한다. 얼굴은 예시 캐릭터에 가깝게 만들되 사용자의 눈매와 얼굴형은 가볍게만 반영하며 정확한 얼굴 복원과 실사 피부 묘사는 피한다. 원본은 DB에 저장하지 않고 작업 메모리에서 정리한다. 캐릭터 변환만으로 신원 익명화가 보장되는 것은 아니다.

Gemini는 소개에 언급한 시각적 특징에서 공백 포함 2~8자의 서로 다른 태그 두 개를 함께 반환한다. 프로필에 저장하고 MBTI와 함께 표시하며, 칩은 내용 너비에 맞춘다. 프로필 수정 시 태그를 생략하면 기존 태그를 보존한다. 실제 Gemini 텍스트 생성으로 소개+태그 반환을 확인했으며, 로컬 ik 프로필에는 기존 소개에서 추출한 태그만 추가했다(이미지 재생성 없음).
