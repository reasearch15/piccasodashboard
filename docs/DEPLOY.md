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

## 4. Safe update (redeploy)

Data lives outside the checkout, migrations only add columns or tables, and production can never be seeded or reset.

```bash
sudo -u picasso /opt/picasso-dashboard/app/deploy/backup.sh
cd /opt/picasso-dashboard/app && sudo -u picasso git fetch && sudo -u picasso git checkout <tag-or-commit>
sudo systemctl restart picasso-dashboard && curl -s http://127.0.0.1:<PORT>/healthz
```

## 5. Backups and rollback

* Nightly: `30 2 * * * /opt/picasso-dashboard/app/deploy/backup.sh` (crontab of `picasso`). Copy the backups off the server too.
* Rollback:

  ```bash
  sudo systemctl stop picasso-dashboard
  # restore code
  git checkout <previous-tag>
  # restore data: copy the backup's auth.db and ledger.db into data/, and delete any -wal/-shm files
  sudo systemctl start picasso-dashboard
  ```

## 6. Telegram (later, separate approval)

`PICASSO_TELEGRAM_MODE=off` until all of these are in place and verified:

* the isolated Picasso Telethon listener (own account, own session, never TeleLedger's)
* the Picasso bot and the **cash-out group IDs**
* the completer allowlist
* the parsers

Venmo stays review-only. Historical import happens only through `server/backfill.js` (preview first, then apply with owner approval), as described in docs/GO-LIVE.md.

While Telegram is off, cash-outs can be created but stay pending: production has no manual "Mark Done".
