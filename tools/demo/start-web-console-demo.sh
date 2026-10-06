#!/usr/bin/env bash
# Starts a complete, local, synthetic-data demo of the web Console:
#   Cabinet Server (SQLite)  -> http://127.0.0.1:5009   (loopback only)
#   Web Console (BFF + UI)   -> http://127.0.0.1:4180   (loopback only)
#   Simulated cabinet agents (unless --no-agents)
#
# Secrets (JWT signing key, agent key, first administrator password) are
# generated once per demo directory, stored with mode 600, and never committed.
#
# Usage: tools/demo/start-web-console-demo.sh [--reset] [--no-agents] [--no-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="${CABINET_DEMO_DIR:-$HOME/.cabinet-console-demo}"
SERVER_PORT="${CABINET_DEMO_SERVER_PORT:-5009}"
CONSOLE_PORT="${CABINET_DEMO_CONSOLE_PORT:-4180}"
AGENTS=1 BUILD=1 RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --no-agents) AGENTS=0 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v dotnet >/dev/null || { echo "The .NET 8 SDK is required (dotnet not found)." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ is required (node not found)." >&2; exit 1; }

if [[ $RESET == 1 ]]; then
  read -r -p "Delete the demo database, secrets and agent identities in $DEMO_DIR? [y/N] " answer
  [[ $answer == [yY] ]] && rm -rf "$DEMO_DIR"
fi
mkdir -p "$DEMO_DIR"
chmod 700 "$DEMO_DIR"

secret() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("base64url"))' "$1"; }
if [[ ! -f "$DEMO_DIR/secrets.env" ]]; then
  umask 077
  ADMIN_PASSWORD="Demo-$(secret 12)-9a!"
  cat > "$DEMO_DIR/secrets.env" <<EOF
JWT_KEY=$(secret 48)
AGENT_KEY=$(secret 32)
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
  FIRST_RUN=1
else
  FIRST_RUN=0
fi
# shellcheck disable=SC1091
source "$DEMO_DIR/secrets.env"

if [[ $BUILD == 1 ]]; then
  echo "Building the Cabinet Server…"
  dotnet build "$ROOT/src/CabinetPlatform.Server/CabinetPlatform.Server.csproj" -c Release -nologo -v quiet
fi

pids=()
cleanup() { echo; echo "Stopping demo…"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting the Cabinet Server on 127.0.0.1:$SERVER_PORT…"
(
  cd "$ROOT/src/CabinetPlatform.Server"
  export ASPNETCORE_ENVIRONMENT=Production
  export ASPNETCORE_URLS="http://127.0.0.1:$SERVER_PORT"
  export ConnectionStrings__SupportDatabase="Data Source=$DEMO_DIR/cabinet-support.db"
  export Jwt__SigningKey="$JWT_KEY"
  export AgentAuth__SharedSecret="$AGENT_KEY"
  export Seed__SupervisorUsername=admin
  export Seed__SupervisorDisplayName="Demo Administrator"
  export Seed__SupervisorInitialPassword="$ADMIN_PASSWORD"
  # Faster demo cadence; production keeps the stricter defaults.
  export AgentIngest__RegisterPermitPerWindow=200
  export AgentIngest__CheckInPermitPerWindow=200
  export AgentIngest__OfflineAfterMinutes=3
  export Serilog__MinimumLevel__Default=Warning
  exec dotnet "bin/Release/net8.0/CabinetPlatform.Server.dll"
) > "$DEMO_DIR/server.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "http://127.0.0.1:$SERVER_PORT/health" >/dev/null || { echo "Server failed to start; see $DEMO_DIR/server.log" >&2; tail -20 "$DEMO_DIR/server.log" >&2; exit 1; }

echo "Starting the web Console on 127.0.0.1:$CONSOLE_PORT…"
CONSOLE_UPSTREAM="http://127.0.0.1:$SERVER_PORT" CONSOLE_PORT="$CONSOLE_PORT" \
  node "$ROOT/src/CabinetPlatform.Web/console/console-server.mjs" > "$DEMO_DIR/console.log" 2>&1 &
pids+=($!)
sleep 1

if [[ $AGENTS == 1 ]]; then
  DEMO_SERVER="http://127.0.0.1:$SERVER_PORT" DEMO_AGENT_KEY="$AGENT_KEY" DEMO_STATE="$DEMO_DIR/agents.json" \
    node "$ROOT/tools/demo-agent/demo-agent.mjs" 2>&1 | sed -u "s/^/  /" &
  pids+=($!)
fi

cat <<EOF

  ┌──────────────────────────────────────────────────────────────────┐
  │  Cabinet Support web Console demo is running (synthetic data)    │
  └──────────────────────────────────────────────────────────────────┘
  Open:      http://127.0.0.1:$CONSOLE_PORT
  Username:  admin
EOF
if [[ $FIRST_RUN == 1 ]]; then
  echo "  Password:  $ADMIN_PASSWORD   (one-time; you must change it at first sign-in)"
else
  echo "  Password:  the one you set (first-run password is in $DEMO_DIR/secrets.env)"
fi
cat <<EOF
  Logs:      $DEMO_DIR/{server,console}.log
  Press Ctrl+C to stop everything.

EOF
wait
