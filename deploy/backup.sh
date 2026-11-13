#!/usr/bin/env bash
# Nightly backup of the platform database, run by root's cron (install-backup-cron.sh installs it). SQL Server Express has no scheduler of its own.
#   1. BACKUP DATABASE inside the SQL Server container (checksummed; compressed when supported), then RESTORE VERIFYONLY.
#   2. Copy it out, encrypt it with the key in /root/.cabinet-backup-key (AES-256, gpg symmetric), delete every plain copy.
#   3. Keep the last BACKUP_KEEP (default 14) encrypted backups in BACKUP_DIR (default /var/backups/cabinet), and copy the new one to
#      BACKUP_TARGET with rsync when it is set (another machine: a backup on the same disk is not a backup).
# Restore: gpg --decrypt <file> > cabinet.bak, then follow deploy/README.md "Restore".
set -euo pipefail
LOG="${BACKUP_LOG:-/var/log/cabinet-backup.log}"
step="opening log"
trap 'printf "Backup failed: %s; log: %s\n" "$step" "$LOG" >&2' ERR
plan=false
case "${1:-}" in
  --print-plan) plan=true; LOG="$(mktemp "$(dirname "$0")/.backup-plan.XXXXXX")" ;;
  "") ;;
  *) step="unknown argument"; false ;;
esac
exec 3>&1 4>&2
trap 'printf "Backup failed: %s; log: %s\n" "$step" "$LOG" >&4' ERR
exec >>"$LOG" 2>&1
cd "$(dirname "$0")"
COMPOSE=(docker compose -f "$PWD/compose.yaml" --env-file "$PWD/.env")
KEY=/root/.cabinet-backup-key
DIR="${BACKUP_DIR:-/var/backups/cabinet}"
KEEP="${BACKUP_KEEP:-14}"
step="detecting SQL Server edition"
edition="$("${COMPOSE[@]}" exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -h-1 -W -Q "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('"'"'Edition'"'"') AS nvarchar(60))"')"
edition="$(printf '%s' "$edition" | tr -d '\r' | sed '/^[[:space:]]*$/d')"
compression=""
case "$edition" in
  *Express*) compress=no ;;
  *Developer*|*Standard*|*Enterprise*) compress=yes; compression="COMPRESSION, " ;;
  *) step="unsupported or empty SQL Server edition"; false ;;
esac
if $plan; then
  printf 'Edition: %s\nCompression: %s\n' "$edition" "$compress" >&3
  rm -f "$LOG"
  exit 0
fi
step="checking backup key"
[[ -s "$KEY" ]]
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]]
install -d -m 700 "$DIR"
plain=""
inner=/var/opt/mssql/data/cabinet-backup.bak
cleanup() {
  [[ -z "$plain" ]] || rm -f "$plain"
  "${COMPOSE[@]}" exec -T mssql rm -f "$inner" >/dev/null 2>&1 || true
}
trap cleanup EXIT
step="backing up and verifying database"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
inner=/var/opt/mssql/data/cabinet-backup.bak
"${COMPOSE[@]}" exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "BACKUP DATABASE cabinet TO DISK = N'"'"'/var/opt/mssql/data/cabinet-backup.bak'"'"' WITH ${1}CHECKSUM, INIT, FORMAT; RESTORE VERIFYONLY FROM DISK = N'"'"'/var/opt/mssql/data/cabinet-backup.bak'"'"' WITH CHECKSUM"' sh "$compression"
step="copying and encrypting verified backup"
plain="$(mktemp "$DIR/.plain.XXXXXX")"
"${COMPOSE[@]}" cp "mssql:$inner" "$plain"
out="$DIR/cabinet-$stamp.bak.gpg"
gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --passphrase-file "$KEY" --output "$out" "$plain"
chmod 600 "$out"
step="retaining and copying encrypted backup"
ls -1t "$DIR"/cabinet-*.bak.gpg | tail -n +$((KEEP + 1)) | xargs -r rm -f
if [[ -n "${BACKUP_TARGET:-}" ]]; then rsync -a "$out" "$BACKUP_TARGET/"; fi
echo "Backup written: $out" >&3
