# ZKiss 시연 운영 절차

시연 행사 `evt_demo_v2_20260926`, v2 계약(Local Devnet `undeployed`) 기준이다. 비밀값은 `backend/.env`, `midnight/.env`에만 두고 출력하거나 커밋하지 않는다.

| 항목 | 값 |
| --- | --- |
| 계약 주소 | `12d0f825864f72f564b10d26733547dbad7ecfaf17bddeb5cec7a84d25932bd6` |
| scope | `d29bac6068dcec7b4b3d60391ec0d64e48707c086a6f1a80aec037dfd57562bb` |
| 행사 종료 | 2026-09-28T09:00:00Z |
| API | `0.0.0.0:3113` (웹 정적 파일도 함께 제공) |
| 공개 주소 | Cloudflare Quick Tunnel. 재시작할 때마다 주소가 바뀐다. |

## 0. 상태 확인 (중복 실행 전에)

```bash
ps -axo pid,etime,command | grep -E "src/server.ts|src/worker-main.ts" | grep -v grep
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E "zkiss-midnight-claude|zkiss-demo-tunnel"
curl -s -o /dev/null -w "%{http_code}\n" localhost:3113/health
```

## 1. Devnet (node · indexer · proof server)

체인 상태에 배포된 계약이 있으므로 `down -v`는 절대 쓰지 않는다(볼륨 삭제 = 계약 소실).

```bash
docker compose -p zkiss-midnight-claude -f midnight/devnet.yml up -d --wait
```

## 2. 웹 빌드 (변경했을 때만)

```bash
cd web && VITE_EVENT_ID=evt_demo_v2_20260926 npm run build
```

빌드 후에는 반드시 API를 재시작해야 새 정적 파일이 등록된다.

## 3. API

```bash
pkill -f "node --import tsx src/server.ts"
cd backend && nohup node --import tsx src/server.ts > /tmp/zkiss-api.log 2>&1 &
```

`backend/.env`의 `PUBLIC_ORIGIN`이 현재 터널 주소와 정확히 같아야 한다. 다르면 POST 요청이 `ORIGIN_INVALID`(403)로 거절된다.

## 4. Worker (티켓 발급 등 chain job 처리)

worker가 없으면 티켓 job이 `pending/attempts 0`으로 멈추고 참가 인증이 진행되지 않는다.

SIGTERM을 받으면 작업 루프는 멈추지만 노드/지갑 연결 때문에 프로세스가 남을 수 있다. 몇 초 뒤에도 남아 있으면 `kill -9`로 정리한다. 다른 worktree에서 띄운 worker가 같은 DB를 보고 있지 않은지도 확인한다.

```bash
pkill -f "tsx src/worker-main.ts"; sleep 5; pkill -9 -f "tsx src/worker-main.ts"
cd backend && nohup node --env-file=../midnight/.env --import tsx src/worker-main.ts > /tmp/zkiss-worker.log 2>&1 &
```

## 5. 공개 터널

`--protocol http2`를 쓰지 않는다. 2026-09-27 비교에서 http2 터널은 3분간 10MB 파일 요청 1,009회 중 2회만 성공했고(대부분 530), 같은 조건에서 QUIC(기본값) 터널은 42/42 성공했다.

```bash
docker run -d --name zkiss-demo-tunnel-v3 --restart unless-stopped \
  cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://192.168.65.254:3113
docker logs zkiss-demo-tunnel-v3 2>&1 | grep -o "https://[a-z0-9-]*\.trycloudflare\.com"
```

이미 컨테이너가 있으면 `docker restart zkiss-demo-tunnel-v3`를 쓴다(주소가 새로 바뀐다). 새 주소를 `backend/.env`의 `PUBLIC_ORIGIN`에 넣고 API를 재시작한다.

## 6. 시연 전 확인

한 번에 확인(읽기 전용, 비밀값 출력 없음). 마지막 줄이 `READY`여야 한다.

```bash
bash backend/deploy/demo-check.sh
```

수동으로 확인할 때:

```bash
U=https://<현재 터널 주소>
for p in /health / /midnight-assets/zkir.wasm /midnight-assets/keys/admit.prover; do
  curl -s -o /dev/null -m 60 -w "$p %{http_code} %{size_download}\n" $U$p
done
```

`admit.prover`는 9,976,797바이트, `zkir.wasm`은 1,968,826바이트여야 한다. 530이나 크기 불일치가 나오면 터널을 재시작한다.

## 알려진 한계

- Quick Tunnel은 주소 보장과 가동 시간 보장이 없다. 연결이 끊기면 진행 중인 증명 자산 다운로드가 실패할 수 있다.
- 브라우저 증명 시간은 PC Chromium 기준 admission 약 1분이다. 휴대폰 실측값이 아니다.
