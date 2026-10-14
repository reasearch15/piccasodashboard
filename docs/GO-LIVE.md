# Picasso go-live plan: real payment groups

Status: **NOT DEPLOYED. NOT CONNECTED.** Everything below is gated on explicit owner approval.

## Readiness report

| Item | Status |
|---|---|
| Production ledger (separate file `data/ledger.db`, never seeded or reset, refuses to open as demo) | Built and tested locally. **Not created on the VPS.** |
| Activation boundary `2026-10-13T00:00:00+05:45`, persisted, compared as absolute time, applied before any record | Built and tested |
| Chime parser `chime-v1` (real format) | Built and tested on synthetic fixtures |
| Venmo parser | **No verified format.** Venmo messages go to Admin Attention only (`venmo-review-v1`) |
| Isolated Picasso Telethon session | **Not started. Blocker.** No listener code, no account, no session |
| VPS deployment config for payment.atlast.work | **Unknown. Blocker.** Not visible from this workstation; needs inspection on the server |
| Backups | **Blocker.** None configured |
| Message counts from 13 Oct onward | **Unavailable.** Needs the approved listener to export messages, then `server/backfill.js` preview |
| TeleLedger | Untouched. No Picasso code references it or any session file |

## Stages (each needs approval)

1. **Inspect the VPS** (read-only): how TeleLedger runs (service, user, session path), Node version (needs 24.7+), reverse proxy and TLS for payment.atlast.work, free ports, disk. No changes.
2. **Set up the Picasso listener** (approval needed):
   * Separate Unix user and directory, and its **own** Telegram account and session file.
   * Never TeleLedger's session, never run while another process holds it.
   * Owner does the phone-code login.
   * Read-only, `NewMessage` only for the two group IDs, no backfill.
   * It posts to `127.0.0.1:<port>/api/ingest/telegram-message` with the ingest secret.
3. **Count history** (approval needed): the listener exports 13 Oct 00:00 NPT onward to JSONL. Run `node server/backfill.js export.jsonl` (preview only) and report:
   * payment, attention, no-record, before-boundary, edited and duplicate counts
   * Chime totals
   * rejected reasons
4. **Deploy Picasso** with:
   * `PICASSO_LEDGER_MODE=production`
   * `PICASSO_PAYMENT_START_AT=2026-10-13T00:00:00+05:45`
   * the two real group IDs
   * the HTTPS proxy, `PICASSO_COOKIE_SECURE=auto` and `PICASSO_TRUST_PROXY=true`

   Then run `npm run init-admin`.
5. **Approved backfill** (only after the counts are approved): `node server/backfill.js export.jsonl --apply --approved-by "<owner>"`, with the server stopped. Every imported payment arrives pending.
6. **Start the live listener** (approval needed). Watch Admin Attention and `telegram_events`.

## Backup and rollback

* Before every stage, stop Picasso and copy `data/auth.db` and `data/ledger.db`, plus their `-wal` and `-shm` files, to a dated backup directory. Or take an online copy with `sqlite3 ledger.db ".backup ..."`.
* Schedule a nightly `.backup` to off-server storage and keep 30 days.
* **Rollback:** stop the listener, then stop Picasso, restore the previous `ledger.db`/`auth.db` and code, and start Picasso.
  * Picasso never writes to Telegram groups, apart from the bot posting cash-outs when that's enabled.
  * Rollback has no effect on TeleLedger.
* Recovery after restart is tested: records persist, the boundary is re-checked, and older backlog is not auto-imported.
