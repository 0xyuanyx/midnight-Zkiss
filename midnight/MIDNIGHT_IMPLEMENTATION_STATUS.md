# Midnight 구현 상태

작성: 2026-09-25 · Midnight Expert 플러그인 사용 · 브랜치 `claude/midnight-integration` · 작업 경로 `midnight/`

프로토콜 결정은 [PROTOCOL.md](PROTOCOL.md), 실행 방법은 [README.md](README.md). 이 문서는 무엇을 구현했고 **어떤 수준까지 실제로 검증했는지**를 구분한다.

## 1. 요약

| 기능 | 구현 | 검증 수준 | adapter capability 권장 |
|---|---|---|---|
| M01 참가 자격 + 웹 세션(bindingHash) 바인딩 | 계약 `admit`, 단말 `submitAdmission`, adapter | 시뮬레이터 + **Local Devnet 실제 증명·노드·인덱서 readback** | Devnet에서 `admission: true` 가능. 실제 발급자·H3 미해결 |
| M02 익명 방 슬롯 + 방 전용 키 | `openRoom`, `slotFor`, `setupRoom` | 시뮬레이터 + Devnet | — |
| M03 같은 요청에 대한 양측 명시 동의 | `approveReveal`, `submitRevealApproval`, `readRevealStatus` | 시뮬레이터 + Devnet | Devnet에서 `reveal: true` 가능. M1·M4 백엔드 규약 전제 |
| 익명 답변 방 SNS 공개 | 위와 같은 경로(슬롯은 방마다 새 해시) | 공개 원장·거래 원문 누출 검사까지. 상대 단말·실사용 메타데이터 분석 없음 | **`anonymousReveal: false` 유지 권장**(§6) |
| M04 방 종료·나가기 | `closeRoom`, `leaveRoom`, adapter `ROOM_CLOSED` | 시뮬레이터 + Devnet | — |
| SNS 봉투 전달 | `sealContact`/`openContact`, RFC 9180 HPKE(hpke-js) | 단위 테스트 + Devnet + **실제 백엔드 released 경로** | — |
| 연동 v2(백엔드 모듈) | `src/node/adapter.module.ts`, `src/node/operator.module.ts`, `npm run deploy:event` | **Codex 백엔드 `e854c49` real 모드 + Devnet 통합 E2E 통과**(§4.4) | — |

adapter는 기본값이 모두 `false`다. `mode: 'demo'`에서는 capability를 켤 수 없다.

## 2. 도구·버전(실제 사용)

- Compact CLI 0.5.1, 컴파일러 0.31.1(`compact compile +0.31.1`), 언어 버전 0.23 → `pragma language_version >= 0.23`
- `@midnight-ntwrk/compact-runtime` 0.16.0, ledger-v8 8.1.0, midnight-js 4.1.1, compact-js 2.5.1, wallet-sdk(facade 3.0.0 등, `package.json` 참고)
- Devnet: midnight-node 0.22.3, indexer-standalone 4.0.0, proof-server 8.0.3(compose 프로젝트 `zkiss-midnight-claude`)
- 최신 컴파일러 0.34.0(ledger 9)은 호환 조합 확인 전이라 사용하지 않았다.
- Node v24.14.1, macOS(aarch64)

기준선: 기존 `contract/`의 로직 테스트 31/31 통과, 기존 `festival-match.compact`도 0.31.1로 재컴파일된다(2026-09-25).

## 3. 변경 파일

모두 `midnight/` 아래에 있다. `backend/`, `backend-compose.yml`, 루트 `package.json`·`package-lock.json`, `docs/`, 기존 `contract/`·`e2e/`는 수정하지 않았다.

- `contract/zkiss.compact`, `contract/witnesses.ts`
- `src/adapter.ts`, `src/adapter-contract.ts`(백엔드 원본 사본), `src/chain-view.ts`, `src/ledger-decoder.ts`, `src/device.ts`, `src/envelope.ts`, `src/encoding.ts`, `src/manifest.ts`
- `test/unit/{zkiss.contract,adapter,encoding-envelope}.test.ts`, `test/devnet/{zkiss.devnet.test.ts,wallet.ts}`, `test/tools/manifest.gen.test.ts`
- `package.json`, `package-lock.json`(midnight 전용), `tsconfig.json`, `vitest.config.ts`, `devnet.yml`(루트 사본, 프로젝트 이름만 변경), `.gitignore`
- `PROTOCOL.md`, `README.md`, 이 문서

컴파일 산출물(`contract/managed/`, 증명 키 약 41MB)과 `reports/`는 루트 `.gitignore` 규칙에 따라 커밋하지 않는다. `npm run compact`로 다시 만든다.

## 4. 검증 결과

### 4.1 정적·로직 (2026-09-25)

| 명령 | 결과 |
|---|---|
| `npm run compact` (증명 키 포함) | 6개 회로 컴파일 성공. approveReveal k=16(35k행), admit k=15, 나머지 k=13 |
| `npm run typecheck` | 오류 없음 |
| `npm test` | **51/51 통과**, 15회 반복 실행 모두 통과 |
| `/midnight-verify:verify`(witness-verifier, 계약 에이전트 실행) | 타입·이름·반환 형태·실행 통과. 빈 트리의 witness 예외 결함을 찾아 수정. 수정 뒤와 보안 수정 뒤에는 다시 실행하지 않음 |

계약 시뮬레이터에서 거절을 확인한 경우:
- 미발급 티켓, 같은 티켓 재참가, bindingHash 재사용, intent·행사 만료
- 비운영자 발급·방 개설·종료, 동일 슬롯 두 개
- 제3자 승인, 미참가 슬롯 소유자 승인, 자기 키·연락처 커밋 불일치
- 같은 슬롯 중복 승인, 서로 다른 terms 승인의 결합
- 종료·나가기 후 승인, terms·방·intent 만료
- 상대 슬롯이 내 bindingHash를 선점한 경우(H1): 내 승인이 막히지 않음

pure `revealTranscript`는 회로가 기록한 transcript와 같고, 다른 계약 주소에서는 값이 달라진다.

### 4.2 Local Devnet 실거래 E2E (`npm run test:devnet`, 2026-09-25 09:33–09:40 KST, 1/1 통과)

실제 ZK 증명(증명 서버)으로 노드에 제출하고, 인덱서에서 contract state를 다시 읽어 `MidnightAdapter.verify()`로 판정했다. 계약 주소 `92868d48…6c12`, 성공 거래 13건, 거래당 20–46초.

| 단계 | 결과 |
|---|---|
| 배포, 티켓 발급 3건, A·B·C admit | 노드 수락 |
| A admission `verify` | `succeeded`(원장 `admissions[bindingHash]` 확인) |
| C의 intent에 A의 txId를 붙임 | `failed:EFFECT_NOT_FOUND` |
| 미발급 티켓 admit, 같은 티켓 재admit, A의 bindingHash를 C가 재사용 | 거절(`ticket not issued` / `ticket already admitted` / `bindingHash already used`) |
| 동일 슬롯 방, 운영자 비밀 사칭으로 openRoom | 거절(`slots must differ` / `not operator`) |
| 서버가 A의 키 커밋을 바꿔치기한 terms | 단말이 거래를 만들지 않음(`OWN_COMMIT_MISMATCH`) |
| 제3자 C 승인, A 중복 승인 | 거절(`not a room member` / `already approved`) |
| A 승인 → `verify` | `succeeded`, 요청 상태 `awaiting [0]` |
| B가 다른 nonce의 terms 승인 | 두 transcript 모두 한쪽만 승인 상태 유지 |
| A가 B의 bindingHash를 선점(H1) 후 B가 정식 승인 | 두 거래 모두 수락, **B `verify` = succeeded**, 요청 `authorized` |
| A 승인 거래 원문(인덱서 raw, 9,108바이트) 누출 검사 | 티켓 비밀·nullifier·admittedLeaf·연락처·salt·방 공개키 모두 **미검출**(끝 0바이트를 잘라낸 형태로 검색, roomId 대조군 검출) |
| 봉투 A→B 봉인·개봉, C의 개봉 시도 | B는 `alice.kim` 복원 + 커밋 일치, C는 실패 |
| B leaveRoom → A 승인 `verify` | `failed:ROOM_CLOSED`, 요청 상태 `closed` |
| 방 종료 뒤 승인 | 거절(`room closed`) |

보안 수정 전 계약으로도 같은 E2E가 한 번 통과했다(09:12–09:19).

**주의 — 거절 케이스의 검증 위치**: Devnet E2E의 거절은 모두 단말의 로컬 회로 실행 단계에서 발생했다. 조작된 증명이나 거래를 노드가 거절하는지는 시험하지 않았다. 노드 쪽 보장은 ZK 검증기와 계약의 공개 transcript 검사(`popeq` 등)에 의존하며, 보안 리뷰에서 컴파일된 코드를 확인했지만 실행으로 검증하지는 않았다.

### 4.3 보안 리뷰 (Midnight Expert `compact-core:security-reviewer`)

Critical 0, High 2, Medium 4, Low 4. 반영 내역은 [PROTOCOL.md §6.1](PROTOCOL.md). High 2건(H1 선점, H2 봉투 키)과 M2·M3·L1·L3는 코드와 테스트에 반영했다. 수정 후 재리뷰는 하지 않았다.

### 4.4 연동 v2 · 실제 백엔드 통합 E2E (2026-09-25 14:00–14:10 KST, 1/1 통과)

- 백엔드: Codex `codex/zkiss-backend` `e854c49`. 별도 detached worktree에서 **real 모드** API와 worker를 실행했다. `ZKISS_MODE=real`, `SECURE_COOKIES=true`, 전용 Postgres는 127.0.0.1:55433.
- 연결: API·worker의 `MIDNIGHT_ADAPTER_MODULE` = `src/node/adapter.module.ts`, worker의 `MIDNIGHT_OPERATOR_MODULE` = `src/node/operator.module.ts`(운영자 지갑 seed 02).
- `AI_PROVIDER_MODULE`에는 **테스트 전용 가짜 AI**(`test/integration/fake-ai.module.ts`, 사진 분석 없음)를 넣었다.
- 행사 계약: `npm run deploy:event`(seed 02 지갑, 새 동기화 + DUST 등록)로 배포하고, 결과를 events 행에 넣었다.
- 드라이버: `npm run test:integration`(`test/integration/backend.int.test.ts`). 두 단말은 HTTP로 백엔드를 호출하고, 증명 거래는 `src/device.ts`로 만든다. 단말 수수료는 genesis 지갑이 냈다.
- Codex 인터페이스 원본(`backend/src/adapters/midnight.ts`)과 두 진입 모듈의 타입 호환은 tsc로 확인했다.

| 단계 | 결과 | 시간 |
|---|---|---|
| 세션 생성(`__Host-` 쿠키) → 프로필 → 가짜 AI 작업 | 성공 | — |
| 티켓 leaf 제출 → worker가 `operator.issueTicket` → `ticket.status=issued` | A·B 성공 | 57초(첫 지갑 동기화 포함) / 23초 |
| admission intent → 단말 증명 → Z02 → worker `verify` → `admissionStatus=active` | A·B 성공 | 증명·제출 24–28초, 판정 1.5초 |
| 게시 → 상호 호감 → 대화방 → 연락처 vault | 성공 | — |
| SNS 요청 → 양측 room-material → worker가 `openRoom` + `revealTerms` → `requested` | 성공. 단말 재계산 transcript = 서버 저장값 | 21초 |
| B 수락 → 양측 reveal_approval intent → 단말 증명(terms 재검사) → Z02 → worker `verify` ×2 → `authorized` | 성공. 체인 readback도 `authorized` | 증명 30초씩 |
| 양측 HPKE 봉투 업로드 → 백엔드 `revealStatus` 재확인 → `released` → 상대 봉투 개봉 | A는 `밥_99`, B는 `alice.kim` 복원. 연락처 커밋 일치 | — |
| A 나가기 → worker close job → `operator.closeRoom` → 체인 방 `closed` | 성공 | 22초 |

v2 Devnet E2E(`npm run test:devnet`, 11:22–11:30)도 모두 통과했다. 운영자 모듈 경로(배포·발급·방 등록·종료), 어댑터 v2, H1 선점 방지, HPKE 봉투, 공격 거절을 다뤘다.

별도로 배포 CLI와 `operator.module.ts`를 환경 변수만으로 실행해 실제 지갑 경로를 확인했다. 배포 55초, 티켓 발급 25초였다.

## 5. 공개 transcript / 원장 공개 범위

| 회로 | 공개됨 | 공개되지 않음 |
|---|---|---|
| admit | bindingHash, intent 만료, tickets root, nullifier, admittedLeaf | 티켓 비밀, 어떤 티켓 leaf인지 |
| openRoom | roomId, slotA, slotB(방별 해시), 만료 | 슬롯 주인의 티켓·참가 기록 |
| approveReveal | consentKey(bindingHash, 슬롯), intent 만료, roomId, terms(커밋들), 사용한 admitted root, 승인한 슬롯이 A인지 B인지 | 티켓 비밀, nullifier, admittedLeaf, 방 공개키 원문, 연락처, salt |
| leaveRoom | roomId, 방이 닫힘 | 어느 슬롯이 나갔는지, 티켓 비밀 |

런타임은 Bytes 값을 공개 transcript에서 끝 0x00 바이트를 잘라 인코딩한다. 누출 검사 도구를 만들 때 이 점을 고려해야 한다.

## 6. 미검증·미구현·한계

- **두 휴대폰 브라우저 검증 없음.** 모든 E2E는 한 Node 프로세스가 참가자별 private state를 나눠 실행했다. 브라우저 WASM 증명, IndexedDB private state, 키 복구는 미실험이다.
- **수수료**: 테스트 지갑(genesis)이 모든 거래의 수수료를 냈다. 대납 서버를 쓰면 그 서버가 admit·approveReveal 거래의 제출 시각과 IP를 연결할 수 있다(D07 미결정).
- **증명 위치**: E2E는 로컬 증명 서버를 썼다. 증명 서버는 witness(티켓 비밀·연락처)를 본다. 단말 WASM 증명(`@midnight-ntwrk/zkir-v2`)은 기존 계약에서만 실험됐고 zkiss 계약에서는 하지 않았다.
- **anonymousReveal**: 공개 원장·거래 원문에서 슬롯과 참가 기록의 연결이 보이지 않는 것까지 확인했다. 다만 다음이 남아 있어 `false` 유지를 권장한다.
  - admitted root 공개로 익명 집합이 좁혀짐(L2)
  - 수수료·타이밍 메타데이터
  - 서버가 관계를 앎(A안)
  - 사용자 확정 전
- **H3**(다른 티켓 보유자의 admit 선점)은 미해결이다. binding에 nullifier를 넣는 백엔드 스키마 변경이 필요하다.
- **백엔드 규약 전제(Codex 구현 필요)**:
  - M1: verify 입력은 저장된 PreparedIntent로만 만든다.
  - M4: 두 봉투가 모두 모인 뒤 동시에 전달한다.
  - binding-v1 nonce는 128비트 이상이어야 한다.
  - roomId와 슬롯 매핑을 저장한다(v2에서는 `context.reveal`로 전달).
- **인덱서 신뢰**: readback은 인덱서를 신뢰한다. 운영 시 자체 인덱서를 권장한다. 블록 timestamp는 Devnet에서 밀리초로 확인했고, 다른 네트워크는 확인하지 않았다.
- **발급자**: 운영자 비밀은 해시 비교 방식이다. 실제 학생·행사 인증 발급자는 없다(개발용).
- **세션 재바인딩·키 복구**, 철회 정책(D05), 채팅 암호화(D06)는 범위 밖이다.
- **Preprod·Mainnet 배포 없음.**

## 7. 연동 상태

- 연동 v2 요청문은 [CODEX_HANDOFF_V2.md](CODEX_HANDOFF_V2.md)다. Codex가 `e854c49`에서 그대로 반영했고, §4.4 통합 E2E로 확인했다.
- §6의 백엔드 규약 중 M1(저장본으로 verify), M4(두 봉투를 모아 released), nonce 32바이트, room/slot 저장(`context.reveal`)은 백엔드에 반영된 것을 코드와 통합 E2E로 확인했다.
- 남은 연결:
  - 모바일 프론트에 `src/device.ts`·`src/envelope.ts` 연결(브라우저 증명·private state 저장)
  - 수수료 대납(D07)
  - Preprod 배포
  - 실제 AI 제공자
- 두 브랜치(`claude/midnight-integration`, `codex/zkiss-backend`)는 아직 합치지 않았다. 백엔드는 `midnight/` 모듈을 절대 경로로 불러온다.
