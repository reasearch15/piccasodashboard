# Telegram bridge (Phase 2)

Status: **implemented and tested locally against a mock Bot API only.** No real
Telegram group has been contacted. Do not enable against real groups until the
owner approves (see "Staged rollout").

## Architecture

```
Telegram ──getUpdates (polling) or POST /api/telegram/webhook──▶ TelegramBot.handleUpdate
   │                                                               ├─ message  → parser → ledger.createIncomingPayment (pending)
   │                                                               └─ callback → membership + mapping checks → ledger.completeCashoutFromTelegram
   ◀── sendMessage / editMessageText ── outbox worker (every 3 s + on demand)
Dashboard ◀── SSE /api/events ("payments/cashouts changed") ── reloads via role-checked APIs
```

* `server/telegram/config.js`: env parsing and startup validation.
* `server/telegram/api.js`: official Bot API client; the token never appears in logs or errors.
* `server/telegram/parser.js`: provisional strict parser (versioned `provisional-v1`).
* `server/telegram/messages.js`: cash-out message text and the inline "Completed" button.
* `server/telegram/bot.js`: update handling, polling loop, delivery/edit outbox.
* `server/events.js`: Server-Sent Events hub (signals only, session re-checked on each push and every 25 s).
* Ledger migration v2 (`server/db.js`): source/dedupe columns, delivery outbox columns, `telegram_events` audit table.

Key safety properties:

* Cash-outs are **saved before** any Telegram call. Delivery status (`queued → sending → sent`, or `retrying → failed`) is separate from financial status (`pending → done | cancelled`).
* `pending → done` and `pending → cancelled` are single conditional `UPDATE … WHERE status='pending'` statements, so they are mutually exclusive and repeat clicks are no-ops.
* Message edits are retried independently and can never reverse a completion.
* Incoming payments are deduplicated by a unique `(chat_id, message_id)` index.
* Button `callback_data` is a random 128-bit token. It is resolved server-side and must also match the stored chat and message ID, and the message must come from this bot.
* Any current human member of the exact cash-out group can complete. Membership is checked with `getChatMember`; bots, former members, and unverifiable membership are rejected.
* While Telegram is on, the dashboard's "Demo: Mark Done" button is removed and its API returns 409.
* No Telegram chat IDs, message IDs, group names or error text are sent to the dashboard.

## Environment variables

See `.env.example`. Required when `PICASSO_TELEGRAM_MODE` is `polling` or `webhook`:
`PICASSO_TELEGRAM_BOT_TOKEN` and the four `…_CHAT_ID` values.
Webhook mode adds `PICASSO_TELEGRAM_WEBHOOK_SECRET`.
`PICASSO_TELEGRAM_ALLOW_LIVE=true` is required before the server will contact `api.telegram.org`.

## Telegram bot permissions (configure manually; the app never changes them)

1. **Privacy mode:** in @BotFather → Bot Settings → Group Privacy → **Turn off**, *or* make the bot an admin in the two incoming groups. Otherwise the bot cannot read payment messages.
2. **Incoming groups:** the bot needs only to be a member who can read messages.
3. **Cash-out groups:** the bot must be able to **send messages**. It edits only its own messages, which needs no extra right.
   The bot must be an administrator so `getChatMember` can reliably verify every clicker's current membership.
4. **Bots cannot see other bots' messages.** If payment notifications are posted by another bot, this bridge will never receive them. Notifications must come from a user account or be forwarded by one.
5. Get chat IDs and user IDs from a test group first (e.g. via `getUpdates` on a test bot), never by guessing.

## Message formats

Incoming (provisional, used for **both** Chime and Venmo), exactly one line:

```
Olivia Carter sent you $45.00
Ethan Reed sent you $1,250
```

The method is decided by which group the message arrived in, not by its text.
These are rejected (logged with a reason only, never the text): no `$`, two or more `$` amounts,
`$45.5`, multi-line text, missing sender, `$0`, amounts over $100,000, edited messages,
messages from the bot itself, and any chat not configured as an incoming group.

Outgoing cash-out (plain text plus an inline callback button):

```
PICASSO CASH OUT
Method: Venmo
Recipient: @exampleuser
Amount: $150.00
Requested by: John
Request ID: CO-000123
Status: PENDING
[Completed]
```

After completion the message is edited to `Status: COMPLETED` plus `Completed by: <name>`, with no button.
After cancellation it shows `Status: CANCELLED` plus `Cancelled by: <admin>`, with no button.

## Assumptions to confirm

* **No real Chime or Venmo samples were available.** The `<Name> sent you $<amount>` format is a placeholder.
  Collect 10–20 real messages per method (redacted), then replace `parser.js` and bump `PARSER_VERSION`.
  The real formats may well differ (Venmo's own wording is usually "paid you").
* The incoming message timestamp (`message.date`) is used as "received at".
* A message whose delivery outcome is unknown after a crash is resent once on restart. That can duplicate the Telegram *message*, never the financial request; the orphan's button is rejected by the message-ID check.
* The ledger is still the **demo** ledger (`demo-ledger.db`). Real money must not be recorded there. A production ledger file and mode is a prerequisite for go-live.

## Staged rollout (each stage needs owner approval)

1. **Local mock:** done (`npm test`, 75 passing).
2. **Real samples:** owner provides redacted real Chime/Venmo messages; the parser is updated and tested against them.
3. **Private test bot and test groups:** a new bot token plus four private test groups with only the owner. Use `polling` mode locally with `PICASSO_TELEGRAM_ALLOW_LIVE=true` and synthetic messages, and verify every flow by hand.
4. **Production ledger:** add a separate non-demo ledger database and mode so that real payments never land in demo data.
5. **VPS staging** (`payment.atlast.work`): HTTPS, `webhook` mode, `setWebhook` with `secret_token` done manually, still pointed at the test groups.
6. **Go-live:** point the chat IDs at the real groups, start with a small completer allowlist, and monitor `telegram_events`.

## Admin Attention (adjustments and unusual notifications)

Every message in an incoming group gets exactly one outcome (deduplicated by chat ID + message ID across both tables):

| Message | Outcome |
|---|---|
| `Olivia Carter sent you $45.00` | Pending payment (Payment Panel) |
| `Larry's BOT` / `Total In adjusted by -8.00$` | Admin Attention: Total In Adjustment, −800 cents |
| `Total Out adjusted by +12.50$` / `… 12.50$` | Admin Attention: Total Out Adjustment, +1250 cents (no sign means positive) |
| Adjustment wording with a missing or malformed amount, two adjustments, or an extra `$` amount | Admin Attention: Unrecognized, **no amount** |
| Other money-like text (`$`, refund, reversal, chargeback, declined, payment failed, …) that is not a valid payment | Admin Attention: Unrecognized, **no amount** |
| Plain conversation | No record (logged reason only) |

Messages dated more than 60 s before the bridge started are skipped (`ignored_historical`).
Attention events are stored with their original text, are never read by any total or settlement, survive demo reset, and are never deleted. Ignore is admin-only, idempotent, and records who and when.

**Limitation:** "Larry's BOT" is a bot. The Bot API never delivers one bot's messages to another bot, so in real groups these notifications will **not** arrive through this bridge. A user-account listener (e.g. Telethon, a separate approved component) must feed the same `TelegramBot.handleUpdate` path. That listener has not been built.

## Real Chime format (chime-v1)

Used only for the configured Chime incoming group (Venmo still uses the provisional format):

```
🟢 Hi $<recipient-tag>,
You received $<amount> from <Sender Name>.
08:39 PM - 14 Oct 2026          (optional, ignored)
➕ Total In: 15.00$              (ignored)
➖ Total Out: 0.00$              (ignored)
```

* The amount comes only from the "You received" line. `$14`, `$14.0`, `$14.00` and `$1,250.5` are accepted and stored as integer cents.
* The sender is stored as written. A trailing period is kept after an initial ("Amanda M.") and dropped after a full word.
* The recipient tag (e.g. `Kristen-Huey-1`) is stored internally in `recipient_tag` and not shown on the dashboard.
* The timestamp is the Telegram message date. The time line inside the text is not used.
* The following never create a payment:
  * any unexpected extra line, two "You received" lines, two greetings, or a missing greeting
  * `$14.000` or a negative amount
* A greeting/time/totals-only message creates no record. `Total In/Out adjusted by` messages still go to Admin Attention.

## Proposed Telethon listener (NOT built; needs approval)

The Bot API cannot read Larry's BOT. Proposal:

* A separate small process, `listener/picasso_listener.py` (Telethon), with **its own** session file such as `data/picasso-listener.session`. It is never TeleLedger's session, ideally logs in with a dedicated Telegram account, and is never run against a session another process has open.
* It subscribes with `events.NewMessage(chats=[<Chime id>, <Venmo id>])` only. There is no `iter_messages` or backfill, so history is never read. Picasso also drops anything older than its own start time.
* For each message it POSTs `{chatId, messageId, date, text, senderId}` to `http://127.0.0.1:3000/api/ingest/telegram-message` with `X-Picasso-Ingest-Secret`. It makes no decisions itself: parsing and dedupe stay in Picasso.
* It is read-only: it never sends, edits or deletes messages, and never joins or leaves groups.
* Approval is needed for: adding Python with `telethon`, the account to use, and the owner completing the phone-code login.

## StaffHelp bot: completion, admin cancellation, shared groups

* **Shared groups.** Each method's incoming and cash-out chat may be the same chat (`PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS=true`). Every message is classified explicitly, in this order:
  1. Cash-out request text → `ignored_cashout_request`. This covers Picasso's own `PICASSO CASH OUT` post and staff-typed `!! Cashout Request !!` / `Tag name :` / `Amoun :`. It never becomes a payment or an attention event.
  2. Our own bot posts → `ignored_own_message`.
  3. Payment → pending payment.
  4. Adjustment or other money-like text → Admin Attention.
  5. Anything else → no record.
* **Completed.** Any current human member of the exact cash-out group can complete. The callback's user ID is verified with `getChatMember`; bots and non-members are rejected.
  * The request must still be pending, and the press must come from the exact bot message mapped server-side.
  * A completion is recorded once (pending → done) and counts the requested amount.
  * The message is then edited to COMPLETED with no button.
* **Cancel (admin only).** Staff get 403 from the server. Pending → cancelled is atomic and can't overlap with completion. The action is recorded in the row and audit log, and the message is queued for **deletion** with `deleteMessage`. Removal status shows on the dashboard:
  * **Removed:** shown only when Telegram confirms the delete, or answers "message to delete not found".
  * **Temporary failure** (5xx, network, 429): retried with backoff.
  * **Permanent refusal** (e.g. a message older than Telegram lets bots delete): status becomes **failed**. The message is edited to CANCELLED with no button, so nobody pays it, and an admin can press Retry Removal.
  * Money is never touched by any Telegram step.
* **Bot permissions.** The bot needs *delete messages* only if it must delete messages other than its own. It always deletes **its own** request message, which is allowed without admin rights within Telegram's time limit. Making the bot an admin with "Delete messages" lifts that limit in groups.
