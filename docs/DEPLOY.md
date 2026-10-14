# Deploying Picasso Dashboard to payment.atlast.work

**Not deployed yet.** Follow these steps only after the owner approves. Nothing here touches TeleLedger, Atlas, AppBeg or any other service.

## 0. Inspect the VPS first (read-only)

```bash
node --version                      # needs >= 24.7 (built-in sqlite + argon2)
sudo ss -ltnp                       # pick a FREE localhost port for Picasso
ls /etc/nginx/sites-enabled/        # existing sites; do not edit them
sudo nginx -T | grep server_name    # confirm nothing already serves payment.atlast.work
systemctl list-units --type=service | grep -Ei 'teleledger|atlas|appbeg'
df -h /opt
```

## 1. Layout

```
/opt/picasso-dashboard/app       git checkout (code only)
/opt/picasso-dashboard/data      auth.db, ledger.db (persistent, outside Git)
/opt/picasso-dashboard/backups   dated backups
/etc/picasso-dashboard/picasso.env   secrets/config (root:picasso 640)
```

```bash
sudo useradd --system --home /opt/picasso-dashboard --shell /usr/sbin/nologin picasso
sudo mkdir -p /opt/picasso-dashboard/{data,backups} /etc/picasso-dashboard
sudo git clone <your-repo-url> /opt/picasso-dashboard/app
sudo chown -R picasso:picasso /opt/picasso-dashboard
sudo chmod 700 /opt/picasso-dashboard/data /opt/picasso-dashboard/backups
sudo cp /opt/picasso-dashboard/app/deploy/picasso.env.example /etc/picasso-dashboard/picasso.env
sudo nano /etc/picasso-dashboard/picasso.env      # set PICASSO_PORT to the free port
sudo chown root:picasso /etc/picasso-dashboard/picasso.env && sudo chmod 640 /etc/picasso-dashboard/picasso.env
```

There are no npm dependencies, so no `npm install` is needed.

## 2. Initialise the admin (once)

The prompt is hidden and the password is never stored anywhere but its Argon2id hash.

```bash
cd /opt/picasso-dashboard/app
sudo -u picasso node --env-file=/etc/picasso-dashboard/picasso.env server/init-admin.js
```

This creates `CharsiNew` and nothing else. No staff and no demo data are created. The first server start creates an **empty** `ledger.db`: 0 payments, 0 cash-outs, 0 settlements, 0 attention events, all balances $0.00. It also stamps `ledger_kind=production` and the 2026-10-13T00:00:00+05:45 boundary into that file.

## 3. Service and Nginx

```bash
sudo cp deploy/picasso-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now picasso-dashboard
curl -s http://127.0.0.1:<PORT>/healthz          # {"ok":true}

sudo certbot certonly --nginx -d payment.atlast.work
sudo cp deploy/nginx-payment.atlast.work.conf /etc/nginx/sites-available/payment.atlast.work
sudo sed -i 's/127.0.0.1:PORT/127.0.0.1:<PORT>/' /etc/nginx/sites-available/payment.atlast.work
sudo ln -s /etc/nginx/sites-available/payment.atlast.work /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx      # reload, never restart, so other sites are not interrupted
curl -s https://payment.atlast.work/healthz
```

## 4. Updating with deploy.sh

`deploy.sh` (repository root) is the only supported way to update production:

```bash
cd /opt/picasso-dashboard/app
sudo bash deploy.sh --dry-run    # read-only: checks, upgrade analysis, config check, plan
sudo bash deploy.sh              # deploy origin/main
```

What it does, in order. It stops at the first problem.

1. **Checks the installation:** the checkout, the `reasearch15/piccasodashboard` remote, the `picasso-dashboard` unit, and Node 24.7+ at `/opt/node24/bin/node`. It takes a lock, so only one deployment runs at a time.
2. **Checks the configuration** without printing it: the ledger is production, `PICASSO_HOST` is loopback, and `PICASSO_TELEGRAM_MODE=off` unless `--allow-telegram` is passed.
3. **Checks git:** on `main`, no modified tracked files, then fetches `origin/main`. It refuses if local `main` has diverged. It **never** resets, forces or cleans anything.
4. **Analyses the database upgrades** (read-only): it compares the current and target migrations and the live schema versions, and decides whether an automatic code rollback would be safe.
5. **Backs up**, using `deploy/backup.sh` from the target revision. That means SQLite `VACUUM INTO` and `integrity_check`, then checksums. The database copies and `DEPLOY_INFO` go into `/opt/picasso-dashboard/backups/<timestamp>/`. The env file, which holds secrets, is saved **root-only** (mode 600) to `/var/lib/picasso-dashboard-deploy/env-backups/`, never into the service-owned backup directory. Nothing has changed before this succeeds.
6. **Fast-forwards** the checkout as the `picasso` user, so file ownership never changes.
7. **Installs dependencies** only if a `package-lock.json` exists (`npm ci --omit=dev --ignore-scripts`). Today there are none.
8. **Validates the configuration** with the new code before restarting.
9. **Restarts only `picasso-dashboard`**, then requires HTTP 200 `{"ok":true}` from `http://127.0.0.1:<PICASSO_PORT>/healthz`.

Logs go to `/var/log/picasso-dashboard-deploy/`. The last deployed revision is recorded in `/var/lib/picasso-dashboard-deploy/`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success, or already up to date |
| 3 / 4 / 5 / 6 / 7 | Refused before anything changed |
| 8 | Failed before restart; code restored |
| 9 / 10 | Restart or health check failed; rolled back |
| 20 | Manual intervention required |
| 75 | Another deployment is running |

### First run (the VPS checkout does not contain deploy.sh yet)

```bash
sudo -u picasso git -C /opt/picasso-dashboard/app fetch origin main
sudo -u picasso git -C /opt/picasso-dashboard/app show origin/main:deploy.sh > /tmp/picasso-deploy.sh
sudo bash /tmp/picasso-deploy.sh --dry-run
sudo bash /tmp/picasso-deploy.sh
```

The script always works on `/opt/picasso-dashboard/app`, wherever it is run from. Later runs use `cd /opt/picasso-dashboard/app && sudo bash deploy.sh`.

## 5. Backups and rollback

* **Nightly backups** (crontab of `picasso`). Copy the backups off the server too:

  ```
  30 2 * * * PICASSO_BACKUP_KEEP_DAYS=30 /opt/picasso-dashboard/app/deploy/backup.sh
  ```

  Pruning happens **only** when `PICASSO_BACKUP_KEEP_DAYS` is set. Deployments never delete backups.
* **Automatic rollback restores code only.** It checks out the previous revision (detached HEAD; `main` is untouched), restarts and health-checks. The **database is never restored automatically**: migrations only add tables and columns, older code runs against them, and restoring a backup would erase every transaction recorded since it was taken.
* **Exit 20 (manual intervention)** happens when:
  * the target added a migration that is not purely additive (or edited an earlier one);
  * there is no recorded previous revision;
  * the previous revision also fails its health check.

  In those cases the service, code and data are left as they are for a human to decide.
* **After a rollback**, fix the problem, then `sudo -u picasso git -C /opt/picasso-dashboard/app checkout main` and deploy again. The script refuses to run from a detached HEAD.
* **Manual database restore (last resort):**
  1. Stop the service.
  2. Compare the backup's records against the live database to find any transactions recorded after the backup.
  3. Only then copy `auth.db`/`ledger.db` from the backup into `data/` and delete any `-wal`/`-shm` files.

## 6. Telegram (later, separate approval)

`PICASSO_TELEGRAM_MODE=off` until all of these are in place and verified:

* the isolated Picasso Telethon listener (own account, own session, never TeleLedger's)
* the Picasso bot and the **cash-out group IDs**
* the completer allowlist
* the parsers

Venmo stays review-only. Historical import happens only through `server/backfill.js` (preview first, then apply with owner approval), as described in docs/GO-LIVE.md.

While Telegram is off, cash-outs can be created but stay pending: production has no manual "Mark Done".
