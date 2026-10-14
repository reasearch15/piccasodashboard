#!/usr/bin/env bash
# Consistent online backup of Picasso's SQLite databases (safe while the
# service is running: uses SQLite's own VACUUM INTO, never a raw file copy).
#
#   sudo -u picasso /opt/picasso-dashboard/app/deploy/backup.sh
#
# Every copy is integrity-checked before the script reports success. The last
# line of output is always:  BACKUP_DIR=<path>
#
# Old backups are pruned ONLY when PICASSO_BACKUP_KEEP_DAYS is set (e.g. in the
# nightly cron entry). Deployments never prune.
#   30 2 * * * PICASSO_BACKUP_KEEP_DAYS=30 /opt/picasso-dashboard/app/deploy/backup.sh
set -euo pipefail
umask 077

DATA="${PICASSO_DATA_DIR:-/opt/picasso-dashboard/data}"
ROOT="${PICASSO_BACKUP_ROOT:-/opt/picasso-dashboard/backups}"
NODE="${NODE_BIN:-/opt/node24/bin/node}"
if [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ]; then echo "backup: Node.js not found (set NODE_BIN)" >&2; exit 1; fi

DEST="$ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$DEST"
chmod 700 "$DEST"

found=0
for db in auth.db ledger.db; do
  [ -f "$DATA/$db" ] || continue
  found=1
  "$NODE" -e '
    const { DatabaseSync } = require("node:sqlite");
    const [src, dest] = process.argv.slice(1);
    const live = new DatabaseSync(src, { readOnly: true });
    live.exec("VACUUM INTO '\''" + dest.replace(/'\''/g, "'\'''\''") + "'\''");
    live.close();
    const copy = new DatabaseSync(dest, { readOnly: true });
    const check = copy.prepare("PRAGMA integrity_check").all().map(r => Object.values(r)[0]);
    if (check.length !== 1 || check[0] !== "ok") throw new Error("integrity_check failed for " + dest);
    const v = copy.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get().v;
    copy.close();
    console.log("backup: " + require("node:path").basename(dest) + " ok (schema v" + v + ")");
  ' "$DATA/$db" "$DEST/$db"
done
if [ "$found" != 1 ]; then echo "backup: no databases found in $DATA" >&2; exit 1; fi

( cd "$DEST" && sha256sum ./*.db > SHA256SUMS )

if [ -n "${PICASSO_BACKUP_KEEP_DAYS:-}" ]; then
  case "$PICASSO_BACKUP_KEEP_DAYS" in (*[!0-9]*|'') echo "backup: PICASSO_BACKUP_KEEP_DAYS must be a number" >&2; exit 1 ;; esac
  find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$PICASSO_BACKUP_KEEP_DAYS" -exec rm -rf {} +
fi

echo "BACKUP_DIR=$DEST"
