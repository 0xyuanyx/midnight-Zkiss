# SNS 전용 MVP

## 구현 정책

입장은 일반 쿠키 세션이다. 행사 선택, QR, 참가권 발급, 체인 참가 등록을 하지 않는다. 행사 참가 자격 확인은 향후 피칭 항목이며 **이번 MVP의 구현 기능이 아니다**.

Midnight의 역할은 같은 대화방의 두 슬롯 소유자가 동일한 SNS 공개 조건에 동의했는지 확인하는 것이다. 서버가 웹 세션과 대화방 참여 관계를 알고 슬롯을 등록한다. 실명·행사 참가 자격을 증명하거나 운영자에게 관계를 숨기는 구조가 아니다.

`midnight/sns/zkiss.compact`는 `zkiss-sns-v1` 전용 계약이다. 회로는 openRoom, approveReveal, closeRoom, leaveRoom뿐이다. 기존 `midnight/contract/`의 참가권 계약은 비교용으로 남기며 MVP에서 배포하거나 호출하지 않는다. 새 계약은 기존 계약 주소·봉투·슬롯과 혼용하지 않는다.

단말의 무작위 비밀로 방별 슬롯을 계산하고, SNS 및 수신키 커밋을 증명한다. 브라우저 Worker가 ZK 증명을 생성한다. 서버에는 증명된 거래와 암호문만 보낸다. 운영자 지갑은 방 등록 및 승인 거래 수수료를 담당한다. 승인 효과를 원장에서 확인하고 양측 봉투가 모두 모여야 SNS를 전달한다.

## 공개 시연 환경

현재 프론트는 https://zkiss.vercel.app, API는 GCP Compute Engine의 전용 서버에 연결한다. 공개 API도 실제 Gemini와 `zkiss-sns-v1` 계약을 사용한다. 체인은 서버 내부의 독립 Devnet이며 공개 테스트넷이 아니다. 리소스·배포·운영 방법은 [GCP 배포 안내](../deploy/gcp/README.md)를 참고한다.

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

### 공개 GCP 환경 추가 검증 — 2026-09-26

Vercel production을 GCP HTTPS API·워커·전용 DB·독립 Devnet에 연결했다. Chromium과 WebKit에서 각각 실제 Gemini 소개·이미지 생성부터 양측 Midnight 승인·대납·원장 확인·SNS 복호화·복사·새로고침 복원까지 2개 통합 테스트가 통과했다(총 7.2분). 앞선 로컬 합성 AI 테스트와 달리 이 실행은 실제 Gemini를 사용했다. 생성 4건과 승인 거래 제출 4건, 공개 완료 2건을 확인했다. 테스트 프로필은 피드에서 제외했다. 휴대폰 실기기와 공개 테스트넷 검증은 여전히 별도다.

### SNS 공개 진행·복구 개선 — 2026-09-27

- 원격 main `c3470f9`의 증명 자산 다운로드 재시도 방식을 SNS 전용 `/zk/sns/` 경로에 적용했다. 요청당 30초 제한, 최대 3회 시도, 성공 캐시 공유, 실패 캐시 제거를 사용한다. 팀의 입장 인증 계약·테이블·마이그레이션은 가져오지 않았다.
- `collecting` 동안에는 준비 안내를 표시하고, `requested`에서 수신자에게 동의 버튼을 표시한다. 취소 버튼은 이 단계의 요청자에게만 표시한다. 양측 동의 후에는 공개 준비 상태를 표시한다.
- 브라우저 승인 실패 시 진행 중 플래그를 해제하고 명시적인 재시도를 제공한다. 재시도는 같은 요청·intent·이미 생성한 거래를 재사용하며, 서버 승인 확인과 양쪽 암호문 조건을 건너뛰지 않는다.
- 조사 당시 최근 사용자 요청은 취소 상태였고 승인 intent/relay 기록이 없었다. 이것만으로 실기기에서 발생한 모든 원인을 단정할 수는 없다. 수정 전 production의 실제 Gemini·Devnet Chromium 통합 테스트는 3.4분에 통과했다.
- 로컬 UI 80개와 자산 재시도 단위 테스트 2개가 통과했다. 실제 장애 복구 검증은 아래 명령으로 실행한다. Worker 최초 실패와 자산 다운로드 최초 503만 주입하며, 재시도 이후 증명·거래 제출·원장 확인·복호화는 실제 서비스를 사용한다.

```sh
WEB_TEST_BASE_URL=https://zkiss.vercel.app ZKISS_LIVE_E2E=1 ZKISS_REAL_SNS=1 \
  ZKISS_REAL_AI=1 ZKISS_EXPECT_GENERATED_IMAGES=1 ZKISS_TEST_PROOF_RECOVERY=1 \
  npm run test:web -- backend.spec.ts
```

수정본 production에서 위 장애 주입 통합 테스트가 Chromium 3.8분, WebKit 3.5분으로 모두 통과했다(총 7.2분). 실제 Gemini·Devnet을 사용했고 양쪽 복호화·복사·새로고침 복원도 확인했다. WebKit 자동화는 iPhone 실기기 검증을 대체하지 않는다.

### SNS 방 키의 브라우저 호환성 수정 — 2026-09-27

실기기 추가 제보 당시 서버에서는 한쪽의 공개 키 자료가 등록되지 않아 요청이 `collecting`에 머물렀고, 체인 승인 단계에는 도달하지 못했다. SNS 방 키 구현이 브라우저의 기본 X25519 지원에 의존하는 반면, 프로필 암호화는 이미 호환 구현을 사용하고 있었다. 기본 X25519에 `NotSupportedError`를 주입했을 때 기존 SNS 구현의 실패를 재현했다. 해당 실기기의 오류 코드까지 확보한 것은 아니므로 모든 실기기 실패 원인을 이것으로 단정하지 않는다.

- SNS HPKE도 `@hpke/dhkem-x25519`를 사용한다. 암호화 방식과 서버·계약의 검증 조건은 유지한다.
- 새 방 키는 기기의 AES-GCM 암호화 저장 형식 v3에 보관한다. 기존 v2 PKCS#8 키도 기본 X25519 가져오기 없이 복원해 공개 키와 슬롯을 유지한다. 사이트 데이터 삭제는 필요하지 않다.
- 공개 자료 준비 실패 시 실제 요청 상태를 유지하고 재시도 안내를 표시한다.
- 기본 X25519를 비활성화한 Chromium·WebKit에서 신규 키와 기존 v2 키의 저장·복원·암복호화 테스트 4개 통과. 공개 패널을 포함한 이번 브라우저 실행은 8개 통과. Midnight 단위 테스트 57개와 프론트 타입 검사·production 빌드도 통과했다.

실서비스 호환성 검증 명령:

```sh
WEB_TEST_BASE_URL=https://zkiss.vercel.app ZKISS_LIVE_E2E=1 ZKISS_REAL_SNS=1 \
  ZKISS_REAL_AI=1 ZKISS_EXPECT_GENERATED_IMAGES=1 ZKISS_NO_NATIVE_X25519=1 \
  npm run test:web -- backend.spec.ts --project=mobile-webkit
```

위 명령으로 production 배포 `dpl_3hrXezybKV58EyNrec6nHmpWGJ2B`의 WebKit 통합 테스트가 3.6분에 통과했다. 실제 Gemini 생성, 양측 승인·서버 대납·원장 확인, 복호화·복사·새로고침 복원을 검증했다. DB에서도 공개 상태 `released`와 승인 작업 두 건의 `succeeded`를 확인했다. 테스트 프로필 두 개만 피드에서 제외했다. 기본 X25519 미지원 조건은 테스트에서 주입했으며, 수정 후 iPhone 실기기 재검증과 공개 테스트넷 검증은 별도다.

### 동의 UI와 사전 준비 — 2026-09-27

- 최초 클릭은 본인의 공개 동의다. 상대방에게 닉네임을 넣은 안내와 `공개 동의` / `공개 거절`을 제공한다. `collecting` 중에도 동의할 수 있지만 조건 확정 전에는 승인 intent를 만들지 않는다. 거절은 현재 요청만 종료한다.
- 대화방 조회의 `chainPreparation`은 공개 체인 문맥, 방 ID, 본인 슬롯, 준비 상태를 제공한다. 인증된 `PUT /conversations/:id/chain-slot`은 본인 슬롯만 최초 등록하고 동일 값 재전송을 허용한다. 양쪽 슬롯이 모이면 대화방별 `open` 작업을 한 번 등록한다. 기존 요청에서 사용한 방과 슬롯을 유지한다.
- 마이그레이션 `008_room_preparation.sql`은 `open` 작업 종류와 대화방 준비 상태를 추가한다. 계약은 바꾸지 않는다. 방 만료는 대화 종료와 원장의 행사 종료 중 이른 시각으로 제한하고 공개 요청은 기존 10분 만료를 유지한다.
- 슬롯 비밀은 기기의 AES-GCM 암호화 IndexedDB 저장소로 옮긴다. 기존 방의 비밀과 sessionStorage 값을 복원하며 다중 탭 생성은 원자적인 최초 저장으로 정한다. 기존 슬롯과 불일치하면 교체하지 않는다. 프로필 원문 복구나 기기 변경 복구 기능을 추가한 것은 아니다.
- 대화방 진입 시 Worker·WASM·승인 파일·2p16 파라미터를 예열하고 승인에 재사용한다. 유휴 Worker는 2분 후 정리하고 진행 중 증명은 유지한다. 예열 실패는 공개 시 재시도한다.
- 대화 화면은 기존 SSE로 공개·방 준비·승인 작업 변화를 받아 갱신한다. 재연결 시 EventSource cursor를 사용하고 이벤트를 합친다. 연결 실패 시 5초 폴링, 화면 복귀 시 즉시 조회로 복구한다. 피드·호감 화면은 신규 프로필 발견을 위한 기존 폴링을 유지한다. 다른 화면 알림 UI는 추가하지 않는다.
- `SNS_TIMING`의 initialization/proving, 서버의 sns.room_open/relay_prepare/relay_submit은 밀리초만 기록한다. 비밀이나 SNS 원문을 기록하지 않는다. 대납은 기존 단일 지갑·직렬 작업을 유지한다.

검증: 백엔드 87개, Midnight 단위 테스트 57개, 추가 모바일 UI·준비 테스트 22개, 기본 X25519 미지원 암호화 호환 테스트 4개가 통과했다. 타입 검사와 production 빌드가 통과했다. 별도 `zkiss-preparation-test` Devnet과 격리 DB 스키마를 사용했고 기존 로컬 API·워커 및 공유 팀 DB는 변경하지 않았다. 별도 체인은 기존 로컬 proof-server의 증명 계산 서비스만 공유한다.

수정 전 production WebKit 속도 기준 측정은 Gemini 작업의 `AI_UNAVAILABLE`로 프로필 생성 단계에서 실패했다. 따라서 이 실행을 SNS 대기 시간의 전후 비교 근거로 사용하지 않는다. 휴대폰 Safari 실기기 수치는 자동화 결과와 별도다.

별도 Devnet WebKit 통합은 기본 X25519를 비활성화한 상태에서 통과했다(전체 6.2분, AI는 합성 응답). 요청부터 수신자 동의 버튼까지 2.19초, 양측 동의 이후 공개까지 341.1초였고, 브라우저 증명 계산이 각각 약 275초를 차지했다. 예열 이후 승인 시 initialization은 0ms로 기록됐다. 이 수치는 개발 서버의 자동화 결과이며 iPhone 실기기 속도나 전후 개선율을 의미하지 않는다. 느린 방 등록 중 거절하는 추가 경쟁 조건 테스트 1개도 통과했다.

GCP 전용 DB 백업 후 마이그레이션 008을 적용하고 API·워커를 교체했다. Vercel production 배포는 `dpl_D9xDyn3ejDtuiszzT7aet1vFxZ3j`이다. 기존 계약·원장·사용자 데이터를 초기화하지 않았다.

배포 후 실제 Gemini 생성은 성공했지만, 첫 통합 재검증에서 Vercel 프록시의 공유 IP 기준 API 제한 때문에 호감 요청이 429로 막혔다. 유효한 DB 세션을 확인한 요청만 사용자별 제한으로 분리했다. 세션 생성·미인증·위조 쿠키는 기존 IP 제한을 유지한다. 사용자 간 제한 분리와 위조 쿠키 우회 방지 테스트가 통과했다.

요청 제한 수정까지 포함한 최종 백엔드 전체 실행은 89개 테스트가 통과했다. 이번 검증용 로컬 API·워커·Devnet은 종료했고 격리 DB 스키마도 정리했다. 기존 로컬 서비스는 유지했다.

공개 자료/조건 확정과 동의·거절 클릭이 겹치는 `VERSION_CONFLICT`는 같은 요청의 최신 상태를 읽고 최대 3회 안에서 재시도한다. 새 요청으로 동의를 이전하지 않으며, 서버의 연락처·기기 키 버전 검사와 실제 조건 검증은 유지한다. Chromium·WebKit 경쟁 조건 테스트도 통과했다. 이를 반영한 최종 프론트 배포는 `dpl_5Z62sRqmran6oQU3xKGL6ptpPMB2`이다.

최종 production 통합 테스트 두 개가 통과했다(Chromium 6.3분, WebKit 6.5분, 총 12.8분). 실제 Gemini 소개·이미지 생성, 기본 X25519 미지원 조건, 방 사전 등록 완료, 거절→재요청, 양측 승인·대납·원장 확인, SNS 복호화·복사·새로고침 복원을 검증했다. 이번 결과의 AI는 합성 응답이 아니다.

| 배포본 자동화 | 요청→상대 동의 버튼 | 양측 동의→공개 | 각 브라우저 증명 계산 |
| --- | --- | --- | --- |
| Chromium | 0.84초 | 301.1초 | 약 248초 |
| WebKit | 1.54초 | 300.9초 | 약 253초 |

승인 시 재사용한 Worker의 initialization은 양쪽 모두 0ms였다. 약 5분의 전체 대기를 즉시 공개로 개선했다고 표현해서는 안 된다. 현재 가장 큰 병목은 단말 증명 계산이며, 요청 전 방 등록·파일 준비와 상태 반영 지연을 줄인 결과다. 수정 전 기준 측정이 Gemini 실패로 중단됐으므로 전후 단축률은 제시하지 않는다. iPhone 실기기 재측정과 공개 테스트넷 검증은 미완료다.

최종 DB 확인에서도 공개 완료 2건(`released`), 거절 2건(`rejected`), 승인 작업 4건(`succeeded`)을 확인했다. 이번 실행에서 만든 테스트 프로필 9개만 피드에서 제외하고 해당 세션을 종료했으며 검증 기록은 보존했다.

### Safari 사진 업로드 — 2026-09-27

운영 로그에서 실패한 업로드의 `expectedVersion` 필드와 사진 파트가 모두 없는 것을 확인했다. 버전만 헤더로 전달한 이전 수정은 사진 본문 누락을 해결하지 못했다. WebKit에도 디스크 기반 File/FormData 업로드가 빈 본문으로 전송되는 보고가 있다(https://bugs.webkit.org/show_bug.cgi?id=319985). 동일한 원인의 모든 발생 조건을 재현했다고 주장하지 않는다.

사진을 선택할 때 파일 바이트를 읽어 메모리에 복사한 뒤에만 준비 완료로 표시한다. 화면 전환 후에도 원본 파일 핸들에 의존하지 않으며, multipart 본문은 경계·필드·사진 바이트를 명시적으로 조합한 Uint8Array로 전송한다. 서버의 파일 형식·크기·프로필 버전 검증은 유지한다. 임시 헤더 대체 처리와 업로드 진단 계측은 제거했다.

검증: JPEG/PNG/WebP 바이트 해시 및 버전이 서버까지 동일하게 도착하는 회귀 테스트, 읽기 실패·불완전한 파일·누락/잘못된 버전 거절, 기존 프로필 테스트를 통과했다. 배포된 서비스의 Chromium/WebKit에서 JPEG·PNG 업로드 및 실제 Gemini 결과를 검사한다(`ZKISS_UPLOAD_LIVE=1 WEB_TEST_BASE_URL=https://zkiss.vercel.app npm run test:web -- upload-live.spec.ts --workers=1`). 실제 macOS Safari 비공개 창에서도 588×420 JPEG를 파일 선택기로 선택하고 실제 Gemini 소개·이미지 생성 완료를 확인했다. 이 기록은 iPhone 실기기 검증을 뜻하지 않는다.
