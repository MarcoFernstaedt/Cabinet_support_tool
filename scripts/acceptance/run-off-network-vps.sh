#!/usr/bin/env bash
# Off-network acceptance run (host orchestration only — the acceptance itself is the
# committed harness scripts/acceptance/session-shell-cabinet.mjs).
#
# Why Tailscale Funnel is the public ingress: on this host the public port 8443 is
# reachable only through a port publisher — Docker's DNAT while the deployed container
# holds it, or tailscaled's own Funnel listener. A plain host process listening on 8443 is
# NOT reachable from the cabinet (measured 2026-11-17: host-stack listener on 8443, cabinet
# probe = False), and container -> host traffic is firewalled (measured: a socat container
# publishing 8443 accepted the cabinet's connection and then timed out connecting to
# 172.17.0.1:18443), so no forwarder container can reach a host-side listener either.
# Funnel forwards RAW TCP (mTLS stays end to end, unlike --tls-terminated-tcp) to the
# harness's listener, and it holds host 8443 only while the entry is registered — so it is
# added after the deployed container stops and removed before it restarts.
#
# The agent dials the Funnel name; off-tailnet it resolves publicly, on-tailnet MagicDNS
# sends it back through tailscaled to the same listener.
#
# Run it on the VPS host that owns the public ingress (the same file is kept at
# ~/.hermes/scripts/run-off-network-acceptance.sh for the operator's convenience):
#
#   bash scripts/acceptance/run-off-network-vps.sh
set -euo pipefail

# dotnet lives outside the default PATH (same export the gate runner uses); the harness
# publishes the Windows test agent before it can talk to the cabinet.
export PATH="$HOME/.dotnet:$PATH"

repo=/home/marco/cabinet_support_tool
outdir=/home/marco/cabinet-audit/lab64
stamp=$(date +%Y%m%d-%H%M)
log="$outdir/off-network-$stamp.log"
listen_port=18443
funnel_target="tcp://localhost:$listen_port"
mkdir -p "$outdir"

# The harness needs an admin connection to the throwaway test SQL Server.
if [ -z "${TEST_DATABASE_ADMIN_URL:-}" ]; then
  PW=$(docker exec cab-test-mssql printenv MSSQL_SA_PASSWORD | tr -d '\r')
  export TEST_DATABASE_ADMIN_URL="sqlserver://sa:${PW}@127.0.0.1:11433/master?trustServerCertificate=true"
fi
export SHELL_CABINET_SSH=deviceb
export SHELL_OFF_NETWORK=1
export SHELL_PLATFORM_HOST=srv1522777.tail72f980.ts.net
export SHELL_PLATFORM_PORT=8443
export SHELL_PLATFORM_LISTEN_PORT=$listen_port
# The platform's own config default binds 0.0.0.0 so the Funnel's localhost target reaches
# it; state it explicitly so no stray environment value can pin it to a bridge address.
export AGENT_API_HOST=0.0.0.0

restore() {
  echo "=== tearing down the public ingress ==="
  timeout 25 tailscale funnel --tcp=8443 "$funnel_target" off || true
  sleep 2
  if ss -ltn 2>/dev/null | grep -q ':8443 '; then
    echo "  WARNING: something still holds host 8443 — the deployed server will not bind"
  fi

  echo "=== restoring the deployed server on 8443 ==="
  docker start cabinet-server-1 >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    status=$(docker inspect -f '{{.State.Status}}' cabinet-server-1 2>/dev/null || echo unknown)
    [ "$status" = "running" ] && break
    sleep 2
  done
  docker ps --filter name=cabinet-server-1 --format '{{.Names}} {{.Status}}' || true
  curl -sk -o /dev/null -w '  deployed API on 8443 -> HTTP %{http_code}\n' --max-time 15 https://168.231.67.178:8443/ || true
}
trap restore EXIT

echo "=== freeing 8443: the deployed API must stop (Funnel is the port publisher) ==="
docker stop cabinet-server-1 >/dev/null

echo "=== public ingress: funnel raw TCP 8443 -> harness listener on $listen_port ==="
timeout 25 tailscale funnel --bg --tcp=8443 "$funnel_target"
sleep 3
timeout 15 tailscale funnel status > "$outdir/off-network-$stamp-funnel.txt" 2>&1 || true
cat "$outdir/off-network-$stamp-funnel.txt"
grep -q 8443 "$outdir/off-network-$stamp-funnel.txt" || { echo "FAIL: funnel on 8443 is not published"; exit 1; }

cd "$repo"
echo "=== harness: off-network acceptance (agent dials $SHELL_PLATFORM_HOST:$SHELL_PLATFORM_PORT) ==="
# Run it in the background so the run can record where the platform actually bound and
# prove the cabinet can reach that listener through the public ingress while it is up.
node scripts/acceptance/session-shell.mjs > "$log" 2>&1 &
harness_pid=$!
# The harness compiles the server first (`tsc`), so the listener appears well after start.
for _ in $(seq 1 120); do
  ss -ltn 2>/dev/null | grep -q ":$listen_port " && break
  sleep 2
done
echo "--- platform listener (as bound on this host) ---"
ss -ltnp 2>/dev/null | grep ":$listen_port " || echo "  NOTHING is listening on $listen_port"
echo "--- cabinet TLS preflight through the ingress ---"
preflight=$(iconv -f UTF-8 -t UTF-16LE "$repo/scripts/acceptance/platform-tls-preflight.ps1" | base64 -w0)
timeout 60 ssh -F "$HOME/.ssh/config" -o BatchMode=yes -o ConnectTimeout=10 "$SHELL_CABINET_SSH" \
  "powershell.exe -NoProfile -EncodedCommand $preflight" 2>&1 | tr -d '\r' | grep -E -e 'preflight|TLS handshake|first response' || true
wait "$harness_pid"
status=$?
echo "=== harness exit $status; evidence: $log ==="
exit "$status"
