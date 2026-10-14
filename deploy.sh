#!/usr/bin/env bash
# Picasso Dashboard production deployment.
#
#   cd /opt/picasso-dashboard/app
#   sudo bash deploy.sh --dry-run      # read-only checks and plan
#   sudo bash deploy.sh                # deploy origin/main
#
# Protecting existing financial data comes before completing an update:
#   * nothing is changed until every pre-check passes and a validated backup exists;
#   * code is only fast-forwarded (never reset, never forced);
#   * on failure the previous code revision is restored, but the database is
#     NEVER restored automatically (that could erase transactions recorded since);
#   * if automatic rollback is not provably safe, it stops and asks for a human.
#
# Options:
#   --dry-run          read-only: checks + planned actions, changes nothing
#   --allow-telegram   accept PICASSO_TELEGRAM_MODE other than "off" (separately approved)
#   -h, --help
#
# Exit codes:
#   0 success / already up to date        2 usage
#   3 precondition failed (nothing changed) 4 tracked files modified (nothing changed)
#   5 git fetch / fast-forward problem      6 Telegram not off (nothing changed)
#   7 backup failed (nothing changed)       8 update/validation failed before restart (code restored)
#   9 restart failed (code rolled back)    10 health check failed (code rolled back)
#  20 MANUAL INTERVENTION REQUIRED         75 another deployment is running

set -Eeuo pipefail
umask 077

readonly E_USAGE=2 E_PRECOND=3 E_DIRTY=4 E_GIT=5 E_TELEGRAM=6 E_BACKUP=7 E_UPDATE=8 E_RESTART=9 E_HEALTH=10 E_MANUAL=20 E_LOCKED=75

# --- Run from a private copy: updating the checkout must not change the script mid-run.
if [[ -z "${PICASSO_DEPLOY_SELF:-}" ]]; then
  self_copy="$(mktemp "${TMPDIR:-/tmp}/picasso-deploy.XXXXXX")"
  cp -- "${BASH_SOURCE[0]}" "$self_copy"
  PICASSO_DEPLOY_SELF="$self_copy" exec bash "$self_copy" "$@"
fi

# --- Configuration. Overrides are honoured only in the test harness.
if [[ "${PICASSO_DEPLOY_TEST:-0}" == 1 ]]; then cfg() { local v="${!1:-}"; printf '%s' "${v:-$2}"; }; else cfg() { printf '%s' "$2"; }; fi
APP_DIR="$(cfg DEPLOY_APP_DIR /opt/picasso-dashboard/app)"
DATA_DIR="$(cfg DEPLOY_DATA_DIR /opt/picasso-dashboard/data)"
BACKUP_ROOT="$(cfg DEPLOY_BACKUP_ROOT /opt/picasso-dashboard/backups)"
ENV_FILE="$(cfg DEPLOY_ENV_FILE /etc/picasso-dashboard/picasso.env)"
LOG_DIR="$(cfg DEPLOY_LOG_DIR /var/log/picasso-dashboard-deploy)"
STATE_DIR="$(cfg DEPLOY_STATE_DIR /var/lib/picasso-dashboard-deploy)"
LOCK_DIR="$(cfg DEPLOY_LOCK_DIR /run/lock/picasso-dashboard-deploy.lock)"
SERVICE="$(cfg DEPLOY_SERVICE picasso-dashboard)"
NODE_BIN="$(cfg DEPLOY_NODE_BIN /opt/node24/bin/node)"
NPM_BIN="$(cfg DEPLOY_NPM_BIN /opt/node24/bin/npm)"
SYSTEMCTL="$(cfg DEPLOY_SYSTEMCTL systemctl)"
JOURNALCTL="$(cfg DEPLOY_JOURNALCTL journalctl)"
CURL="$(cfg DEPLOY_CURL curl)"
REMOTE_RE="$(cfg DEPLOY_REMOTE_RE 'github\.com[:/]reasearch15/piccasodashboard(\.git)?/?$')"
HEALTH_TRIES="$(cfg DEPLOY_HEALTH_TRIES 15)"
HEALTH_DELAY="$(cfg DEPLOY_HEALTH_DELAY 2)"
FETCH_TIMEOUT="$(cfg DEPLOY_FETCH_TIMEOUT 90)"
BRANCH=main

DRY_RUN=0
ALLOW_TELEGRAM=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-telegram) ALLOW_TELEGRAM=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit "$E_USAGE" ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
PHASE=init
PREV=""
TARGET=""
CURRENT=""
BACKUP_DIR=""
LOCK_HELD=0
TMP_FILES=()

say()  { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { local code="$1"; shift; printf '\nDEPLOY FAILED (exit %s): %s\n' "$code" "$*" >&2; exit "$code"; }

# Runs on every exit. The exit code chosen by the script is preserved.
cleanup() {
  trap - ERR
  if [[ "$LOCK_HELD" == 1 ]]; then rm -rf -- "$LOCK_DIR"; fi
  rm -f -- "${TMP_FILES[@]}" "${PICASSO_DEPLOY_SELF:-}" 2>/dev/null || true
}
trap cleanup EXIT

on_error() {
  local rc=$? line=$1
  trap - ERR
  say "Unexpected error (exit $rc) at line $line during phase '$PHASE'."
  case "$PHASE" in
    updated|restarted) rollback "unexpected error during '$PHASE'" "$E_UPDATE" ;;
    *) exit "$E_PRECOND" ;;
  esac
}
trap 'on_error $LINENO' ERR

# mktmp VAR NAME [SUFFIX]: creates a private temp file and assigns its path to VAR.
mktmp() { local f; f="$(mktemp "${TMPDIR:-/tmp}/picasso-deploy-$2.XXXXXX")"; TMP_FILES+=("$f"); if [[ -n "${3:-}" ]]; then mv -- "$f" "$f$3"; f="$f$3"; TMP_FILES+=("$f"); fi; printf -v "$1" '%s' "$f"; }

# --- Run commands as the owner of the checkout, so file ownership never changes.
OWNER=""
as_owner() {
  if [[ "${PICASSO_DEPLOY_TEST:-0}" == 1 ]]; then "$@"; else runuser -u "$OWNER" -- "$@"; fi
}
git_app() { as_owner git -C "$APP_DIR" "$@"; }

# Reads one KEY from the env file without printing anything else from it.
env_get() {
  local line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%%#*}"
  line="${line//[$'\t\r ']/}"
  line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

file_mode() { stat -c '%U:%G %a' -- "$1" 2>/dev/null || echo unknown; }

# ---------------------------------------------------------------------------
# Lock (atomic mkdir; a stale lock from a dead process is cleared)
# ---------------------------------------------------------------------------
acquire_lock() {
  mkdir -p -- "$(dirname -- "$LOCK_DIR")"
  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"; LOCK_HELD=1; return
  fi
  local pid; pid="$(cat -- "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    die "$E_LOCKED" "another deployment is running (pid $pid). Wait for it to finish."
  fi
  say "Removing stale deployment lock (pid ${pid:-unknown} is not running)."
  rm -rf -- "$LOCK_DIR"
  mkdir -- "$LOCK_DIR" || die "$E_LOCKED" "could not acquire the deployment lock."
  echo "$$" > "$LOCK_DIR/pid"; LOCK_HELD=1
}

# ---------------------------------------------------------------------------
# Migration analysis (read-only). Compares server/db.js of two revisions and
# reads the live schema versions without writing to the databases.
# ---------------------------------------------------------------------------
MIG_REPORT=""
analyse_migrations() {
  local from_rev="$1" to_rev="$2" from_js to_js
  mktmp from_js from-db .js; mktmp to_js to-db .js
  git_app show "$from_rev:server/db.js" > "$from_js"
  git_app show "$to_rev:server/db.js" > "$to_js"
  MIG_REPORT="$("$NODE_BIN" -e '
    const fs = require("node:fs"), path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const [fromJs, toJs, dataDir] = process.argv.slice(1);
    const from = require(fromJs), to = require(toJs);
    const ADDITIVE = /^(ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN|CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX)\b/i;
    const additive = sql => sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean).every(s => ADDITIVE.test(s));
    const live = file => {
      const f = path.join(dataDir, file);
      if (!fs.existsSync(f)) return 0;
      try {
        const db = new DatabaseSync(f, { readOnly: true });
        try { return db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get().v; } finally { db.close(); }
      } catch { return "? (unreadable; the backup step will refuse)"; }
    };
    let safe = true;
    for (const [name, key] of [["auth", "AUTH_MIGRATIONS"], ["ledger", "LEDGER_MIGRATIONS"]]) {
      const a = from[key] || [], b = to[key] || [];
      const fresh = b.slice(a.length);
      const ok = b.slice(0, a.length).every((s, i) => s === a[i]) && fresh.every(additive);
      if (!ok) safe = false;
      console.log(`${name}: live v${live(name === "auth" ? "auth.db" : "ledger.db")}, current code v${a.length}, target code v${b.length}, new upgrades ${fresh.length}${fresh.length ? (ok ? " (additive only)" : " (NOT purely additive or history changed)") : ""}`);
    }
    console.log(`ROLLBACK_SAFE=${safe ? 1 : 0}`);
  ' "$from_js" "$to_js" "$DATA_DIR")"
}
rollback_safe() { grep -qx 'ROLLBACK_SAFE=1' <<<"$MIG_REPORT"; }

# Loads the production configuration with the code currently checked out,
# without starting the server. Root opens the env file and passes only the
# open descriptor, so this works whatever the file's permissions are and the
# file is never copied. Error messages contain no configuration values.
validate_config() {
  local cfg_err env_arg="/dev/fd/3"
  mktmp cfg_err config-check
  if [[ "${PICASSO_DEPLOY_TEST:-0}" == 1 ]]; then env_arg="$ENV_FILE"; fi
  if (cd "$APP_DIR" && as_owner "$NODE_BIN" --env-file="$env_arg" -e 'try { require("./server/config").loadConfig(); require("./server/app"); } catch (e) { console.error(String(e.message).split("\n").slice(0, 8).join("\n")); process.exit(1); }' >/dev/null 2>"$cfg_err" 3<"$ENV_FILE"); then
    return 0
  fi
  sed 's/^/    /' "$cfg_err"
  return 1
}

# ---------------------------------------------------------------------------
# Service checks
# ---------------------------------------------------------------------------
health_ok() {
  local body code out
  mktmp out health
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    code="$("$CURL" -sS --max-time 5 -o "$out" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
    body="$(tr -d '[:space:]' < "$out" 2>/dev/null || true)"
    if [[ "$code" == 200 && "$body" == '{"ok":true}' ]]; then return 0; fi
    sleep "$HEALTH_DELAY"
  done
  say "Health check failed after $HEALTH_TRIES attempts (last HTTP status: ${code:-none})."
  return 1
}

service_active() {
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    if "$SYSTEMCTL" is-active --quiet "$SERVICE"; then return 0; fi
    sleep "$HEALTH_DELAY"
  done
  return 1
}

save_service_logs() {
  local f="$LOG_DIR/journal-$TS.log"
  "$JOURNALCTL" -u "$SERVICE" -n 300 --no-pager > "$f" 2>&1 || true
  chmod 600 "$f" 2>/dev/null || true
  say "Service log saved: $f"
}

# ---------------------------------------------------------------------------
# Rollback: code only. The database is never restored automatically.
# ---------------------------------------------------------------------------
manual() {
  printf '\n%s\n' "############################ MANUAL INTERVENTION REQUIRED ############################"
  printf '%s\n' "$@"
  printf '%s\n' "  Deployment log : $LOG_FILE" \
                "  Backup         : ${BACKUP_DIR:-none taken}" \
                "  Previous code  : ${PREV:-unknown}" \
                "  Target code    : ${TARGET:-unknown}" \
                "The database was NOT restored. Do not restore a backup over live data without first" \
                "checking for transactions recorded after the backup was taken."
  printf '%s\n' "#######################################################################################"
  exit "$E_MANUAL"
}

rollback() {
  local reason="$1" code="$2"
  trap - ERR
  PHASE=rollback
  step "Rolling back: $reason"
  save_service_logs
  if [[ "$SERVICE_RESTARTED" == 0 && "$(git_app rev-parse HEAD)" == "$CURRENT" ]]; then
    die "$code" "$reason. Code unchanged at ${CURRENT:0:12}; database untouched; nothing restarted. Log: $LOG_FILE"
  fi
  if [[ "$SERVICE_RESTARTED" == 0 ]]; then
    # Database upgrades only run when the service starts, and it has not been
    # restarted: returning to the checkout we started from is always safe.
    PREV="$CURRENT"
  fi
  if [[ -z "$PREV" ]]; then
    manual "No verified previous revision is recorded, so automatic rollback is not possible." \
           "Reason: $reason"
  fi
  if [[ "$SERVICE_RESTARTED" == 1 ]] && ! rollback_safe; then
    manual "The target revision added database upgrades that are not purely additive (or changed" \
           "earlier ones). Running the previous code against the upgraded database is not proven safe," \
           "so the code was left at the target revision for a human to decide." \
           "Reason: $reason"
  fi
  if [[ -n "$(git_app status --porcelain --untracked-files=no)" ]]; then
    manual "Tracked files changed during deployment; refusing to switch revisions automatically." "Reason: $reason"
  fi
  # Detached checkout of the previous revision: nothing is reset or deleted, the
  # target commit stays on main/origin, and the state is obvious to the next run.
  if ! git_app checkout --quiet --detach "$PREV"; then
    manual "Could not check out the previous revision $PREV." "Reason: $reason"
  fi
  say "Code restored to previous revision $PREV (detached HEAD; 'main' still points at $TARGET)."
  if [[ "$code" == "$E_UPDATE" && "$SERVICE_RESTARTED" == 0 ]]; then
    say "The service was not restarted during this deployment; it keeps running the previous revision."
    die "$code" "$reason. Code restored to $PREV; database untouched; nothing restarted. Log: $LOG_FILE"
  fi
  if ! "$SYSTEMCTL" restart "$SERVICE" || ! service_active || ! health_ok; then
    save_service_logs
    manual "The previous revision $PREV also failed to start or pass the health check." "Reason: $reason"
  fi
  printf '\n%s\n' "ROLLED BACK: service is healthy on the previous revision $PREV."
  printf '%s\n' \
    "  Failure        : $reason" \
    "  Database       : not restored (upgrades are additive; all transactions kept)" \
    "  Backup         : $BACKUP_DIR" \
    "  Log            : $LOG_FILE" \
    "  Next steps     : fix the problem, then 'sudo -u $OWNER git -C $APP_DIR checkout main' and deploy again."
  exit "$code"
}

# ===========================================================================
# Main
# ===========================================================================
SERVICE_RESTARTED=0

if [[ "${PICASSO_DEPLOY_TEST:-0}" != 1 && "$(id -u)" != 0 ]]; then
  echo "Run as root: sudo bash deploy.sh [--dry-run]" >&2; exit "$E_PRECOND"
fi

mkdir -p -- "$LOG_DIR" "$STATE_DIR"
chmod 700 "$LOG_DIR" "$STATE_DIR" 2>/dev/null || true
RUN_KIND=""; RUN_LABEL=""
if [[ "$DRY_RUN" == 1 ]]; then RUN_KIND="-dry-run"; RUN_LABEL="(DRY RUN: no changes will be made)"; fi
LOG_FILE="$LOG_DIR/deploy-$TS$RUN_KIND.log"
exec > >(tee -a "$LOG_FILE") 2>&1
chmod 600 "$LOG_FILE" 2>/dev/null || true

step "Picasso Dashboard deployment $RUN_LABEL"
acquire_lock

# --- 1. Is this the Picasso installation?
PHASE=checks
step "1. Verifying installation"
[[ -d "$APP_DIR/.git" ]] || die "$E_PRECOND" "$APP_DIR is not a git checkout."
[[ -d "$DATA_DIR" ]] || die "$E_PRECOND" "data directory $DATA_DIR does not exist."
OWNER="$(stat -c '%U' -- "$APP_DIR")"
grep -q '"name": *"picasso-dashboard"' "$APP_DIR/package.json" 2>/dev/null || die "$E_PRECOND" "$APP_DIR does not look like Picasso Dashboard."
"$SYSTEMCTL" cat "$SERVICE" >/dev/null 2>&1 || die "$E_PRECOND" "systemd unit '$SERVICE' not found."
remote="$(git_app remote get-url origin 2>/dev/null || true)"
[[ "$remote" =~ $REMOTE_RE ]] || die "$E_PRECOND" "origin remote is not reasearch15/piccasodashboard."
node_version="$("$NODE_BIN" --version 2>/dev/null || true)"
[[ "$node_version" =~ ^v([0-9]+)\.([0-9]+) ]] || die "$E_PRECOND" "Node.js not found at $NODE_BIN."
(( BASH_REMATCH[1] > 24 || (BASH_REMATCH[1] == 24 && BASH_REMATCH[2] >= 7) )) || die "$E_PRECOND" "Node.js $node_version at $NODE_BIN is older than 24.7."
say "App $APP_DIR (owner $OWNER), data $DATA_DIR, service $SERVICE, Node $node_version"

# --- 2. Production configuration (values are never printed except the ones below)
step "2. Checking production configuration"
[[ -f "$ENV_FILE" ]] || die "$E_PRECOND" "environment file $ENV_FILE not found."
ENV_MODE_BEFORE="$(file_mode "$ENV_FILE")"
say "Environment file present ($ENV_MODE_BEFORE). Contents are not displayed."
[[ "$(env_get PICASSO_LEDGER_MODE)" == production ]] || die "$E_PRECOND" "PICASSO_LEDGER_MODE is not 'production' in $ENV_FILE."
host="$(env_get PICASSO_HOST)"; host="${host:-127.0.0.1}"
[[ "$host" == 127.0.0.1 || "$host" == ::1 || "$host" == localhost ]] || die "$E_PRECOND" "PICASSO_HOST must stay on loopback (found '$host'); the app must not be exposed directly."
port="$(env_get PICASSO_PORT)"; port="${port:-3000}"
[[ "$port" =~ ^[0-9]+$ ]] || die "$E_PRECOND" "PICASSO_PORT is not a number."
HEALTH_URL="http://127.0.0.1:$port/healthz"
tg_mode="$(env_get PICASSO_TELEGRAM_MODE)"; tg_mode="${tg_mode:-off}"
if [[ "$tg_mode" != off && "$ALLOW_TELEGRAM" != 1 ]]; then
  die "$E_TELEGRAM" "PICASSO_TELEGRAM_MODE is '$tg_mode'. Telegram must stay off unless activation is approved (--allow-telegram)."
fi
say "Ledger mode production; loopback port $port; Telegram mode '$tg_mode'."

# --- 3. Git state
step "3. Checking git state"
branch="$(git_app symbolic-ref --short -q HEAD || true)"
if [[ "$branch" != "$BRANCH" ]]; then
  die "$E_PRECOND" "checkout is on '${branch:-detached HEAD at $(git_app rev-parse --short HEAD)}', not '$BRANCH' (e.g. after a rollback). Review, then: sudo -u $OWNER git -C $APP_DIR checkout $BRANCH"
fi
dirty="$(git_app status --porcelain --untracked-files=no)"
if [[ -n "$dirty" ]]; then
  printf '%s\n' "$dirty" | sed 's/^/    /'
  die "$E_DIRTY" "tracked files have uncommitted changes. Nothing was changed; resolve them by hand (no automatic reset)."
fi
say "Fetching origin/$BRANCH ..."
if ! as_owner timeout "$FETCH_TIMEOUT" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"; then
  die "$E_GIT" "git fetch from origin failed. Nothing was changed."
fi
CURRENT="$(git_app rev-parse HEAD)"
TARGET="$(git_app rev-parse "refs/remotes/origin/$BRANCH")"
LAST_DEPLOYED="$(cat -- "$STATE_DIR/deployed-revision" 2>/dev/null || true)"
say "Current checkout : $CURRENT"
say "Target origin/$BRANCH: $TARGET"
say "Last deployed by this script: ${LAST_DEPLOYED:-none recorded}"
if ! git_app merge-base --is-ancestor "$CURRENT" "$TARGET"; then
  die "$E_GIT" "local $BRANCH has commits that are not on origin/$BRANCH. Refusing (no force updates)."
fi

# Previous revision for rollback: the revision the service is known to run.
if [[ "$CURRENT" != "$TARGET" ]]; then
  PREV="$CURRENT"
elif [[ -n "$LAST_DEPLOYED" && "$LAST_DEPLOYED" != "$TARGET" ]] && git_app merge-base --is-ancestor "$LAST_DEPLOYED" "$TARGET" 2>/dev/null; then
  PREV="$LAST_DEPLOYED"
fi

if [[ "$CURRENT" == "$TARGET" && "$LAST_DEPLOYED" == "$TARGET" ]]; then
  step "Already up to date"
  if "$SYSTEMCTL" is-active --quiet "$SERVICE" && HEALTH_TRIES=1 health_ok; then
    say "Service is active and healthy on $TARGET. Nothing to do."
    exit 0
  fi
  die "$E_PRECOND" "code is current but the service is not healthy. Investigate (journalctl -u $SERVICE); nothing was changed."
fi
if [[ "$CURRENT" == "$TARGET" ]]; then
  say "Checkout already at target, but this script has no record of the running service on it; it will be backed up and restarted."
fi

git_app log --oneline "${PREV:-$CURRENT}..$TARGET" 2>/dev/null | sed 's/^/    /' || true

# Dependencies policy for the target (checked before anything changes).
target_pkg="$(git_app show "$TARGET:package.json")"
has_lock=0
git_app cat-file -e "$TARGET:package-lock.json" 2>/dev/null && has_lock=1
if [[ "$has_lock" == 0 ]] && grep -Eq '"(dependencies|optionalDependencies)" *: *\{ *"' <<<"$target_pkg"; then
  die "$E_UPDATE" "target package.json declares dependencies but has no package-lock.json. Refusing."
fi

step "4. Database upgrade analysis (read-only)"
analyse_migrations "${PREV:-$CURRENT}" "$TARGET"
grep -v '^ROLLBACK_SAFE=' <<<"$MIG_REPORT" | sed 's/^/    /'
if rollback_safe; then say "Automatic code rollback is safe for this upgrade."; else say "WARNING: automatic rollback would NOT be safe; failures will stop for manual intervention."; fi

if [[ "$DRY_RUN" == 1 ]]; then
  step "Configuration check with the current code (read-only)"
  if validate_config; then say "Configuration accepted by the current code."; else say "WARNING: the current code rejects the configuration (see above)."; fi
  step "DRY RUN complete. Planned actions (none performed):"
  printf '    %s\n' \
    "back up auth.db/ledger.db with deploy/backup.sh (SQLite VACUUM INTO + integrity check)" \
    "back up $ENV_FILE to $STATE_DIR/env-backups/ (root-only, mode 600) and record revisions" \
    "$( [[ $CURRENT != "$TARGET" ]] && echo "fast-forward $APP_DIR from ${CURRENT:0:12} to ${TARGET:0:12}" || echo "keep code at ${TARGET:0:12}")" \
    "$( [[ $has_lock == 1 ]] && echo "npm ci --omit=dev --ignore-scripts with $NPM_BIN" || echo "no dependencies to install (no package-lock.json)")" \
    "validate configuration with the target code" \
    "systemctl restart $SERVICE, then require HTTP 200 {\"ok\":true} from $HEALTH_URL"
  exit 0
fi

# --- 5. Backups (nothing has changed yet)
PHASE=backup
step "5. Backing up databases and configuration"
mktmp backup_script backup .sh
git_app show "$TARGET:deploy/backup.sh" > "$backup_script" || die "$E_BACKUP" "could not read deploy/backup.sh from the target revision."
chmod 755 "$backup_script"
mktmp backup_out backup-out
if ! as_owner env NODE_BIN="$NODE_BIN" PICASSO_DATA_DIR="$DATA_DIR" PICASSO_BACKUP_ROOT="$BACKUP_ROOT" bash "$backup_script" > "$backup_out" 2>&1; then
  sed 's/^/    /' "$backup_out"
  die "$E_BACKUP" "database backup failed. Nothing was changed."
fi
sed 's/^/    /' "$backup_out"
BACKUP_DIR="$(sed -n 's/^BACKUP_DIR=//p' "$backup_out" | tail -n 1)"
[[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]] || die "$E_BACKUP" "backup did not report its directory. Nothing was changed."
# Validate independently of the backup script.
for db in auth.db ledger.db; do
  if [[ -f "$DATA_DIR/$db" ]]; then
    [[ -s "$BACKUP_DIR/$db" ]] || die "$E_BACKUP" "backup of $db is missing or empty. Nothing was changed."
    "$NODE_BIN" -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const r = db.prepare("PRAGMA integrity_check").all().map(x => Object.values(x)[0]);
      db.prepare("SELECT COUNT(*) FROM schema_migrations").get();
      db.close();
      if (r.length !== 1 || r[0] !== "ok") process.exit(1);' "$BACKUP_DIR/$db" \
      || die "$E_BACKUP" "backup of $db failed validation. Nothing was changed."
  fi
done
( cd "$BACKUP_DIR" && sha256sum -c --quiet SHA256SUMS ) || die "$E_BACKUP" "backup checksums do not verify. Nothing was changed."
# The environment file holds secrets, so its backup lives in the root-only
# state directory, never in the service-owned backup directory: root never
# writes into a directory the service user could tamper with.
ENV_BACKUP_DIR="$STATE_DIR/env-backups"
mkdir -p -- "$ENV_BACKUP_DIR"
chmod 700 "$ENV_BACKUP_DIR" 2>/dev/null || true
ENV_BACKUP="$ENV_BACKUP_DIR/picasso.env.$TS"
[[ ! -e "$ENV_BACKUP" && ! -L "$ENV_BACKUP" ]] || die "$E_BACKUP" "$ENV_BACKUP already exists. Nothing was changed."
cp -- "$ENV_FILE" "$ENV_BACKUP" || die "$E_BACKUP" "could not back up the environment file. Nothing was changed."
chmod 600 "$ENV_BACKUP"
cmp -s -- "$ENV_FILE" "$ENV_BACKUP" || die "$E_BACKUP" "environment backup does not match the original. Nothing was changed."
# Revision record, written by the service user into its own backup directory.
printf '%s\n' "timestamp=$TS" "previous_revision=${PREV:-unknown}" "checkout_before=$CURRENT" \
  "target_revision=$TARGET" "env_backup=$ENV_BACKUP" "log=$LOG_FILE" \
  | as_owner tee "$BACKUP_DIR/DEPLOY_INFO" >/dev/null || die "$E_BACKUP" "could not record DEPLOY_INFO. Nothing was changed."
say "Backup validated: $BACKUP_DIR (databases, revisions); environment file saved root-only to $ENV_BACKUP."

# --- 6. Update code (fast-forward only)
if [[ "$CURRENT" != "$TARGET" ]]; then
  step "6. Updating code ${CURRENT:0:12} -> ${TARGET:0:12} (fast-forward only)"
  git_app merge --ff-only --quiet "$TARGET" || die "$E_UPDATE" "fast-forward failed. Nothing else was changed."
  PHASE=updated
  [[ "$(git_app rev-parse HEAD)" == "$TARGET" ]] || rollback "checkout is not at the target after the update" "$E_UPDATE"
else
  step "6. Code already at ${TARGET:0:12}"
  PHASE=updated
fi

# --- 7. Dependencies
step "7. Dependencies"
if [[ -f "$APP_DIR/package-lock.json" ]]; then
  if ! (cd "$APP_DIR" && as_owner env PATH="$(dirname -- "$NODE_BIN"):$PATH" "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund); then
    rollback "npm ci failed" "$E_UPDATE"
  fi
else
  say "No package-lock.json and no dependencies: nothing to install."
fi

# --- 8. Validate configuration with the new code before restarting
step "8. Validating configuration with the target code"
if ! validate_config; then
  rollback "the target code rejected the production configuration (nothing was restarted)" "$E_UPDATE"
fi
say "Configuration accepted."

# --- 9. Restart only this service
PHASE=restarted
step "9. Restarting $SERVICE"
SERVICE_RESTARTED=1
"$SYSTEMCTL" restart "$SERVICE" || rollback "systemctl restart $SERVICE failed" "$E_RESTART"
service_active || rollback "$SERVICE did not become active" "$E_RESTART"

# --- 10. Health
step "10. Health check $HEALTH_URL"
health_ok || rollback "health check did not return HTTP 200 {\"ok\":true}" "$E_HEALTH"

# --- Done
PHASE=done
[[ "$(file_mode "$ENV_FILE")" == "$ENV_MODE_BEFORE" ]] || say "WARNING: environment file ownership/permissions changed during deployment."
printf '%s\n' "$TARGET" > "$STATE_DIR/deployed-revision"
printf '%s\n' "${PREV:-unknown}" > "$STATE_DIR/previous-revision"
step "DEPLOYED $TARGET"
printf '%s\n' "  Previous revision : ${PREV:-unknown}" \
              "  Backup            : $BACKUP_DIR" \
              "  Log               : $LOG_FILE" \
              "  Health            : $HEALTH_URL -> {\"ok\":true}"
exit 0
