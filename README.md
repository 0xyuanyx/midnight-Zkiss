# ZKiss

**사진 대신 AI 캐릭터로 만나고, 서로 동의할 때만 SNS를 공개하는 모바일 웹.**

ZKiss는 오프라인 행사에서 상호 호감과 대화를 연결하는 서비스입니다. 현재 MVP는 단일 공간에 바로 입장하며, Midnight는 **SNS 상호 공개 승인**에만 사용합니다. 지갑 연결이나 증명 조작을 사용자에게 요구하지 않습니다.

## 사용자 흐름

**바로 입장 → 프로필·AI 캐릭터 생성 → 상호 호감 → 대화 → SNS 공개 요청 → 상대 동의 → 승인 확인 → SNS 확인·복사**

- Gemini가 사진에서 관찰 가능한 특징으로 약 85~100자의 인상 소개와 짧은 태그 두 개를 생성합니다. 사용자가 입력한 MBTI와 함께 표시합니다.
- AI 이미지는 예시의 가상 3D 캐릭터 스타일을 따르며 원본 사진의 헤어·표정·포즈·옷을 참고합니다. 선택한 성별을 반영합니다.
- 자기소개와 AI 소개를 구분합니다. 업로드 원본은 DB에 저장하지 않고, 생성 이미지만 WebP로 저장합니다. 사진은 분석을 위해 Gemini로 전송됩니다.
- 프로필·호감·매칭·대화는 실제 API와 PostgreSQL에 연결됩니다.
- 양측 동의와 체인 승인, 양측 암호문 준비를 모두 확인한 뒤 SNS를 공개합니다. SNS를 누르면 클립보드에 복사합니다.
- 앱 자체의 생성 3회 제한은 제거했습니다. Gemini의 요금·사용량 제한은 별도로 적용됩니다.

## Midnight의 역할과 범위

현재 계약은 `midnight/sns/zkiss.compact`의 **`zkiss-sns-v1`**입니다. 브라우저 Worker가 대화방별 슬롯 소유권과 공개 조건에 대한 승인을 증명하고, 서버가 거래 수수료를 대납합니다. 서버는 원장에서 승인 효과를 확인한 뒤 암호문을 전달하고, 상대 브라우저가 복호화합니다.

SNS 원문·슬롯 비밀·개인키는 서버에 보내지 않습니다. 서버가 인증된 세션을 기준으로 대화 당사자와 슬롯을 연결하는 신뢰 구조이며, 실명이나 행사 참가 자격을 증명하지 않습니다. 기기 내 비밀 보관은 같은 기기에서의 복원을 위한 것이며, 기기 변경 복구는 구현 범위 밖입니다.

**QR 발급, 참가권 발급, 체인 참가 등록, 행사 참가 자격 확인은 이번 MVP에 포함하지 않습니다.** 행사 참가 자격 검증은 향후 기능입니다. 이전 참가권 계약과 테스트는 비교·개발 기록으로 유지합니다.

## 구성

| 경로 | 역할 |
|---|---|
| `web/` | React·TypeScript·Vite 모바일 UI, 실제 세션, 브라우저 증명·복호화 |
| `backend/` | Fastify API, PostgreSQL, Gemini 생성 작업, 거래 대납·원장 확인 워커 |
| `midnight/sns/` | 현재 SNS 공개 전용 Compact 계약과 어댑터 |
| `midnight/src/`, `midnight/contract/` | 이전 참가권 프로토콜과 공통 암호화·지갑 코드 |
| `contract/`, `e2e/` | 초기 행사 매칭 계약 및 Local Devnet 시제품 테스트 |
| `scripts/` | 격리된 로컬 실행, 공개 증명 자산 준비, Vercel 배포 산출물 생성 |

Node.js 22+, Docker, Compact compiler 0.31.1을 사용합니다. Midnight 런타임 조합은 `compact-runtime` 0.16.0, `midnight-js` 4.1.1, `ledger-v8` 8.1.0입니다.

## 실제 로컬 실행

초기 설치·DB·Devnet 배포·인증서 준비 절차는 **[SNS MVP 실행 안내](docs/SNS_MVP.md)**를 따릅니다. 이미 준비된 환경에서는 다음 명령으로 실행합니다.

```sh
npm ci
npm ci --prefix midnight
npm run compact:sns --prefix midnight
npm run prepare:sns-assets
npm run sns:setup
npm run sns:api
```

별도 터미널에서 워커와 프론트를 실행합니다.

```sh
npm run sns:worker
```

```sh
LOCAL_TLS_CERT=/path/to/local.pem LOCAL_TLS_KEY=/path/to/local.key \
  API_PROXY_TARGET=http://127.0.0.1:3003 \
  npm run dev -- --host 127.0.0.1 --port 5176 --strictPort
```

접속 주소는 `https://127.0.0.1:5176`입니다. 브라우저가 신뢰하는 개발용 인증서가 필요합니다. `/`는 실제 API를 사용하고, `/preview`는 예시 데이터로 화면을 확인하는 별도 경로입니다.

`sns:*` 실행 명령은 Gemini 설정만 `backend/.env`에서 읽고, DB는 로컬 `sns_mvp` 스키마로, 계약은 `midnight/.env.sns.local`의 독립 Devnet 배포로 고정합니다. 공유 DB와 팀 워커에 적용하는 명령이 아닙니다.

### 환경변수

| 위치 | 주요 설정 |
|---|---|
| `backend/.env` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `AI_TIMEOUT_MS=120000` |
| `midnight/.env.sns.local` | 로컬 계약 배포 명령이 생성하는 계약 주소·네트워크·운영자 설정 |
| 프론트 개발 서버 | `API_PROXY_TARGET`, `LOCAL_TLS_CERT`, `LOCAL_TLS_KEY` |
| Vercel 배포 빌드 | 선택 사항인 `ZKISS_API_ORIGIN`: 공개 백엔드 HTTPS origin |

프론트에 Gemini 키나 운영자 비밀을 넣지 않습니다. `.env`, 인증서·개인키, 비공개 상태 DB, 생성 결과와 배포 산출물은 Git에서 제외합니다. 외부 API 서버 설정은 [SNS 환경변수 예시](backend/.env.sns.example)를 참고하세요.

## Vercel 배포

현재 구성은 **Vercel 프론트 + 별도 상시 실행 API·워커·PostgreSQL·Midnight 서비스**입니다. Vercel에 프론트를 올리는 것만으로 이 Mac의 로컬 API나 Devnet이 공개되는 것은 아닙니다.

공개 API가 없으면 `/preview`에서 화면을 확인할 수 있으며, 일반 API 요청은 `503 SERVICE_NOT_CONFIGURED`로 응답합니다. 실제 동작으로 가장하는 예시 응답을 반환하지 않습니다.

컴파일된 계약과 공개 증명 자산이 필요하므로 로컬에서 빌드해 `--prebuilt`로 배포합니다. Git push에 의한 자동 배포는 비활성화했습니다.

```sh
npx vercel login
npx vercel link
# 실제 API가 있다면 ZKISS_API_ORIGIN=https://your-api.example.com 지정
npm run build:vercel
npx vercel deploy --prebuilt --prod
```

실제 API를 연결할 때는 백엔드 `PUBLIC_ORIGIN`을 Vercel 운영 도메인으로 지정하고 `SECURE_COOKIES=true`를 유지합니다. Vercel은 `/api/*`를 해당 백엔드로 프록시하여 쿠키와 CSRF 흐름을 같은 origin으로 유지합니다. 로컬 전용 `sns:api` 명령은 origin을 로컬로 고정하므로 공개 서버 실행에 그대로 사용하지 않습니다. DB 마이그레이션과 계약 배포는 별도 운영 절차입니다.

## 검증

```sh
npm run backend:typecheck
npm run backend:test
npm run build
npm run test:sns
npm test --prefix midnight
npm run test:web
```

- 백엔드 81개, SNS 계약 22개, 기존 Midnight 단위 테스트 57개 통과. 타입 검사와 프론트 빌드 통과.
- 이번 배포 준비에서 Chromium·WebKit 화면 테스트 64개 통과. 실제 Devnet 통합 2개는 별도 환경이 필요하여 이번 실행에서는 제외했습니다.
- 실제 Gemini 소개·이미지 생성, 소개와 태그 두 개의 반환을 확인했습니다.
- Chromium·WebKit에서 두 사용자의 실제 Local Devnet SNS 승인·대납·원장 확인·복호화·복사를 검증했습니다. 해당 통합 테스트의 AI 응답은 합성 제공자였으며 실제 Gemini 검증과 구분합니다.
- 휴대폰 실기기, 공개 테스트넷, 배포 환경의 전체 실제 흐름은 별도 검증 대상입니다.

상세 기록: [SNS MVP](docs/SNS_MVP.md) · [프론트–백엔드 연동](docs/FRONTEND_INTEGRATION.md) · [프론트 화면 안내](web/README.md).

## 출처

`e2e/src/wallet.ts`는 [midnightntwrk/example-counter](https://github.com/midnightntwrk/example-counter)의 Apache-2.0 라이선스 지갑·프로바이더 코드를 수정해 사용했습니다.
