#!/usr/bin/env bash
# Sets up the demo platform on a fresh Ubuntu 24.04 VPS. Safe to run again: an existing deploy/.env is kept,
# the migrations only apply what is new, and the first Admin is created only when there is no Admin yet.
#
# Usage (from anywhere):   sudo bash deploy/setup.sh
# Non-interactive:         sudo CONSOLE_DOMAIN=cabinets.example.com PUBLIC_IP=203.0.113.10 ADMIN_USERNAME=admin ADMIN_NAME="Demo Admin" bash deploy/setup.sh
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE=(docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yaml")

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

ask() { # ask <variable> <question> <default>
  local var="$1" question="$2" default="${3:-}" answer
  if [[ -n "${!var:-}" ]]; then return; fi
  if [[ ! -t 0 ]]; then printf -v "$var" '%s' "$default"; return; fi
  read -r -p "$question${default:+ [$default]}: " answer
  printf -v "$var" '%s' "${answer:-$default}"
}

is_ipv4() { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && (( BASH_REMATCH[1] <= 255 && BASH_REMATCH[2] <= 255 && BASH_REMATCH[3] <= 255 && BASH_REMATCH[4] <= 255 )); }
is_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }

# 1. Prerequisites -----------------------------------------------------------------------------------------------
say "Checking prerequisites"
[[ $EUID -eq 0 ]] || docker info >/dev/null 2>&1 || fail "Run as root (sudo bash deploy/setup.sh) or as a user in the docker group."
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it first:
    curl -fsSL https://get.docker.com | sh
then run this script again."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. Install it: apt-get install -y docker-compose-plugin"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start it: systemctl enable --now docker"
command -v openssl >/dev/null 2>&1 || fail "openssl is missing. Install it: apt-get install -y openssl"
echo "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2>/dev/null || echo compose)"

# 2. deploy/.env -------------------------------------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  say "Keeping the existing $ENV_FILE (delete it to start over with new names and secrets)"
else
  say "Creating $ENV_FILE"
  detected_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
  ask PUBLIC_IP "The VPS's public IPv4 address (agents and browsers connect to it)" "$detected_ip"
  is_ipv4 "$PUBLIC_IP" || fail "'$PUBLIC_IP' is not an IPv4 address."
  ask CONSOLE_DOMAIN "A domain whose DNS A record points at $PUBLIC_IP (recommended; leave empty to use the IP only)" ""
  if [[ -n "$CONSOLE_DOMAIN" ]]; then
    CONSOLE_DOMAIN="${CONSOLE_DOMAIN,,}"
    is_domain "$CONSOLE_DOMAIN" || fail "'$CONSOLE_DOMAIN' is not a domain name."
    console_site="$CONSOLE_DOMAIN"; console_tls="acme"; agent_names="$CONSOLE_DOMAIN,$PUBLIC_IP,localhost"
  else
    console_site="$PUBLIC_IP"; console_tls="internal"; agent_names="$PUBLIC_IP,localhost"
  fi
  echo
  echo "Microsoft SQL Server runs in a container. Express edition is free (databases up to 10 GB); Standard, Enterprise and Developer need a licence you hold."
  ask mssql_pid "SQL Server edition (Express, Developer, Standard, Enterprise)" "Express"
  case "$mssql_pid" in Express|Developer|Standard|Enterprise) ;; *) fail "Edition must be Express, Developer, Standard or Enterprise." ;; esac
  ask accept_eula "Do you accept the SQL Server licence terms (https://go.microsoft.com/fwlink/?linkid=857698)? Type Y to accept" ""
  [[ "$accept_eula" == "Y" ]] || fail "SQL Server cannot start without accepting its licence terms. Type Y to accept."
  # Letters and digits only (no escaping anywhere), long, and with upper case, lower case and a digit as SQL Server's password rules need.
  alnum() { printf '%sAa1' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"; }
  umask 077
  cat > "$ENV_FILE" <<EOF
# Made by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Holds secrets: never commit or share this file.
CONSOLE_SITE=$console_site
CONSOLE_TLS=$console_tls
AGENT_API_HOSTNAMES=$agent_names
ACCEPT_EULA=$accept_eula
MSSQL_PID=$mssql_pid
SQL_SA_PASSWORD=$(alnum)
APP_DB_PASSWORD=$(alnum)
CONSOLE_SECRET_KEY=$(openssl rand -base64 32)
FRONTEND_SUBNET=172.30.57.0/24
CADDY_IP=172.30.57.10
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (mode 600)."
fi
# Read back the names for the messages below (never the secrets).
console_site="$(sed -n 's/^CONSOLE_SITE=//p' "$ENV_FILE")"
console_tls="$(sed -n 's/^CONSOLE_TLS=//p' "$ENV_FILE")"
agent_names="$(sed -n 's/^AGENT_API_HOSTNAMES=//p' "$ENV_FILE")"
[[ -n "$console_site" && -n "$agent_names" ]] || fail "$ENV_FILE is missing CONSOLE_SITE or AGENT_API_HOSTNAMES."

# 3. Firewall ----------------------------------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say "ufw is active: allowing 80/tcp and 443/tcp (console, certificates), 443/udp (HTTP/3) and 8443/tcp (agent API)"
  for rule in 80/tcp 443/tcp 443/udp 8443/tcp; do
    echo "    ufw allow $rule"
    ufw allow "$rule" >/dev/null
  done
  echo "SQL Server (1433) is not opened and not published."
else
  say "ufw is not active: no firewall rules changed. Make sure your provider's firewall allows 80, 443 and 8443 (TCP)."
fi

# 4. Build and start ---------------------------------------------------------------------------------------------
say "Building the image (the first build takes several minutes: console, server and the Windows agent)"
"${COMPOSE[@]}" build

say "Starting SQL Server"
"${COMPOSE[@]}" up -d mssql

say "Creating the database, running the migrations and creating the application's database login"
"${COMPOSE[@]}" run --rm migrate

say "Starting the server and Caddy"
"${COMPOSE[@]}" up -d

echo -n "Waiting for the server to be healthy"
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q server)" 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] && break
  echo -n "."; sleep 2
done
echo
[[ "${status:-}" == "healthy" ]] || fail "The server did not become healthy. See: docker compose -f $DEPLOY_DIR/compose.yaml logs server"

# 5. First Admin -------------------------------------------------------------------------------------------------
admins="$("${COMPOSE[@]}" exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d cabinet -h -1 -W -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM users WHERE role = N'"'"'admin'"'"'"')"
if [[ "${admins//[[:space:]]/}" == "0" ]]; then
  say "Creating the first Admin"
  ask ADMIN_USERNAME "Admin username (a-z, 0-9, . _ -)" "admin"
  ask ADMIN_NAME "Admin full name" "Demo Admin"
  [[ "$ADMIN_USERNAME" =~ ^[a-z0-9._-]{2,64}$ ]] || fail "The username must be 2 to 64 of a-z, 0-9, '.', '_' and '-'."
  "${COMPOSE[@]}" exec -T server node /opt/cabinet/server/dist/src/cli.js user add --username "$ADMIN_USERNAME" --name "$ADMIN_NAME" --role admin
  echo "Write the temporary password down now. It is shown only once."
else
  say "An Admin already exists; none created. (Reset a password: docker compose exec server node /opt/cabinet/server/dist/src/cli.js user reset-password --username <user> --as <admin>)"
fi

# 6. Done --------------------------------------------------------------------------------------------------------
say "Ready"
echo "Console:    https://$console_site"
if [[ "$console_tls" == "internal" ]]; then
  echo "            (an IP-only certificate from Caddy's own CA: the browser warns once; continue past the warning)"
fi
echo "Agent API:  https://<one of: $agent_names>:8443  (for the agent's -PlatformServerHost)"
echo
echo "Next: sign in, change the temporary password, set up an authenticator app, then download the agent (see deploy/README.md)."
