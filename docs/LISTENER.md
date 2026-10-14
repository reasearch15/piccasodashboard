# Picasso Telegram listener (Telethon user account)

**Status:** implemented and tested locally with mocked Telegram only. It is **not deployed, not logged in, and nothing has been imported.** Every production step below needs the owner's approval.

## Why it exists

Larry's bot posts the payment notifications. The Telegram Bot API never delivers one bot's messages to another bot, so the StaffHelp bot cannot see them. A **user account** can. This listener is a small, separate, read-only process that relays group messages to Picasso. Picasso alone decides what each message is.

```
Telegram groups ──(Telethon, read-only)──> picasso-telegram-listener (user picasso-tg)
                                              │ POST 127.0.0.1:3300/api/ingest/telegram-message  (secret header)
                                              │ POST 127.0.0.1:3300/api/ingest/telegram-gap
                                              ▼
                                   picasso-dashboard: cutoff → classify → verify sender → de-duplicate
                                              → pending payment | Admin Attention | ignored (logged)
```

## Decisions applied to every message (live and import alike)

Implemented once, in `server/telegram/incoming.js`:

1. **Group:** only the two configured groups. The method comes from the group, never from the text.
2. **StaffHelp bot posts** (`PICASSO_TELEGRAM_STAFFHELP_BOT_ID`) are ignored.
3. **Edits** never create or change anything.
4. **Activation boundary:** anything before `2026-10-13T00:00:00+05:45` (= `2026-10-12T18:15:00Z`), by the **original Telegram date**, is excluded.
5. **Cash-out messages** (`PICASSO CASH OUT`, `!! Cashout Request !!`, `Tag name :` / `Amoun :`) never become payments.
6. **Chime** uses the `chime-v1` parser. **Venmo** stays review-only: Admin Attention, no amount.
7. **Sender check:** a payment is created only if the sender is in `PICASSO_PAYMENT_SOURCE_SENDER_IDS` (Larry's bot). The same text from anyone else goes to Admin Attention, with no amount.
8. **De-duplication** is by (chat ID, message ID) across payments and attention events. Every payment is created **pending**: nothing is accepted, settled or completed automatically.

## Live operation and downtime

* **Delivery:** strictly in order. The per-group cursor advances only when Picasso acknowledges a message. While the dashboard is down, delivery is retried with backoff and nothing is skipped.
* **First start:** **no history is read.** The listener starts live from the newest message.
* **Restart:** it catches up only within `PICASSO_LISTENER_CATCHUP_MAX_HOURS` (default 6) and `…_MAX_MESSAGES` (default 500). Anything older or beyond those limits is **not imported**. It is reported as an **ingestion gap** in Admin Attention, naming the chat, message IDs and dates, so the owner can run an approved import for it.
* **Dashboard-side defence:** listener messages older than `PICASSO_LISTENER_MAX_AGE_HOURS` (default 12) are refused, and future-dated ones are rejected.
* **Reconnects:** Telethon reconnects automatically. If it disconnects for good, the process exits and systemd restarts it after 15 s. A bad session or configuration (exit 2/3) is not retried.
* **Flood control:** waits are honoured (capped by `PICASSO_LISTENER_FLOOD_WAIT_MAX_SECONDS`) and reading resumes.

## Historical import (from 13 Oct 2026) in three separate steps

1. **Export** (read-only towards Telegram; nothing is sent to Picasso):

   ```bash
   sudo -u picasso-tg bash -c 'set -a; . /etc/picasso-telegram-listener/listener.env; set +a; \
     PYTHONPATH=/opt/picasso-dashboard/app/listener /opt/picasso-telegram-listener/venv/bin/python \
     -m picasso_listener export-history --out /opt/picasso-telegram-listener/state/export-2026-10-13.jsonl'
   ```

   It reads from one second before the boundary (so 00:00 exactly is included), skips service messages, marks edited messages, resumes after flood waits, and records whether history before the boundary is visible at all (`reachedBoundary`).
2. **Preview** (read-only towards the ledger):

   ```bash
   sudo -u picasso node --env-file=/etc/picasso-dashboard/picasso.env server/backfill.js preview <export.jsonl>
   ```

   It prints:
   * messages inspected;
   * Chime payment candidates, with count, total, earliest and latest;
   * Venmo review events, adjustments, unverified senders and ambiguous messages;
   * cash-out messages excluded, StaffHelp bot posts, duplicates (already in Picasso or repeated in the export), before-boundary and edited messages;
   * reasons for no record, and any history-access limitations.

   It writes `<export>.preview.jsonl`, one decision per message: chat ID, message ID, original time, method, decision, parser decision, amount where reliably parsed, sender ID, and a SHA-256 of the text. **No names and no message text.** It also writes `<export>.preview-summary.json` and prints an **APPROVAL TOKEN**.
3. **Apply** (only after the owner has reviewed the preview):

   ```bash
   sudo -u picasso node --env-file=/etc/picasso-dashboard/picasso.env server/backfill.js apply <export.jsonl> --approval <token> --approved-by "<owner>"
   ```

   * **Binding:** the token binds the exact export file and the decision configuration (boundary, groups, verified senders, StaffHelp bot ID, Venmo mode). Any change means preview again.
   * **Safe to repeat:** apply is idempotent and resumable (re-running skips everything already imported), and safe alongside the running dashboard and live listener.
   * **Effect on displayed totals: none.** Imported payments are **pending**; Accepted In and the running balances change only when staff or admins accept them.

## Security

* **Separate identity:**
  * Linux user `picasso-tg` and its own Telegram login, never TeleLedger's.
  * Session in `/opt/picasso-telegram-listener/state` (directory 700, session file 600). The config refuses session paths that look like another app's.
  * Its own unit, `picasso-telegram-listener.service`, with no access to Picasso's data, backups or env.
* **Read-only:** the code only receives a `ReadOnlyClient` that exposes read methods. Sending, editing, deleting and forwarding are impossible, and a test enforces this.
* **Endpoint:** loopback only, refuses proxied requests, and the secret is checked in constant time on every request. Nginx returns 404 for `/api/ingest/telegram-message` from outside. The repository Nginx config now blocks the whole `/api/ingest/` prefix (message and gap). **Apply that to the live Nginx config before enabling the listener.**
* **No secrets in output:** the API hash, ingest secret and session never appear in config output, logs or errors.
* **No financial powers:** the listener can only submit messages. It cannot accept, settle, complete or cancel anything.

## Required configuration

**Dashboard** (`/etc/picasso-dashboard/picasso.env`):
* `PICASSO_LISTENER_INGEST_SECRET` (32+ random characters)
* `PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID` (the Chime group's numeric ID)
* `PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID` (the Venmo group's numeric ID)
* `PICASSO_PAYMENT_SOURCE_SENDER_IDS` (Larry's bot's **numeric** ID)
* `PICASSO_TELEGRAM_STAFFHELP_BOT_ID`
* `PICASSO_LISTENER_MAX_AGE_HOURS=12`

`PICASSO_TELEGRAM_MODE` stays `off`.

**Listener** (`/etc/picasso-telegram-listener/listener.env`): see `deploy/listener.env.example`.

## Tests

* `npm test`: Node, including `test/listener.test.js` and a contract test in which the real Python listener code posts to the real dashboard.
* `npm run test:listener`: Python unit tests with a fake Telethon client.
