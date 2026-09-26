# GCP 시연 서버

현재 SNS MVP의 API·워커·PostgreSQL·독립 Devnet을 Compute Engine 한 대에서 실행한다. 외부에는 Caddy의 80/443만 공개하고 SSH는 IAP로 접속한다. 공개 테스트넷 배포가 아니다.

## 현재 환경

- 프로젝트: `gen-lang-client-0864964814` (Apple)
- VM: `zkiss-mvp`, `asia-northeast3-a`, `e2-standard-2` (2 vCPU / 8GB), 60GB 부팅 디스크
- 프론트: https://zkiss.vercel.app
- API: https://zkiss-34-64-248-231.sslip.io
- 고정 IP: `34.64.248.231`
- 독립 Devnet SNS 계약: `7ace02d225b600e95033e5652427c6f939c5a82693118f0ebf548b06a8103a8e`
- 초기 행사·계약 기한: 2026-10-03 전후. 정확한 만료 시각은 DB와 원장을 확인한다.

```sh
gcloud compute ssh zkiss-mvp --project=gen-lang-client-0864964814 \
  --zone=asia-northeast3-a --tunnel-through-iap
```

## 배포 파일

- `startup.sh`: Ubuntu 24.04 VM에 Docker와 Compose를 설치하고 4GB swap을 준비한다.
- `Dockerfile`: Node 22 기반 API·워커 공용 이미지. `midnight/sns/managed/sns`는 Compact 0.31.1로 미리 컴파일해 배포 번들에 포함해야 한다.
- `compose.yml`: DB, Devnet 노드, 인덱서, 증명 서버, API, 워커, HTTPS 프록시.
- `deploy-contract.ts`: 서버 내부 Devnet에 7일 기한 SNS 전용 계약을 한 번 배포한다. 기존 `/config/contract.env`가 있으면 중단한다.

코드 위치는 `/opt/zkiss/app`, 비밀 설정은 `/opt/zkiss/config`이다. 설정 디렉터리는 0700, 파일은 0600으로 관리하고 소스·이미지에 포함하지 않는다. `app.env`에는 API·DB·Gemini·Midnight 설정, `db.env`에는 PostgreSQL 설정, `indexer.env`에는 인덱서 설정, `proxy.env`에는 `API_HOST`를 넣는다. API의 `PUBLIC_ORIGIN`은 `https://zkiss.vercel.app`이다.

## 시작 순서

VM에서 실행한다. 생성 전용 단계는 기존 환경에 반복하지 않는다.

```sh
cd /opt/zkiss/app
sudo docker compose -f deploy/gcp/compose.yml up -d db node indexer proof-server
sudo docker compose -f deploy/gcp/compose.yml build api
sudo docker compose -f deploy/gcp/compose.yml run --rm api node --import tsx src/cli.ts migrate
sudo docker compose -f deploy/gcp/compose.yml run --rm -v /opt/zkiss/config:/config worker node --import tsx /app/deploy/gcp/deploy-contract.ts
# contract.env의 값을 app.env에 반영한 후
sudo docker compose -f deploy/gcp/compose.yml up -d api worker proxy
```

Vercel은 로컬에서 `ZKISS_API_ORIGIN=https://<API_HOST> npm run build:vercel`로 빌드하고 `npx vercel deploy --prebuilt --prod`로 연결한다. Gemini 키는 GCP API 서버에서만 사용한다.

## 운영

PostgreSQL, 체인 데이터, 인덱서, 운영자 비공개 상태, 공개 증명 파라미터, TLS 인증서는 Docker volume에 보존한다. `docker compose down -v`는 이 데이터를 삭제하므로 실행하지 않는다. 증명 서버는 upstream 버전의 witness 로그 노출을 피하기 위해 로그를 저장하지 않는다. 나머지 컨테이너 로그는 크기를 제한한다.

```sh
sudo docker compose -f /opt/zkiss/app/deploy/gcp/compose.yml ps
sudo docker stats --no-stream
```

VM 정지 중에는 실제 API와 SNS 승인을 사용할 수 없다. 디스크와 고정 IP 등은 VM 정지 후에도 별도 과금 대상이 될 수 있다. DB 백업은 `pg_dump`로 별도 보관해야 하며, Docker volume만으로 외부 백업이 되는 것은 아니다. 이번 배포는 단일 서버 시연 구성이며 고가용성 구성은 아니다.

서버를 재생성하거나 체인을 초기화하면 이전 방·승인 상태와 계약 주소를 그대로 재사용하지 않는다. 초기 계약과 기본 행사 기간은 7일이다. 기간 연장은 새 계약 및 행사 전환을 계획해 진행한다.

## 공개 환경 검증 기록 — 2026-09-26

```sh
WEB_TEST_BASE_URL=https://zkiss.vercel.app ZKISS_LIVE_E2E=1 \
  ZKISS_REAL_SNS=1 ZKISS_REAL_AI=1 ZKISS_EXPECT_GENERATED_IMAGES=1 \
  npm run test:web -- backend.spec.ts
```

Chromium·WebKit 두 테스트 모두 통과(총 7.2분). 각 테스트는 두 사용자로 일반 입장, 실제 Gemini 소개·이미지 생성, 프로필 공개, 상호 호감, 대화, SNS 요청·동의, 브라우저 증명, 서버 대납, 원장 승인 확인, 양측 복호화·클립보드 전달, 새로고침 복원을 검증했다. 참가권 API 호출 및 SNS 원문·슬롯 비밀의 승인 거래 포함 여부도 검사했다. 클립보드는 테스트 API로 전달된 값을 검증했으며 휴대폰 OS 권한 동작을 검증한 것은 아니다.

서버 DB에는 실제 AI 작업 4건 성공, 승인 거래 4건 제출, 공개 요청 2건 완료를 확인했다. 테스트용 프로필 4개만 비활성화하고 해당 테스트 세션을 종료했다. 공유 DB와 기존 로컬 워커는 변경하지 않았다. 휴대폰 실기기·공개 테스트넷은 미검증이다.
