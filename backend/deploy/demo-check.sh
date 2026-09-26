#!/usr/bin/env bash
# Pre-demo check. Read-only: prints no secret values and changes nothing.
# Usage: bash backend/deploy/demo-check.sh [tunnel-container]
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TUNNEL="${1:-zkiss-demo-tunnel-v3}"
EVENT="evt_demo_v2_20260926"
fail=0
ok() { printf '  OK   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }

echo "[devnet]"
for c in zkiss-midnight-claude-node-1 zkiss-midnight-claude-indexer-1 zkiss-midnight-claude-proof-server-1; do
  s=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null) || s=missing
  [ "$s" = running ] && ok "$c running" || bad "$c $s"
done

echo "[processes]"
pgrep -f "^node --import tsx src/server.ts" >/dev/null && ok "API running" || bad "API not running"
curl -sf -m 5 localhost:3113/health >/dev/null && ok "API local health" || bad "API local health"
workers=$(pgrep -f "env-file=../midnight/.env --import tsx src/worker-main.ts" | wc -l | tr -d ' ')
[ "$workers" = 1 ] && ok "worker running (1)" || bad "worker count $workers (expected 1)"

echo "[tunnel]"
s=$(docker inspect -f '{{.State.Status}}' "$TUNNEL" 2>/dev/null) || s=missing
[ "$s" = running ] && ok "$TUNNEL running" || bad "$TUNNEL $s"
URL=$(docker logs "$TUNNEL" 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
[ -n "$URL" ] && ok "tunnel $URL" || bad "tunnel URL not found"
docker inspect -f '{{join .Config.Cmd " "}}' "$TUNNEL" 2>/dev/null | grep -q "protocol http2" && bad "tunnel uses http2 (use default QUIC)"
origin=$(grep -E '^PUBLIC_ORIGIN=' "$ROOT/backend/.env" | cut -d= -f2- | tr -d '"')
[ -n "$URL" ] && [ "$origin" = "$URL" ] && ok "PUBLIC_ORIGIN matches tunnel" || bad "PUBLIC_ORIGIN does not match tunnel (then restart API)"

echo "[public]"
if [ -n "$URL" ]; then
  check() {
    r=$(curl -s -o /dev/null -m 60 -w '%{http_code} %{size_download}' "$URL$1")
    [ "$r" = "200 $2" ] || { [ "$2" = any ] && [ "${r%% *}" = 200 ]; } && ok "$1 ($r)" || bad "$1 ($r, expected 200 $2)"
  }
  check /health any
  check / any
  check "/api/v1/events/$EVENT" any
  check /midnight-assets/zkir.wasm 1968826
  check /midnight-assets/keys/admit.prover 9976797
  check /midnight-assets/keys/approveReveal.prover "$(stat -f %z "$ROOT/web/dist/midnight-assets/keys/approveReveal.prover")"
  check /midnight-assets/bls_midnight_2p16 12583300
fi

echo
[ $fail = 0 ] && echo "READY" || echo "NOT READY — see FAIL lines and docs/DEMO_RUNBOOK.md"
exit $fail
