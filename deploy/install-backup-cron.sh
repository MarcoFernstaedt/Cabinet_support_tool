#!/usr/bin/env bash
# Non-root invocation is a dry run. Root replaces one managed file atomically.
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$DEPLOY_DIR/backup.sh" ]]
bash -n "$DEPLOY_DIR/backup.sh"
# bash runs the script, so it need not have its executable bit set.
# Explicit PATH provides docker, gpg, rsync and the core utilities under cron.
printf -v command 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash %q' "$DEPLOY_DIR/backup.sh"
line="17 2 * * * root $command >> /var/log/cabinet-backup.log 2>&1"
[[ "$command" == PATH=* && "$command" == *"/bin/bash "* ]] || { echo "Cron command lacks PATH or bash" >&2; exit 1; }
# Cron treats percent specially even inside shell quotes.
[[ "$line" != *%* && "$line" != *$'\n'* ]] || { echo "Unsupported cron path" >&2; exit 1; }
if (( EUID == 0 )); then
  temporary="$(mktemp /etc/cron.d/.cabinet-backup.XXXXXX)"
  trap 'rm -f "$temporary"' EXIT
  printf '%s\n' "$line" > "$temporary"
  chmod 644 "$temporary"
  chown root:root "$temporary"
  mv -f "$temporary" /etc/cron.d/cabinet-backup
  echo "Installed /etc/cron.d/cabinet-backup"
else
  echo "Dry run: non-root; no crontab changed."
fi
printf '%s\n' "$line"
