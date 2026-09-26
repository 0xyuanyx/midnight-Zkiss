# ZKiss Midnight 연동 v2 — 백엔드 변경 요청 (Midnight → 백엔드)

작성 2026-09-25. 사용자에게 전달한 요청문의 보관본에, Midnight 쪽 구현 결과(모듈 경로·환경 변수)를 덧붙였다.
Midnight 구현: 브랜치 `claude/midnight-integration`의 `midnight/`. `midnight/`, Compact 계약, Midnight SDK 코드는 Codex가 수정하지 않는다.

## 0. 현재 백엔드(946ec85)와 어긋나는 지점
1. **transcriptHash**: 백엔드가 JSON SHA-256으로 직접 계산한다. 계약은 회로 안에서 계산한 transcript만 인정하므로, 백엔드는 `adapter.revealTerms()` 결과를 저장한다.
2. **revealKeys**: 방 전용 키는 단말이 만든다. 요청 생성 시점에 어댑터가 키를 줄 수 없으므로 제거하고, 단말이 `room-material`로 업로드한다.
3. **연락처 커밋 재사용**: vault 커밋 하나를 모든 요청에 쓰면 공개 원장에서 같은 사람의 방들이 연결된다. 요청마다 단말이 새 salt로 만든 커밋을 받는다.
4. **운영자 호출 없음**: 계약 배포, 티켓 발급, 방 등록·종료를 operator 모듈로 worker에서 호출한다.

## 1. 인터페이스 v2
타입 원본(제안): [`src/adapter-contract.ts`](src/adapter-contract.ts). 백엔드 `backend/src/adapters/midnight.ts`를 이것으로 교체하고 이후 두 사본을 동일하게 유지한다.

- `prepare(binding, bindingHash, context: PrepareContext)`: `context.event`(행사별 계약 좌표)는 필수이고, reveal이면 `context.reveal` `{roomId, slotIndex, anonymous}`도 필수다.
- `verify(input)`: 기존과 같다. 입력은 저장된 PreparedIntent로 구성한다.
- `revealTerms(input)` → `{transcriptHash, terms}`: 순수 계산이다. 호출할 때마다 새 requestNonce가 들어간다.
- `revealStatus(event, transcriptHash)` → `awaiting | authorized | closed | unknown`.
- `revealKeys` / `RevealKeyProvider` / `BoundEncryptionKey`는 제거한다.
- `MidnightOperator`(worker 전용): `issueTicket`, `openRoom`, `closeRoom`, `isTicketIssued`, `roomState`.

## 2. Midnight 쪽 구현(사용 방법)

| 용도 | 경로 | 환경 변수 |
|---|---|---|
| `MIDNIGHT_ADAPTER_MODULE`(API·worker) | `midnight/src/node/adapter.module.ts` | `MIDNIGHT_NETWORK`(기본 undeployed), `MIDNIGHT_INDEXER_URL`, `MIDNIGHT_CAPABILITIES`(예: `admission,reveal`; 기본은 모두 false), 선택: `MIDNIGHT_CONTRACT_ALLOWLIST`, `MIDNIGHT_ZK_MANIFEST_URL` |
| `MIDNIGHT_OPERATOR_MODULE`(worker) | `midnight/src/node/operator.module.ts` | `MIDNIGHT_OPERATOR_WALLET_SEED`, `MIDNIGHT_OPERATOR_SECRET`(32바이트 hex), `MIDNIGHT_NODE_URL`, `MIDNIGHT_INDEXER_URL`, `MIDNIGHT_INDEXER_WS_URL`, `MIDNIGHT_PROOF_SERVER_URL`, 선택: `MIDNIGHT_OPERATOR_STATE_STORE` |
| 행사 계약 배포 | `cd midnight && npm run deploy:event -- --event-end <ISO>` | operator와 같다. 출력 JSON의 network·contractAddress·eventScope를 events 테이블에 저장한다 |

- 두 모듈 모두 tsx로 import된다. 의존성은 `midnight/node_modules`에 있으므로 `cd midnight && npm ci`와 `npm run compact`(증명 키 생성)를 먼저 실행해야 한다.
- 운영자 거래는 20–45초 걸린다. HTTP 요청 안이 아니라 worker job으로 처리한다. operator는 내부에서 호출을 한 줄로 직렬화한다.
- 운영자 비밀과 지갑 seed는 비밀 저장소에서 주입하고, 로그·DB·응답에 남기지 않는다.
- 단말 쪽 함수(프론트 연동용, `midnight/src/device.ts`):
  - `newParticipant`, `ticketLeafFor`: 티켓 비밀 생성, leaf 계산
  - `setupRoom`, `roomMaterial`: `room-material` 본문 생성
  - `parseTerms`, `transcriptFor`: 서버가 준 terms 재검증
  - `submitAdmission`, `submitRevealApproval`, `submitLeave`
  - `sealContact`, `openContact`(`src/envelope.ts`, HPKE)

## 3. API·DB 변경

### A. 티켓(참가 전 단계)
- 신규 `POST E/midnight/ticket {ticketLeaf: 64hex}`. 참가자당 1회만 받고, 같은 leaf 재요청만 멱등으로 허용한다.
- `participants.ticket_leaf`와 `ticket_status`(`issuing | issued | failed`)를 저장한다. worker는 `isTicketIssued`로 확인한 뒤 `operator.issueTicket`을 호출한다.
- `issued`가 되면 SSE로 알린다. Z01 admission은 `ticket_status='issued'`일 때만 허용한다.
- 티켓 비밀은 받지 않는다. QR·참가 자격 판정(D03)은 기존 정책을 따른다.

### B. SNS 공개 요청(대체 흐름)
1. **요청 생성** `POST reveal-requests`: revealKeys 호출과 transcript 계산을 제거한다.
   - `conversations.chain_room_id`가 없으면 무작위 32바이트 hex로 생성한다.
   - 상태는 `collecting`이다.
   - DTO에 chainRoomId, eventScope, contractAddress, network를 추가한다. 두 당사자에게만 노출한다.
2. **방 material 업로드** 신규 `PUT E/reveal-requests/{id}/room-material`:
   - 본문: `{slot: 64hex, roomPublicKey: base64 32B, keyCommit: 64hex, contactCommit: 64hex}`
   - 당사자별로 1회 저장하고 형식만 검증한다.
   - 같은 방의 slot은 이후 요청에서도 바뀌면 안 된다. 다르면 409를 반환한다.
3. **양측 material이 모이면 worker가 처리**:
   1. `roomState`가 `absent`면 `operator.openRoom(slotA=a의 slot, slotB=b의 slot, expiresAt=대화 종료 시각)`
   2. `adapter.revealTerms(...)`로 받은 transcriptHash와 terms를 저장하고 상태를 `requested`로 바꾼다(기존 동의 흐름).
   3. 요청 DTO에 terms를 추가한다.
4. **Z01 reveal_approval**: `prepare(binding, bindingHash, {event, reveal: {roomId, slotIndex(a=0, b=1), anonymous}})`. transcriptHash는 저장값과 비교한다(현행 유지).
5. **봉투 업로드**:
   - 형식은 현행 `hpke-x25519-hkdfsha256-aes128gcm-v1`을 유지한다. Midnight 쪽에서 RFC 9180 base mode(hpke-js)로 구현했다.
   - `contextHash`는 transcriptHash다.
   - `recipientKeyVersion`은 상대 room-material의 버전(요청별 1)이다.
   - 상대의 `roomPublicKey`는 room-material에서 제공한다.
6. **`released` 전이 직전**: `adapter.revealStatus(...) === 'authorized'`를 다시 확인한다. 아니면 보류하거나 실패로 처리한다.

### C. 종료
- 대화 종료·차단·정지 시 `chain_room_id`가 있고 방이 open이면 worker가 `operator.closeRoom`을 호출한다(outbox).
- 웹 권한 차단은 지금처럼 즉시 한다. 체인 종료는 그 뒤에 동기화한다.

### D. 제거·유지
- contact-vault: ownerEnvelope 보관은 유지한다. commitment는 SNS 요청에 쓰지 않는다.
- demo 어댑터와 demo operator는 v2 인터페이스로 갱신한다. 체인은 없고, capability demo 규칙은 유지한다.

## 4. 하지 말 것
- transcriptHash, slot, 커밋, 키를 서버가 계산하거나 대체하지 않는다. 형식 검증만 한다.
- 티켓 비밀, 연락처 원문, salt, 방 개인키를 받지 않는다.
- 수수료 대납과 단말 증명(D07)은 구현하지 않는다(미결정). 참가자 거래 제출은 현행 Z02를 유지한다.
- H3(nullifier 바인딩)은 이번 범위에서 제외한다.

## 5. 완료 조건
- v2 fixture 어댑터·operator로 백엔드 테스트를 갱신한다. 다음을 확인해야 한다.
  - 티켓 발급 대기 → admission
  - material 수집 → terms → 양측 동의 → revealStatus 확인 후 released
  - 종료 시 closeRoom job
  - slot 변경 시 409
  - 재시도 멱등성
- `docs/MIDNIGHT_ADAPTER_CONTRACT.ts`를 갱신하고, `BACKEND_API.md`에 신규 API를 반영한다.
- 실제 체인 통합 E2E는 Midnight 담당이 실제 모듈로 수행한다. fixture 통과를 체인 검증으로 표시하지 않는다.
- 변경 파일과 테스트 결과를 `docs/BACKEND_IMPLEMENTATION_STATUS.md`에 추가한다.
