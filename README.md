# ZKiss

Midnight를 활용해 행사 참가자의 자격과 매칭 상태를 검증하는 프라이버시 중심 번호팅 **모바일 웹 서비스**입니다. 참가자는 행사 QR로 브라우저에 들어와 사진 원본 대신 AI 인상 소개를 보고 서로 관심을 표시합니다. 매칭 후에는 익명으로 대화하고, 원할 때만 별도로 SNS ID 공개에 동의합니다.

제품의 사용자 흐름과 데이터 경계는 [PROJECT.md](PROJECT.md)에 정리했습니다.

## 현재 구현 범위

이 저장소에는 **모바일 웹 프론트엔드 데모와 축제 매칭 Compact 계약 시제품**이 있습니다. 웹은 Figma의 지정 화면과 로컬 상호작용을 구현했고, 계약은 행사 티켓 등록·익명 참가, 카드 해시 등록, 상호 관심, 암호화 연락처 게시 경로를 검증합니다. 두 구현은 아직 연결되지 않았습니다.

| 구현·검증된 시제품 | 아직 구현·검증되지 않은 제품 기능 |
|---|---|
| Compact 회로, 시뮬레이터 테스트, Local Devnet E2E 코드; 모바일 웹 화면과 로컬 입력·메시지·SNS 대기 상태 | 실제 QR 자격 검증, AI 인상 생성과 서버 사진 삭제, 실시간 익명 채팅, 결제, 자유로운 대화 종료, 서버·계약의 별도 양측 SNS 공개 승인 |

시제품의 `revealContact`는 매칭 참여자가 암호문을 게시하는 기능입니다. **양쪽의 별도 공개 동의나 동시 교환을 보장하지 않습니다.** 시제품의 공유 비밀을 아는 상대는 일방적 관심을 알아낼 수 있습니다. 프로필 카드는 작은 AI 예시 이미지와 4줄 인상 소개를 표시하며 원본 사진 공개·교환은 하지 않습니다. 실제 AI 이미지 생성과 사진 처리·삭제 경로는 아직 구현되지 않았습니다.

## 실행

### 모바일 웹

```bash
npm ci
npm run dev
```

[행사 입장](http://localhost:5173/)부터 프로필 생성 흐름을 체험하거나, [화면 미리보기](http://localhost:5173/preview)에서 구현된 화면·상태를 개별 확인할 수 있습니다. 프로필 수정 링크는 기존 입력 폼으로 연결되며 별도 저장 API는 없습니다. Figma의 아이폰 상태바와 Safari 주소창은 웹에 중복 구현하지 않습니다.

```bash
npm run build
npx playwright install chromium webkit
npm run test:web
```

사진 버튼은 준비 상태만 바꾸며 실제 파일 선택·업로드는 하지 않습니다. AI 문구·매칭·대화 상대는 예시입니다. 입력 정보와 메시지는 메모리에만 존재하여 새로고침 시 초기화됩니다. SNS 요청은 대기 상태로 전환되며 자동 승인되지 않습니다. `/preview/shared`는 양쪽이 동의한 상태를 명시적으로 주입하는 디자인 확인용 화면입니다. 실제 SNS 계정이나 외부 링크는 포함하지 않았습니다. 상세 구조와 경계는 [web/README.md](web/README.md)를 참고하세요.

### 계약 시제품

필요한 도구: Node.js 22 이상, Docker, [Compact CLI](https://docs.midnight.network/) 0.31.1. 고정된 SDK 의존성은 `package-lock.json`을 따릅니다.

```bash
npm ci
npm run compact
npm test
```

`npm test`는 회로 로직을 시뮬레이터에서 검사합니다. 실제 ZK 증명과 Local Devnet 거래를 실행하려면:

```bash
npm run devnet:up
curl http://127.0.0.1:6300/version
npm run e2e
npm run devnet:down
```

첫 기동에서는 증명 서버 준비에 시간이 걸릴 수 있습니다. `curl` 명령이 버전을 반환한 뒤 E2E를 시작합니다. E2E는 **하나의 프로세스와 수수료 지갑**에서 사용자들을 모사합니다. 실제 휴대폰 두 대의 사용 경험을 검증한 결과는 아닙니다.

## 구조

```text
web/src/pages/                          지정된 Figma 화면과 로컬 상호작용
web/src/components/                     헤더·버튼·하단 메뉴 등 공통 컴포넌트
web/src/state/                          메모리 기반 데모 상태와 SNS 공개 조건
web/public/assets/                      Figma 원본 SVG·AI 프로필 예시 이미지
web/tests/                              모바일 Chromium·WebKit 흐름 테스트
contract/src/festival-match.compact       축제 매칭 계약 시제품
contract/src/test/festival-match.test.ts 시뮬레이터 테스트
e2e/src/festival-match.e2e.test.ts       Local Devnet 거래 시나리오
e2e/src/wallet.ts                        개발용 지갑·연결 코드
e2e/src/wasm-prover.ts                   로컬 WASM 증명 경로
devnet.yml                               Local Devnet 구성
```

Compact 0.31.1, `compact-runtime` 0.16.0, `midnight-js` 4.1.1, `ledger-v8` 8.1.0 조합을 사용합니다. 개발용 참가권은 실제 학생·행사 참가 여부를 확인하지 않습니다. AI 소개의 진실성이나 사진 삭제는 ZK가 증명하지 않습니다.

## 출처

`e2e/src/wallet.ts`는 [midnightntwrk/example-counter](https://github.com/midnightntwrk/example-counter)의 Apache-2.0 라이선스 지갑·프로바이더 코드를 수정해 사용했습니다.

프론트엔드 연동 인계: [미구현 기능 및 백엔드·Midnight 협의 항목](docs/FRONTEND_HANDOFF.md).
