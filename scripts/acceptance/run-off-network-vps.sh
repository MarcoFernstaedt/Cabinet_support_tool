#!/usr/bin/env bash
# Reviewer entry point on the VPS. The harness starts its platform container on the host network
# and restores cabinet-server-1 after removing it.
set -euo pipefail
: "${SHELL_SSH_USER:?Set SHELL_SSH_USER to the cabinet account}"
: "${SHELL_SSH_IDENTITY:?Set SHELL_SSH_IDENTITY to an authorized SSH identity file}"
export PATH="$HOME/.dotnet:$PATH"
repo=/home/marco/cabinet_support_tool
outdir=/home/marco/cabinet-audit/lab64
stamp=$(date +%Y%m%d-%H%M%S)
log="$outdir/off-network-$stamp.log"
mkdir -p "$outdir"
if [ -z "${TEST_DATABASE_ADMIN_URL:-}" ]; then
  # The acceptance database is a long-lived container but not a supervised one: if it is
  # stopped (host event, OOM) the harness cannot start and this script dies on its first
  # command. Bring it up and wait for health, so a stale container never blocks a run.
  docker start cab-test-mssql >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' cab-test-mssql 2>/dev/null)" = healthy ] && break
    sleep 2
  done
  PW=$(docker exec cab-test-mssql printenv MSSQL_SA_PASSWORD | tr -d '\r')
  export TEST_DATABASE_ADMIN_URL="sqlserver://sa:${PW}@127.0.0.1:11433/master?trustServerCertificate=true"
fi
export SHELL_CABINET_SSH=${SHELL_CABINET_SSH:-deviceb}
export SHELL_OFF_NETWORK=1
export SHELL_PLATFORM_HOST=${SHELL_PLATFORM_HOST:-168.231.67.178}
export SHELL_PLATFORM_PORT=8443
cd "$repo"
echo "=== off-network acceptance: $SHELL_PLATFORM_HOST:$SHELL_PLATFORM_PORT; evidence: $log ==="
[ "$(git branch --show-current)" = feat/remote-access-tunnel ] || { echo 'Requires feat/remote-access-tunnel'; exit 1; }
npm --prefix server run build
# Address signals to the harness itself, rather than a synchronous launcher that
# could exit while its child still owns the public port. Wait for cabinet recovery.
harness_pid=
interrupt() {
  trap '' INT TERM
  if [ -n "$harness_pid" ]; then
    kill -TERM "$harness_pid" 2>/dev/null || true
    wait "$harness_pid" || true
  fi
  cat "$log"
  exit 130
}
trap interrupt INT TERM
node scripts/acceptance/session-shell-cabinet.mjs > "$log" 2>&1 &
harness_pid=$!
status=0
wait "$harness_pid" || status=$?
trap - INT TERM
cat "$log"
echo "=== harness exit $status; evidence: $log ==="
exit "$status"
