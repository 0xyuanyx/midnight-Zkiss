# GCP 시연 서버

현재 SNS MVP의 API·워커·PostgreSQL·독립 Devnet을 Compute Engine 한 대에서 실행한다. 외부에는 Caddy의 80/443만 공개하고 SSH는 IAP로 접속한다. 공개 테스트넷 배포가 아니다.

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
