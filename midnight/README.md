# ZKiss Midnight 패키지

저장소 루트의 `midnight/`에 포함된 독립 패키지다. 루트 npm workspace에 등록되어 있지 않으므로 이 폴더에서 별도로 의존성을 설치한다. 자체 `package-lock.json`을 쓴다.

- 프로토콜: [PROTOCOL.md](PROTOCOL.md)
- 구현·검증 상태: [MIDNIGHT_IMPLEMENTATION_STATUS.md](MIDNIGHT_IMPLEMENTATION_STATUS.md)

## 구조

| 경로 | 역할 | 실행 위치 |
|---|---|---|
| `contract/zkiss.compact` | 행사별 계약. M01 참가·세션 바인딩, M02 방 슬롯, M03 양측 SNS 공개 동의, M04 종료 | 체인 |
| `contract/witnesses.ts` | witness 구현, `ZkissPrivateState` | 사용자 단말 |
| `src/device.ts` | 단말 client: 티켓 비밀 생성, 슬롯 값, 방 키·연락처 커밋, 서버 intent 재검사 후 증명 거래 제출 | 사용자 단말 |
| `src/envelope.ts` | 방 전용 X25519 + HKDF + AES-GCM SNS 봉투, 커밋 검사 | 사용자 단말 |
| `src/adapter.ts` | 백엔드용 `MidnightAdapter`(`prepare`/`verify`), `readRevealStatus` | 백엔드 |
| `src/chain-view.ts`, `src/ledger-decoder.ts` | 인덱서 GraphQL readback, 계약 state 해석 | 백엔드 |
| `src/encoding.ts` | publicPayload·bindingHash·연락처·시간의 고정 인코딩 | 공통 |
| `src/manifest.ts` | zk manifest(회로·인코딩·증명 자산 해시) | 빌드 |
| `src/adapter-contract.ts` | 백엔드 `backend/src/adapters/midnight.ts` 사본(원본은 백엔드) | 공통 |

## 도구 버전(고정)

Compact CLI 0.5.1 · 컴파일러 **0.31.1** · `@midnight-ntwrk/compact-runtime` 0.16.0 · ledger-v8 8.1.0 · midnight-js 4.1.1. Devnet 이미지: node 0.22.3, indexer-standalone 4.0.0, proof-server 8.0.3. 컴파일러 0.34.0은 ledger 9용이라 노드·SDK·증명 서버 조합 검증 전 올리지 않는다.

## 실행

```bash
cd midnight
npm ci
npm run compact          # 전체 컴파일(증명 키 포함, 약 40초)
npm run typecheck
npm test                 # 계약 시뮬레이터 + adapter + 인코딩·봉투 단위 테스트
docker compose -f devnet.yml up -d --wait   # 별도 compose 프로젝트 zkiss-midnight-claude
npm run test:devnet      # 실제 증명·노드 거래·인덱서 readback E2E (약 8분)
npm run manifest         # reports/zkiss-manifest.json
docker compose -f devnet.yml down -v
```

`devnet.yml`은 루트 파일의 사본이며 compose 프로젝트 이름만 다르다(백엔드 쪽 `down -v`와 분리). 포트는 같으므로 두 Devnet을 동시에 띄우지 않는다.

## 백엔드 연결 (연동 v2)

인터페이스는 [src/adapter-contract.ts](src/adapter-contract.ts)이고, 요청문은 [CODEX_HANDOFF_V2.md](CODEX_HANDOFF_V2.md)다. 백엔드(`codex/zkiss-backend` `e854c49`)는 아래 두 모듈을 절대 경로로 불러온다.

| 환경 변수 | 경로 | 실행 위치 |
|---|---|---|
| `MIDNIGHT_ADAPTER_MODULE` | `midnight/src/node/adapter.module.ts` | API, worker |
| `MIDNIGHT_OPERATOR_MODULE` | `midnight/src/node/operator.module.ts` | worker만 |

모듈 설정용 환경 변수는 `src/node/env.ts`에 모여 있다. 비밀은 비밀 저장소에서 주입한다.
- 공통: `MIDNIGHT_NETWORK`, `MIDNIGHT_INDEXER_URL`, `MIDNIGHT_INDEXER_WS_URL`, `MIDNIGHT_NODE_URL`, `MIDNIGHT_PROOF_SERVER_URL`
- 어댑터: `MIDNIGHT_CAPABILITIES`(예: `admission,reveal`. 비우면 모두 false), `MIDNIGHT_CONTRACT_ALLOWLIST`, `MIDNIGHT_ZK_MANIFEST_URL`
- 운영자(비밀): `MIDNIGHT_OPERATOR_WALLET_SEED`, `MIDNIGHT_OPERATOR_SECRET`, 그리고 `MIDNIGHT_OPERATOR_STATE_STORE`

행사를 만들 때는 먼저 계약을 배포하고, 출력의 network·contractAddress·eventScope를 백엔드 events 행에 넣는다.

```bash
npm run deploy:event -- --event-end 2026-10-01T23:00:00Z
```

### 통합 E2E 재현

1. Devnet을 띄운다.
2. 백엔드를 real 모드로 실행한다. API와 worker 모두에 위 모듈과 환경 변수를 준다. AI는 테스트용 `test/integration/fake-ai.module.ts`를 쓴다.
3. 행사를 배포해 events 행을 채운다.
4. 아래 명령을 실행한다.

```bash
IT_BASE_URL=http://127.0.0.1:3101 IT_EVENT_ID=evt_it IT_CONTRACT_ADDRESS=<hex> IT_EVENT_SCOPE=<hex> npm run test:integration
```

주의할 점:
- worker 운영자 지갑과 테스트 단말 지갑은 서로 다른 seed여야 한다. Devnet에서는 01(genesis), 02, 03에 잔액이 있다.
- 결과는 `reports/zkiss-integration.json`에 남는다.

## 새 clone에서 백엔드 실거래 테스트 연결

저장소 루트에서 아래 순서로 준비한다. Compact CLI와 컴파일러 0.31.1이 필요하다. 생성된 managed/ 증명 자산, node_modules/, 실제 .env, 지갑 상태는 Git에 포함하지 않는다.

```sh
npm ci
(cd midnight && npm ci && npm run compact && npm run typecheck && npm test)
MIDNIGHT_SOURCE_DIR="$PWD/midnight" npm run test:devnet -w backend
```

마지막 테스트에는 실행 중인 Local Devnet과 테스트 PostgreSQL이 필요하다. `TEST_DATABASE_URL`로 별도 테스트 DB를 지정할 수 있다. 같은 포트의 기존 Devnet이 있다면 중복으로 띄우지 않는다.

환경변수의 용도·필수 여부·로드 방법은 [.env.example](.env.example), 백엔드 기본 설정은 [../backend/.env.example](../backend/.env.example), Gemini 추가 설정은 [../backend/.env.gemini.example](../backend/.env.gemini.example)을 참고한다. 실제 키와 DB 비밀번호는 별도 비공개 경로로 받는다.

이 패키지 업로드는 모바일 웹의 실제 참가 인증, 거래 대납, SNS 공개 UI 연결 완료를 의미하지 않는다. 현재 한계는 MIDNIGHT_IMPLEMENTATION_STATUS.md를 참고한다.
