#!/usr/bin/env bash
# Nightly backup of the platform database, run by root's cron (setup.sh installs it). SQL Server Express has no scheduler of its own.
#   1. BACKUP DATABASE inside the SQL Server container (compressed, with checksums), then RESTORE VERIFYONLY.
#   2. Copy it out, encrypt it with the key in /root/.cabinet-backup-key (AES-256, gpg symmetric), delete every plain copy.
#   3. Keep the last BACKUP_KEEP (default 14) encrypted backups in BACKUP_DIR (default /var/backups/cabinet), and copy the new one to
#      BACKUP_TARGET with rsync when it is set (another machine: a backup on the same disk is not a backup).
# Restore: gpg --decrypt <file> > cabinet.bak, then follow deploy/README.md "Restore".
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose -f "$PWD/compose.yaml" --env-file "$PWD/.env")
KEY=/root/.cabinet-backup-key
DIR="${BACKUP_DIR:-/var/backups/cabinet}"
KEEP="${BACKUP_KEEP:-14}"
[[ -s "$KEY" ]] || { echo "No backup key at $KEY (setup.sh creates it)." >&2; exit 1; }
install -d -m 700 "$DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
inner=/var/opt/mssql/data/cabinet-backup.bak
"${COMPOSE[@]}" exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "BACKUP DATABASE cabinet TO DISK = N'"'"'/var/opt/mssql/data/cabinet-backup.bak'"'"' WITH COMPRESSION, CHECKSUM, INIT, FORMAT; RESTORE VERIFYONLY FROM DISK = N'"'"'/var/opt/mssql/data/cabinet-backup.bak'"'"' WITH CHECKSUM"' >/dev/null
plain="$(mktemp "$DIR/.plain.XXXXXX")"
trap 'rm -f "$plain"; "${COMPOSE[@]}" exec -T mssql rm -f '"$inner"' >/dev/null 2>&1 || true' EXIT
"${COMPOSE[@]}" cp "mssql:$inner" "$plain"
out="$DIR/cabinet-$stamp.bak.gpg"
gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --passphrase-file "$KEY" --output "$out" "$plain"
chmod 600 "$out"
ls -1t "$DIR"/cabinet-*.bak.gpg | tail -n +$((KEEP + 1)) | xargs -r rm -f
if [[ -n "${BACKUP_TARGET:-}" ]]; then rsync -a "$out" "$BACKUP_TARGET/"; fi
echo "Backup written: $out"
