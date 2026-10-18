#!/usr/bin/env bash
# One load run, end to end, on the "small server" profile (docs/platform/performance.md "Running it"):
# a fresh database, a development PKI, the server pinned to its own cores with a heap cap, the load generator on the
# other cores, the run, and teardown (server stopped, database and its login dropped, private keys deleted).
#
#   MSSQL_SA_PASSWORD=… server/test/load/run.sh <scenario> <agents> <minutes> [more agents.js run options]
#
# Settings (environment):
#   MSSQL_SA_PASSWORD   required; the SQL Server sa password (never stored in the repository)
#   MSSQL_HOST/PORT     localhost / 1433
#   SERVER_CORES        cores for the server process (taskset list), default 0,1
#   GEN_CORES           cores for the load generator, default 2,3
#   SERVER_HEAP_MB      the server's JavaScript heap cap, default 1024
#   PROTOCOL            1.1 (default) or 1.0
#   TIME_COMPRESSION    default 18 (a 4G cabinet's 6-hourly failover comes every 20 minutes)
#   RAMP_SECONDS        default 120
#   DB_MEMORY_MB        optional: SQL Server "max server memory" for the run (MSSQL_MEMORY_LIMIT_MB without recreating the
#                       container); the previous value is put back afterwards
#   DB_CPUS             optional: docker update --cpus for the SQL Server container (MSSQL_CONTAINER, default mssql) for
#                       the run; put back to unlimited afterwards. Express itself uses at most 4 cores.
#   OUT_DIR             where the report and server log are kept, default ./load-results
#   SKIP_BUILD=1        do not run npm run build
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: MSSQL_SA_PASSWORD=… $0 <scenario> <agents> <minutes> [agents.js run options]" >&2
  exit 2
fi
SCENARIO=$1; AGENTS=$2; MINUTES=$3; shift 3
case "$SCENARIO" in steady|restart|no-ramp|regional-outage|nat-drop|failover-during-command|event-storm) ;; *) echo "unknown scenario $SCENARIO" >&2; exit 2;; esac
[[ "$AGENTS" =~ ^[0-9]+$ ]] || { echo "agents must be a number" >&2; exit 2; }
[[ "$MINUTES" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "minutes must be a number" >&2; exit 2; }
: "${MSSQL_SA_PASSWORD:?set MSSQL_SA_PASSWORD (the SQL Server sa password)}"

HERE=$(cd "$(dirname "$0")" && pwd)
SERVER_DIR=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$SERVER_DIR/.." && pwd)
MSSQL_HOST=${MSSQL_HOST:-localhost}
MSSQL_PORT=${MSSQL_PORT:-1433}
SERVER_CORES=${SERVER_CORES:-0,1}
GEN_CORES=${GEN_CORES:-2,3}
SERVER_HEAP_MB=${SERVER_HEAP_MB:-1024}
PROTOCOL=${PROTOCOL:-1.1}
TIME_COMPRESSION=${TIME_COMPRESSION:-18}
RAMP_SECONDS=${RAMP_SECONDS:-120}
MSSQL_CONTAINER=${MSSQL_CONTAINER:-mssql}
OUT_DIR=${OUT_DIR:-$PWD/load-results}
AGENT_PORT=${AGENT_PORT:-$((18443 + RANDOM % 1000))}
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN_ID="$(date +%s)_$$"
DB="cabinet_load_${RUN_ID}"
LOGIN="cabinet_load_login_${RUN_ID}"
WORK=$(mktemp -d "${LOAD_WORK_DIR:-${TMPDIR:-/tmp}}/cabinet-load.XXXXXX")
chmod 700 "$WORK"
APP_PW="L$(openssl rand -hex 20)"
SA_ENC=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$MSSQL_SA_PASSWORD")
export DATABASE_OWNER_URL="sqlserver://sa:${SA_ENC}@${MSSQL_HOST}:${MSSQL_PORT}/${DB}?trustServerCertificate=true"
MASTER_URL="sqlserver://sa:${SA_ENC}@${MSSQL_HOST}:${MSSQL_PORT}/master?trustServerCertificate=true"
export DATABASE_URL="sqlserver://${LOGIN}:${APP_PW}@${MSSQL_HOST}:${MSSQL_PORT}/${DB}?trustServerCertificate=true"
export DEV_PKI_DIR="$WORK/pki"
export AGENT_API_PORT=$AGENT_PORT AGENT_API_HOSTNAMES=localhost AGENT_API_HOST=127.0.0.1
export PACKAGE_DIR="$WORK/packages" RELEASE_DIR="$WORK/releases"
PIDFILE="$WORK/server.pid"
SERVER_LOG="$OUT_DIR/$STAMP-$SCENARIO-$AGENTS-server.log"
REPORT="$OUT_DIR/$STAMP-$SCENARIO-$AGENTS-$PROTOCOL.json"
sql() { DATABASE_OWNER_URL="$1" node "$REPO/deploy/sql-query.mjs" "$2"; }

OLD_DB_MEMORY=""
cleanup() {
  set +e
  if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; sleep 2; kill -9 "$(cat "$PIDFILE")" 2>/dev/null; fi
  sql "$MASTER_URL" "IF DB_ID('$DB') IS NOT NULL BEGIN ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$DB]; END" >/dev/null
  sql "$MASTER_URL" "IF SUSER_ID('$LOGIN') IS NOT NULL DROP LOGIN [$LOGIN]" >/dev/null
  if [ -n "$OLD_DB_MEMORY" ]; then
    sql "$MASTER_URL" "EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'max server memory (MB)', $OLD_DB_MEMORY; RECONFIGURE;" >/dev/null
  fi
  if [ -n "${DB_CPUS:-}" ]; then docker update --cpus 0 "$MSSQL_CONTAINER" >/dev/null; fi
  rm -rf "$WORK"
  echo "Torn down: server stopped, database $DB and login $LOGIN dropped, keys deleted."
}
trap cleanup EXIT

ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
cd "$SERVER_DIR"
[ "${SKIP_BUILD:-}" = "1" ] || npm run build >/dev/null

if [ -n "${DB_MEMORY_MB:-}" ]; then
  OLD_DB_MEMORY=$(sql "$MASTER_URL" "SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'max server memory (MB)'")
  sql "$MASTER_URL" "EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'max server memory (MB)', $DB_MEMORY_MB; RECONFIGURE;" >/dev/null
  echo "SQL Server max server memory: $DB_MEMORY_MB MB for this run (was $OLD_DB_MEMORY)."
fi
if [ -n "${DB_CPUS:-}" ]; then docker update --cpus "$DB_CPUS" "$MSSQL_CONTAINER" >/dev/null; echo "SQL Server container limited to $DB_CPUS CPUs."; fi

echo "== database $DB"
node "$REPO/deploy/database-setup.mjs" create
# A smaller log than the production default: a load run needs little and disks may be small.
sql "$MASTER_URL" "DECLARE @log sysname = (SELECT name FROM sys.master_files WHERE database_id = DB_ID('$DB') AND type = 1); DECLARE @sql nvarchar(400) = N'USE [$DB]; DBCC SHRINKFILE (' + QUOTENAME(@log) + N', 256)'; EXEC (@sql);" >/dev/null || true
node dist/src/cli.js migrate
# A login for this run only (deploy/database-setup.mjs login would reset the shared cabinet_app_login).
sql "$MASTER_URL" "CREATE LOGIN [$LOGIN] WITH PASSWORD = N'$APP_PW', CHECK_POLICY = ON, DEFAULT_DATABASE = [$DB]" >/dev/null
sql "$DATABASE_OWNER_URL" "CREATE USER [$LOGIN] FOR LOGIN [$LOGIN]; ALTER ROLE cabinet_app ADD MEMBER [$LOGIN];" >/dev/null

echo "== $AGENTS cabinets and certificates"
taskset -c "$GEN_CORES" node dist/test/load/agents.js setup --count "$AGENTS" --state "$WORK/state.json"

start_server() {
  taskset -c "$SERVER_CORES" node --max-old-space-size="$SERVER_HEAP_MB" dist/src/main.js >>"$SERVER_LOG" 2>&1 &
  echo $! >"$PIDFILE"
}
cat >"$WORK/restart-server.sh" <<EOF
#!/usr/bin/env bash
# Stops the server (SIGTERM: it closes its listeners and answers held polls) and starts it again on the same cores.
set -u
pid=\$(cat "$PIDFILE")
kill "\$pid" 2>/dev/null
for i in \$(seq 1 100); do kill -0 "\$pid" 2>/dev/null || break; sleep 0.1; done
kill -9 "\$pid" 2>/dev/null
cd "$SERVER_DIR"
taskset -c "$SERVER_CORES" node --max-old-space-size="$SERVER_HEAP_MB" dist/src/main.js >>"$SERVER_LOG" 2>&1 &
echo \$! >"$PIDFILE"
echo "server restarted as \$!"
EOF
chmod 700 "$WORK/restart-server.sh"

echo "== server on cores $SERVER_CORES, heap $SERVER_HEAP_MB MB, port $AGENT_PORT"
start_server
for i in $(seq 1 60); do
  if node -e 'require("https").get({host:"127.0.0.1",port:process.argv[1],path:"/health",rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' "$AGENT_PORT"; then break; fi
  sleep 1
done

echo "== run: $SCENARIO, $AGENTS agents, $MINUTES min, protocol $PROTOCOL, generator on cores $GEN_CORES"
set +e
taskset -c "$GEN_CORES" node dist/test/load/agents.js run --server "https://localhost:$AGENT_PORT" --state "$WORK/state.json" \
  --scenario "$SCENARIO" --minutes "$MINUTES" --protocol "$PROTOCOL" --time-compression "$TIME_COMPRESSION" --ramp-seconds "$RAMP_SECONDS" \
  --server-pid-file "$PIDFILE" --restart-exec "$WORK/restart-server.sh" --report "$REPORT" "$@"
status=$?
set -e
echo "Report: $REPORT  Server log: $SERVER_LOG"
exit $status
