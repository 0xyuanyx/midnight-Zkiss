# ZKiss Midnight 프로토콜 v1 (zkiss-midnight-v1)

작성: 2026-09-25 · 상태: **구현 제안(사용자 미확정)**. 기준 문서: `docs/MIDNIGHT_SPEC.md`(main 체크아웃, 미추적), `docs/MIDNIGHT_ADAPTER_CONTRACT.ts`.

이 문서는 M01–M04를 하나의 행사별 Compact 계약(`contract/zkiss.compact`)으로 구현하기 위한 프로토콜 결정이다. "결정"은 이 구현이 채택한 값이며, 제품 정책(D01–D07) 승인이 아니다. 사용자 확인이 필요한 항목은 §7에 모았다.

## 1. 신뢰 경계 (MIDNIGHT_SPEC 선택안 A)

- 백엔드(운영자)는 참가자·방·호감·답변자 관계를 안다. 이 프로토콜은 **공개 원장 관찰자와 대화 상대**에 대해서만 익명 방 슬롯 ↔ 참가 기록/프로필의 연결을 숨긴다.
- 운영자는 (a) 참가권 leaf 등록, (b) 방 슬롯 두 개 등록, (c) 방 종료를 할 수 있다. 운영자는 사용자 비밀(티켓 비밀·SNS 원문·수신 키 개인키)을 받지 않으므로 **사용자의 참가 증명이나 SNS 동의를 대신 만들 수 없다**. 단, 운영자가 자기에게 티켓을 발급하고 가짜 참가자로 방을 여는 것은 막지 못한다(발급자 신뢰, D03).
- 승인 후 SNS 암호문 전달은 백엔드/단말 책임이다. 체인은 "같은 조건에 두 슬롯 소유자가 각각 동의했다"만 검증한다. 서버의 조기 전달을 암호학적으로 막지 않는다(MIDNIGHT_SPEC §5).

## 2. 비밀과 파생값 (모두 `persistentHash`, 도메인 분리)

| 값 | 정의 | 보관/공개 |
|---|---|---|
| `s` 티켓 비밀 | 단말에서 생성한 32바이트 난수 | 단말만. 발급자에게도 주지 않음 |
| ticketLeaf | H("zkiss:v1:ticket", s) | 단말 → 발급자 → `tickets` 트리 (공개) |
| nullifier | H("zkiss:v1:nullifier", eventScope, s) | admit 시 공개. 행사(계약)별 범위 |
| admittedLeaf | H("zkiss:v1:admitted", eventScope, s) | admit 시 `admitted` 트리에 공개 삽입. 이후엔 경로 증명으로 root만 공개 |
| slot | H("zkiss:v1:slot", eventScope, roomId, s) | 단말 → 백엔드 → openRoom (공개). 방마다 다름 |
| recipientKeyCommit | H("zkiss:v1:rk", roomKeyPub) | 방 전용 X25519 공개키 커밋. 프로필 키와 무관 |
| contactCommit | persistentCommit(contact(64B), salt) | SNS 원문·salt는 단말 보관, 승인 후 봉투로만 전달 |

동일 `s`를 여러 행사에서 쓰더라도 nullifier/slot은 eventScope가 달라 연결되지 않는다. 그래도 **행사마다 새 `s`를 생성**하는 것을 단말 기본값으로 한다.

## 3. 회로

| 회로 | 호출자 | 검사 | 공개 효과 |
|---|---|---|---|
| issueTicket(leaf) | 운영자 | 운영자 비밀, 행사 종료 전 | tickets에 leaf |
| admit(bindingHash, expiresAt) (M01) | 참가자 | 티켓 경로(과거 root 허용), 행사·intent 기한, nullifier·bindingHash 미사용 | nullifier, admittedLeaf, admissions[bindingHash]=expiresAt |
| openRoom(roomId, slotA, slotB, expiresAt) (M02) | 운영자 | 운영자, 미등록 방, slotA≠slotB, 기한 | rooms[roomId] |
| approveReveal(bindingHash, expiresAt, roomId, terms) (M03) | 슬롯 소유자 | 방 열림·기한, intent·terms 기한, slot 소유(s), admittedLeaf(s) 경로, 내 키/연락처 커밋 opening, 같은 슬롯의 중복 승인·bindingHash 재사용 금지 | approvedA 또는 approvedB[transcript]=roomId, consents[consentKey(bindingHash, 내 slot)] |
| closeRoom(roomId) (M04) | 운영자 | 운영자 | rooms[roomId].open=false |
| leaveRoom(roomId) (M04) | 슬롯 소유자 | slot 소유(s) | rooms[roomId].open=false |

- transcript = H(struct{ "zkiss:v1:reveal", kernel.self(), eventScope, roomId, slotA, slotB, terms }), terms = { requestNonce, expiresAt, keyCommitA, keyCommitB, contactCommitA, contactCommitB, policyVersion }. 회로 안에서 계산하므로 **다른 조건의 승인은 다른 transcript**가 되어 합쳐지지 않는다. 계약 주소가 들어가 다른 계약/네트워크 배포로의 재사용을 막는다.
- 최종 승인(`authorized`) = approvedA[transcript] ∧ approvedB[transcript] ∧ rooms[roomId].open ∧ 체인 시간 < min(terms.expiresAt, room.expiresAt)은 승인 시점에 검사됨. 방이 닫힌 뒤의 승인은 회로에서 거절되고, 이미 최종 승인된 요청도 방이 닫히면 read adapter가 `failed/ROOM_CLOSED`로 판정한다(늦은 승인이 방을 다시 열지 못함).
- 각 승인자는 **자기 슬롯의** 키·연락처 커밋 opening만 증명한다. 상대 슬롯 필드는 상대 승인이 같은 transcript를 가리킬 때만 의미가 생긴다.

## 4. bindingHash (백엔드 binding-v1과의 연결)

- 백엔드가 준 `bindingHash`(binding-v1 직렬화 SHA-256, 64자 hex)를 **재계산하지 않고** 32바이트로 해석해 회로 공개 인자로 넣는다. ZK 증명이 이 공개 인자를 포함하므로 거래를 복사해도 bindingHash를 바꿀 수 없다.
- 권한 판정은 tx 존재가 아니라 원장 효과로 한다: admission → `admissions[bindingHash]` 존재·expiresAt 일치. reveal → `consents[consentKey(bindingHash, 기대 슬롯 값)]`의 transcript·slot·expiresAt이 prepare 때 고정한 값과 일치 + approvedA/B·rooms 상태.
- consent는 (bindingHash, 호출자 슬롯 값)으로 저장된다. 다른 슬롯 소유자가 내 bindingHash를 먼저 써도 다른 키에 기록되므로 내 승인과 verify에 영향이 없다(보안 리뷰 H1). 공개 transcript에는 bindingHash 원문 대신 consentKey가 남는다.
- bindingHash는 참가자 ID 등을 SHA-256으로 감싼 값이라 원장에 공개된다. binding-v1의 nonce가 충분한 난수(≥128비트)여야 관찰자의 사전 대입을 막는다 → **백엔드 요구사항**.

## 5. publicPayload (base64url, 공개 바이트만)

`zkiss-midnight-v1` 고정 레이아웃. 모든 정수는 big-endian, 해시는 32바이트.

```
admission:        0x01 | bindingHash(32) | expiresAtSec(u64) | eventScope(32)
reveal_approval:  0x02 | bindingHash(32) | expiresAtSec(u64) | roomId(32) | slotIndex(u8) | transcript(32)
```

JSON.stringify는 해시 규약으로 쓰지 않는다. 문자열(SNS 원문)은 NFC 정규화 후 UTF-8, 64바이트 zero-pad, 초과 시 거절.

## 6. 봉투(SNS 전달, 체인 밖)

X25519(방 전용 키) ECDH → HKDF-SHA256(salt=transcript, info="zkiss:v1:envelope") → AES-256-GCM(AAD=transcript‖recipientKeyCommit). 평문 = contact(64) ‖ salt(32). 수신 단말은 복호화 후 `contactCommit(contact, salt)`가 최종 transcript의 상대 슬롯 커밋과 같을 때만 S20을 표시하고, 아니면 N06 실패.

## 6.1 보안 리뷰 반영 (2026-09-25, Midnight Expert security-reviewer)

| ID | 내용 | 조치 |
|---|---|---|
| H1 | 방 참여자가 남의 bindingHash로 consent를 선점해 승인을 영구 차단 | consent 키 = H("zkiss:v1:consent", bindingHash, 호출자 slot). 계약·adapter·테스트 반영 |
| H2 | `sealContact`가 수신 공개키와 커밋 일치를 검사하지 않아 서버 키 바꿔치기로 SNS 유출 | 봉투 생성 전 `keyCommit(recipientPub) == recipientKeyCommit` 검사 |
| M2 | A·B 동시 승인 시 같은 approvals 항목을 읽고 써서 한쪽 거래 실패 | approvedA/approvedB로 분리 |
| M3 | verify의 상태 조회와 tx 조회 사이 경합 | tx 성공 시 상태를 한 번 더 읽음 |
| L1 | 승인 intent 만료가 체인에서 강제되지 않음 | approveReveal에 intent expiresAt 추가, 회로에서 검사·consent에 기록 |
| L3 | 체인 시간을 모를 때 로컬 시계로 EXPIRED 판정 | `reconciling/CHAIN_TIME_UNAVAILABLE` |
| H3(Medium) | 다른 티켓 보유자가 admit(bh_A)를 선점하면 A의 binding이 A의 티켓 없이 활성화됨(공격자는 자기 티켓만 소모) | **미반영 — 백엔드 binding에 nullifier 필드가 필요**. §7-7 |
| M1 | verify가 입력의 publicPayload를 기대 효과로 사용 | **백엔드 규약**: VerificationInput은 서버가 저장한 PreparedIntent로만 구성(클라이언트 JSON 금지). §7-8 |
| M4 | 한쪽이 상대 봉투를 받은 직후 leaveRoom하면 불공정 교환 | **백엔드 규약**: 두 봉투가 모두 업로드되고 authorized일 때만 동시에 전달. §7-9 |
| L2 | approveReveal이 공개하는 `admitted` root로 승인자 후보가 그 시점 참가자 수로 좁혀짐 | 설계 절충. 작은 행사·이른 승인에서 익명 집합이 작다 |

런타임은 공개 transcript에서 Bytes 값의 끝 0x00 바이트를 잘라 인코딩한다(시뮬레이터 측정). 누출 검사는 잘린 형태로 검색한다.

## 7. 사용자 확인 필요 (구현은 아래 기본값으로 진행)

1. **익명성 경계**: 서버는 답변자·방 참여자를 안다(A안). 공개 원장·상대에게만 숨기는 것으로 충분한가? (D02)
2. **운영자 권한**: 방 개설·종료를 운영자 키 하나로 한다. 운영자 서명 대신 해시 비밀(`H(opSk)`) 방식을 쓴다.
3. **철회 정책(D05)**: 어느 슬롯 소유자든 `leaveRoom`으로 방을 닫을 수 있고, 닫힌 방은 최종 승인이 있어도 전달 불가. 승인 이후 철회를 허용하는 기본값이 맞는가?
4. **세션 갱신(D03)**: 현재 참가권 1장 = admit 1회. 기기 변경·키 분실 시 재바인딩 회로는 미구현(정책 필요).
5. **수수료(D07)**: 참가자 단말이 DUST를 가진 지갑 없이 증명을 만들 수 있게 하려면 대납 구성이 필요하다. 현재 Devnet 검증은 테스트 지갑으로 대납.
6. **Compact 0.31.1 / ledger 8 유지**: 0.34.0은 ledger 9용이라 노드·SDK·증명 서버 조합 확인 전 업그레이드하지 않았다.
7. **H3 admission 선점 방지**: 단말이 `nullifierOf(scope, s)`를 N01 전에 백엔드로 보내고 binding-v1(또는 별도 필드)에 포함 → 계약이 admissions를 H(bindingHash, nullifier)로 저장. binding 스키마 변경이라 Codex·사용자 합의가 필요하다. nullifier는 admit 시 어차피 공개되므로 새 연결은 생기지 않는다.
8. **M1 verify 입력 출처**: 백엔드는 prepare 결과를 저장하고 verify 입력을 그 저장본으로만 만든다(Codex 구현 요구사항).
9. **M4 봉투 동시 전달**: 백엔드가 두 봉투를 모두 받은 뒤 authorized·방 열림을 재확인하고 동시에 전달. 한쪽만 있으면 보류.
