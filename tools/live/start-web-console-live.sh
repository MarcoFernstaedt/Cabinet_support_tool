#!/usr/bin/env bash
# Runs the real Cabinet Server and web Console for live use with real Agents.
#
#   Cabinet Server  -> http://127.0.0.1:${SERVER_PORT:-5019}   (loopback only)
#   Web Console     -> http://127.0.0.1:${CONSOLE_PORT:-4190}  (loopback only)
#
# Windows Agents require HTTPS. With --tailscale this script publishes both
# loopback listeners on your tailnet only (never Funnel / the public internet):
#
#   https://<this-host>.<tailnet>.ts.net:8446  -> Server (Agents connect here)
#   https://<this-host>.<tailnet>.ts.net:8447  -> Console (staff browsers)
#
# Data and generated secrets live in ~/.cabinet-console-live (mode 700), separate
# from the demo stack and from any other Server deployment on this host.
#
# Usage: tools/live/start-web-console-live.sh [--tailscale] [--no-build]
#        [--agent-url https://...] [--console-origin https://...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="${CABINET_LIVE_DIR:-$HOME/.cabinet-console-live}"
SERVER_PORT="${SERVER_PORT:-5019}"
CONSOLE_PORT="${CONSOLE_PORT:-4190}"
TS_SERVER_PORT="${TS_SERVER_PORT:-8446}"
TS_CONSOLE_PORT="${TS_CONSOLE_PORT:-8447}"
TAILSCALE=0 BUILD=1 AGENT_URL="" CONSOLE_ORIGIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tailscale) TAILSCALE=1 ;;
    --no-build) BUILD=0 ;;
    --agent-url) AGENT_URL="${2:?}"; shift ;;
    --console-origin) CONSOLE_ORIGIN="${2:?}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v dotnet >/dev/null || { echo "The .NET 8 SDK is required." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ is required." >&2; exit 1; }
mkdir -p "$DATA"; chmod 700 "$DATA"

secret() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("base64url"))' "$1"; }
FIRST_RUN=0
if [[ ! -f "$DATA/secrets.env" ]]; then
  umask 077
  cat > "$DATA/secrets.env" <<EOF
JWT_KEY=$(secret 48)
AGENT_KEY=$(secret 32)
ADMIN_PASSWORD=Live-$(secret 12)-7k!
EOF
  FIRST_RUN=1
fi
# shellcheck disable=SC1091
source "$DATA/secrets.env"

if [[ $TAILSCALE == 1 ]]; then
  command -v tailscale >/dev/null || { echo "--tailscale needs the tailscale CLI on this host." >&2; exit 1; }
  TS_NAME="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
  [[ -n "$TS_NAME" ]] || { echo "Could not read this host's tailnet name (is Tailscale logged in?)." >&2; exit 1; }
  AGENT_URL="https://$TS_NAME:$TS_SERVER_PORT"
  CONSOLE_ORIGIN="https://$TS_NAME:$TS_CONSOLE_PORT"
fi

if [[ $BUILD == 1 ]]; then
  echo "Building the Cabinet Server…"
  dotnet build "$ROOT/src/CabinetPlatform.Server/CabinetPlatform.Server.csproj" -c Release -nologo -v quiet
fi

pids=()
cleanup() { echo; echo "Stopping Server and Console (Tailscale Serve rules are left in place; see 'tailscale serve status')."; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting the Cabinet Server on 127.0.0.1:$SERVER_PORT…"
(
  cd "$ROOT/src/CabinetPlatform.Server"
  export ASPNETCORE_ENVIRONMENT=Production
  export ASPNETCORE_URLS="http://127.0.0.1:$SERVER_PORT"
  export ConnectionStrings__SupportDatabase="Data Source=$DATA/cabinet-support.db"
  export Jwt__SigningKey="$JWT_KEY"
  export AgentAuth__SharedSecret="$AGENT_KEY"
  export Seed__SupervisorUsername=admin
  export Seed__SupervisorDisplayName="Administrator"
  export Seed__SupervisorInitialPassword="$ADMIN_PASSWORD"
  # A pending Agent re-registers every check-in (60 s from the installer);
  # allow that without tripping the default 5-per-5-minutes limit.
  export AgentIngest__RegisterPermitPerWindow=20
  exec dotnet "bin/Release/net8.0/CabinetPlatform.Server.dll"
) >> "$DATA/server.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "http://127.0.0.1:$SERVER_PORT/health" >/dev/null || { echo "Server failed to start; see $DATA/server.log" >&2; tail -20 "$DATA/server.log" >&2; exit 1; }

echo "Starting the web Console on 127.0.0.1:$CONSOLE_PORT…"
(
  export CONSOLE_UPSTREAM="http://127.0.0.1:$SERVER_PORT"
  export CONSOLE_PORT
  [[ -n "$CONSOLE_ORIGIN" ]] && export CONSOLE_PUBLIC_ORIGIN="$CONSOLE_ORIGIN"
  [[ -n "$AGENT_URL" ]] && export CONSOLE_AGENT_SERVER_URL="$AGENT_URL"
  exec node "$ROOT/src/CabinetPlatform.Web/console/console-server.mjs"
) >> "$DATA/console.log" 2>&1 &
pids+=($!)
sleep 1

if [[ $TAILSCALE == 1 ]]; then
  echo "Publishing on your tailnet with Tailscale Serve (tailnet-only, no Funnel)…"
  tailscale serve --bg --https="$TS_SERVER_PORT" "http://127.0.0.1:$SERVER_PORT" >/dev/null
  tailscale serve --bg --https="$TS_CONSOLE_PORT" "http://127.0.0.1:$CONSOLE_PORT" >/dev/null
  # Refuse to continue if either port is exposed to the public internet.
  if tailscale serve status --json | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        const f=JSON.parse(s||"{}").AllowFunnel||{};
        const bad=Object.entries(f).filter(([k,v])=>v&&/:(\d+)$/.test(k)&&[process.argv[1],process.argv[2]].includes(k.split(":").pop()));
        process.exit(bad.length?0:1); });' "$TS_SERVER_PORT" "$TS_CONSOLE_PORT"; then
    echo "Funnel (public internet) is enabled for one of these ports. Turn it off: tailscale funnel --https=<port> off" >&2
    exit 1
  fi
fi

cat <<EOF

  ┌───────────────────────────────────────────────────────────────┐
  │  Cabinet Support — LIVE (real agents, real data)               │
  └───────────────────────────────────────────────────────────────┘
  Console:          ${CONSOLE_ORIGIN:-http://127.0.0.1:$CONSOLE_PORT}
  Agent server URL: ${AGENT_URL:-"(none — agents need HTTPS; rerun with --tailscale or --agent-url)"}
  Admin username:   admin
EOF
if [[ $FIRST_RUN == 1 ]]; then
  echo "  Admin password:   $ADMIN_PASSWORD   (one-time; you set your own at first sign-in)"
else
  echo "  Admin password:   the one you set (first-run value in $DATA/secrets.env)"
fi
cat <<EOF
  Agent key:        AGENT_KEY in $DATA/secrets.env (type it into the Windows installer)
  Logs:             $DATA/{server,console}.log
  Press Ctrl+C to stop.

EOF
wait
