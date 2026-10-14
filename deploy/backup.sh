#!/usr/bin/env bash
# Consistent online backup of Picasso's SQLite databases (safe while running).
# Usage: sudo -u picasso /opt/picasso-dashboard/app/deploy/backup.sh
# Cron (nightly 02:30): 30 2 * * * /opt/picasso-dashboard/app/deploy/backup.sh
set -euo pipefail
DATA=/opt/picasso-dashboard/data
DEST=/opt/picasso-dashboard/backups/$(date -u +%Y%m%dT%H%M%SZ)
KEEP_DAYS=30
mkdir -p "$DEST"
chmod 700 "$DEST"
for db in auth.db ledger.db; do
  if [ -f "$DATA/$db" ]; then
    # Uses SQLite's backup API via Node (no extra packages): consistent even with WAL.
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
      db.close();" "$DATA/$db" "$DEST/$db"
  fi
done
sha256sum "$DEST"/*.db > "$DEST/SHA256SUMS"
find /opt/picasso-dashboard/backups -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "Backup written to $DEST"
# Copy $DEST off the server as well (e.g. rsync to separate storage).
