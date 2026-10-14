'use strict';
// DEMO LEDGER: data lives in demo-ledger.db, separate from real accounts. It
// never talks to Venmo, Chime or any cash-out service itself; the Telegram
// bridge (server/telegram/) feeds it and reads its outbox. A production ledger
// must be a new module and database; never migrate these rows into it.
const crypto = require('node:crypto');
const Core = require('../settlement-core.js');
const { requestId } = require('./telegram/messages');
const { transaction } = require('./db');

const ago = m => new Date(Date.now() - m * 60000).toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });

// Same records the original static demo seeded (fresh() + addChimeDemoData()).
// Attribution IDs such as "john" are historical snapshots, not login accounts.
function seedRecords() {
  const payments = [
    ['p1', 'Venmo', 'Larry Forkner', 2000, 'pending', 4],
    ['p2', 'Chime', 'Kristen Huey', 5000, 'accepted', 32, 'John', 1],
    ['p3', 'Venmo', 'Michael Smith', 3500, 'pending', 2],
    ['p4', 'Venmo', 'David Wilson', 12000, 'accepted', 25, 'Alex', 2],
    ['p5', 'Venmo', 'Maya Chen', 80000, 'accepted', 20, 'Owner', 3],
    ['p6', 'Venmo', 'Noah Brooks', 5000, 'accepted', 8, 'John', 4],
  ].map(x => ({ id: x[0], method: x[1], name: x[2], amountCents: x[3], status: x[4], receivedAt: ago(x[5]), acceptedAt: x[4] === 'accepted' ? ago(x[5] - 1) : null, acceptedById: null, acceptedBy: x[6] || null, acceptOrder: x[7] || null }));
  payments.push(
    { id: 'chime-pending-1', method: 'Chime', name: 'Olivia Carter', amountCents: 4500, status: 'pending', receivedAt: ago(1) },
    { id: 'chime-pending-2', method: 'Chime', name: 'Ethan Reed', amountCents: 9000, status: 'pending', receivedAt: ago(11) },
    { id: 'chime-accepted-1', method: 'Chime', name: 'Sophia Patel', amountCents: 17500, status: 'accepted', receivedAt: ago(18), acceptedAt: ago(17), acceptedById: 'john', acceptedBy: 'John', acceptOrder: 5 },
    { id: 'chime-accepted-2', method: 'Chime', name: 'Marcus Lee', amountCents: 6000, status: 'accepted', receivedAt: ago(10), acceptedAt: ago(9), acceptedById: 'alex', acceptedBy: 'Alex', acceptOrder: 6 },
    { id: 'chime-accepted-3', method: 'Chime', name: 'Ava Thompson', amountCents: 24000, status: 'accepted', receivedAt: ago(6), acceptedAt: ago(5), acceptedById: 'admin', acceptedBy: 'Owner', acceptOrder: 7 },
  );
  const cashouts = [
    { id: 'o1', method: 'Venmo', name: '@demo-vendor', amountCents: 30000, status: 'done', createdAt: ago(15), completedAt: ago(6), createdById: null, createdBy: 'John' },
    { id: 'o2', method: 'Chime', name: '@alex45', amountCents: 1500, status: 'pending', createdAt: ago(5), createdById: null, createdBy: 'Alex' },
    { id: 'chime-out-done-1', method: 'Chime', name: '@northside-demo', amountCents: 5500, status: 'done', createdAt: ago(14), completedAt: ago(8), createdById: 'john', createdBy: 'John' },
    { id: 'chime-out-done-2', method: 'Chime', name: '@sample-shop', amountCents: 2500, status: 'done', createdAt: ago(7), completedAt: ago(3), createdById: 'alex', createdBy: 'Alex' },
    { id: 'chime-out-pending-1', method: 'Chime', name: '@demo-supplier', amountCents: 8000, status: 'pending', createdAt: ago(2), createdById: 'admin', createdBy: 'Owner' },
  ];
  const settlements = [{ id: 'SET-DEMO-PRIOR', method: 'Venmo', createdAt: ago(21), admin: 'Owner', previousCutoffPaymentId: null, newCutoffPaymentId: 'p4', newCutoffOrder: 2, incoming: [{ id: 'p4', name: 'David Wilson', amountCents: 12000, timestamp: ago(25), acceptedAt: ago(24) }], cashouts: [], incomingCents: 12000, outgoingCents: 0, netCents: 12000, remainingCents: 0 }];
  return { payments, cashouts, settlements, seq: 20 };
}

const paymentFromRow = r => ({
  id: r.id, method: r.method, name: r.name, amountCents: r.amount_cents, status: r.status,
  receivedAt: r.received_at, acceptedAt: r.accepted_at, acceptedById: r.accepted_by_id, acceptedBy: r.accepted_by, acceptOrder: r.accept_order,
  deletedAt: r.deleted_at, deletedById: r.deleted_by_id, deletedBy: r.deleted_by,
});
const cashoutFromRow = r => ({
  id: r.id, method: r.method, name: r.name, amountCents: r.amount_cents, status: r.status,
  createdAt: r.created_at, createdById: r.created_by_id, createdBy: r.created_by,
  completedAt: r.completed_at, completedById: r.completed_by_id, completedBy: r.completed_by,
  cancelledAt: r.cancelled_at, cancelledById: r.cancelled_by_id, cancelledBy: r.cancelled_by,
  settlementId: r.settlement_id, requestNo: r.request_no,
  deliveryStatus: r.delivery_status, deliveryAttempts: r.delivery_attempts, messageSyncAttempts: r.message_sync_attempts,
  telegramChatId: r.telegram_chat_id, telegramMessageId: r.telegram_message_id, callbackToken: r.callback_token,
  telegramDeleteStatus: r.telegram_delete_status, telegramDeleteAttempts: r.telegram_delete_attempts,
});

// Coarse removal status for the dashboard (no Telegram IDs or error text).
const PUBLIC_REMOVAL = { none: null, pending: 'pending', deleted: 'removed', already_absent: 'removed', failed: 'failed' };

// What the dashboard may see about Telegram delivery: a coarse status only,
// never chat IDs, message IDs or error text.
const PUBLIC_DELIVERY = { not_required: null, queued: 'pending', sending: 'pending', retrying: 'retrying', sent: 'delivered', failed: 'failed', skipped: null };

class DemoLedger {
  constructor(db, { mode = 'demo', paymentStartMs = null, paymentStartRaw = null } = {}) {
    this.db = db;
    this.mode = mode;
    // Each ledger file is stamped with its kind on first open; opening it in
    // the other mode is refused, so demo and real records can never mix.
    const kind = this.meta('ledger_kind') ?? (this.meta('seeded') ? 'demo' : null);
    if (kind && kind !== mode) throw new Error(`This ledger database is a ${kind} ledger; refusing to open it in ${mode} mode.`);
    if (!kind) this.setMeta('ledger_kind', mode);
    if (mode === 'demo' && !this.meta('seeded')) this.reset();
    // The activation boundary is written once and must match on every start.
    if (paymentStartMs != null) {
      const stored = this.meta('payment_start_at_ms');
      if (stored == null) {
        this.setMeta('payment_start_at_ms', paymentStartMs);
        this.setMeta('payment_start_at', paymentStartRaw ?? new Date(paymentStartMs).toISOString());
      } else if (Number(stored) !== paymentStartMs) {
        throw new Error(`PICASSO_PAYMENT_START_AT (${paymentStartRaw}) differs from the boundary persisted in this ledger (${this.meta('payment_start_at')}). Refusing to start; the boundary cannot be changed silently.`);
      }
    } else if (mode === 'production' || this.meta('payment_start_at_ms') != null) {
      if (this.meta('payment_start_at_ms') != null) throw new Error('This ledger has a persisted PICASSO_PAYMENT_START_AT; it must be configured.');
    }
  }

  meta(key) {
    return this.db.prepare('SELECT value FROM demo_meta WHERE key = ?').get(key)?.value;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO demo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  nextId(prefix) {
    const n = Number(this.meta('seq') || 0) + 1;
    this.setMeta('seq', n);
    return `${prefix}-${n}`;
  }

  reset() {
    if (this.mode !== 'demo') throw err(403, 'The production ledger can never be reset.');
    const seed = seedRecords();
    transaction(this.db, () => {
      this.db.exec('DELETE FROM demo_payments; DELETE FROM demo_cashouts; DELETE FROM demo_settlements;');
      const insP = this.db.prepare(`INSERT INTO demo_payments (id, method, name, amount_cents, status, received_at, accepted_at, accepted_by_id, accepted_by, accept_order)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      seed.payments.forEach(p => insP.run(p.id, p.method, p.name, p.amountCents, p.status, p.receivedAt, p.acceptedAt ?? null, p.acceptedById ?? null, p.acceptedBy ?? null, p.acceptOrder ?? null));
      const insO = this.db.prepare(`INSERT INTO demo_cashouts (id, method, name, amount_cents, status, created_at, created_by_id, created_by, completed_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      seed.cashouts.forEach(o => insO.run(o.id, o.method, o.name, o.amountCents, o.status, o.createdAt, o.createdById, o.createdBy, o.completedAt ?? null));
      seed.settlements.forEach(s => this.insertSettlement(s, null));
      this.setMeta('seq', seed.seq);
      this.setMeta('seeded', new Date().toISOString());
      this.setMeta('data_kind', 'DEMO - simulated transactions, not real financial records');
    });
  }

  insertSettlement(record, adminId) {
    this.db.prepare('INSERT INTO demo_settlements (id, method, created_at, admin_id, admin, record_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.method, record.createdAt, adminId, record.admin, JSON.stringify(record));
  }

  // The full in-memory shape settlement-core.js operates on.
  state() {
    return {
      payments: this.db.prepare('SELECT * FROM demo_payments').all().map(paymentFromRow),
      cashouts: this.db.prepare('SELECT * FROM demo_cashouts').all().map(cashoutFromRow),
      settlements: this.db.prepare('SELECT record_json FROM demo_settlements ORDER BY seq').all().map(r => JSON.parse(r.record_json)),
    };
  }

  // ---- views shared by staff and admin (no totals, no settlement records) --
  listPayments() {
    const s = this.state();
    return Core.sortPayments(s, s.payments.filter(p => p.status !== 'deleted')).map(p => ({
      id: p.id, method: p.method, name: p.name, amountCents: p.amountCents, status: p.status,
      receivedAt: p.receivedAt, acceptedAt: p.acceptedAt, acceptedById: p.acceptedById, acceptedBy: p.acceptedBy,
      settled: Core.isPaymentSettled(s, p),
    }));
  }

  listCashouts() {
    const s = this.state();
    return s.cashouts.map(o => ({
      id: o.id, method: o.method, name: o.name, amountCents: o.amountCents, status: o.status,
      createdAt: o.createdAt, createdById: o.createdById, createdBy: o.createdBy, completedAt: o.completedAt,
      cancelledAt: o.cancelledAt, cancelledBy: o.cancelledBy,
      telegramRemoval: PUBLIC_REMOVAL[o.telegramDeleteStatus] ?? null,
      completedBy: o.completedBy, requestId: o.requestNo ? requestId(o.requestNo) : null, deliveryStatus: PUBLIC_DELIVERY[o.deliveryStatus] ?? null,
      settled: o.status === 'done' && s.settlements.some(x => x.method === o.method && x.cashouts.some(t => t.id === o.id)),
    }));
  }

  acceptPayment(id, user) {
    const r = this.db.prepare(`UPDATE demo_payments SET status = 'accepted', accepted_at = ?, accepted_by_id = ?, accepted_by = ?,
                                 accept_order = (SELECT COALESCE(MAX(accept_order), 0) + 1 FROM demo_payments)
                               WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), user.id, user.username, id);
    if (!r.changes) throw err(409, 'This payment is no longer pending.');
  }

  // Persists the request first. When `deliver` is set it is also queued in the
  // Telegram outbox; delivery is tracked separately from financial status.
  createCashout({ method, name, amount }, user, { deliver = false } = {}) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    const amountCents = parseCents(amount);
    if (!Core.METHODS.includes(method)) throw err(400, 'Choose Venmo or Chime.');
    if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed) || amountCents === null) throw err(400, 'Enter a valid name and positive amount with no more than two decimals.');
    return transaction(this.db, () => {
      const id = this.nextId('out');
      const requestNo = Number(this.meta('cashout_no') || 0) + 1;
      this.setMeta('cashout_no', requestNo);
      this.db.prepare(`INSERT INTO demo_cashouts (id, method, name, amount_cents, status, created_at, created_by_id, created_by,
                         request_no, delivery_status, delivery_next_at, callback_token)
                       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, method, trimmed, amountCents, new Date().toISOString(), user.id, user.username, requestNo,
          deliver ? 'queued' : 'not_required', deliver ? Date.now() : null, deliver ? crypto.randomBytes(16).toString('hex') : null);
      return id;
    });
  }

  getCashout(id) {
    const r = this.db.prepare('SELECT * FROM demo_cashouts WHERE id = ?').get(id);
    return r && cashoutFromRow(r);
  }

  // Simulates the external cash-out service completing a request (demo only).
  completeCashout(id, user) {
    const r = this.db.prepare(`UPDATE demo_cashouts SET status = 'done', completed_at = ?, completed_by_id = ?, completed_by = ?
                               WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), user.id, user.username, id);
    if (!r.changes) throw err(409, 'This cash-out is no longer pending.');
  }

  // ---- admin only ----------------------------------------------------------
  // pending -> cancelled is a single conditional UPDATE, so it is mutually
  // exclusive with completion (pending -> done) no matter which arrives first.
  cancelCashout(id, user) {
    const r = this.db.prepare(`UPDATE demo_cashouts SET status = 'cancelled', cancelled_at = ?, cancelled_by_id = ?, cancelled_by = ?,
                                 delivery_status = CASE WHEN delivery_status IN ('queued', 'retrying', 'failed') THEN 'skipped' ELSE delivery_status END,
                                 telegram_delete_status = CASE WHEN telegram_message_id IS NOT NULL THEN 'pending' ELSE 'none' END,
                                 telegram_delete_attempts = 0, telegram_delete_next_at = ?
                               WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), user.id, user.username, Date.now(), id);
    if (!r.changes) throw err(409, 'Only pending cash-outs can be cancelled.');
  }

  // ---- Telegram ------------------------------------------------------------
  // Returns 'created' or 'duplicate'. The unique (chat, message) index makes
  // re-delivered Telegram updates harmless.
  createIncomingPayment({ method, name, amountCents, receivedAt, chatId, messageId, parserVersion, recipient = null }) {
    if (!Core.METHODS.includes(method)) throw new Error('Unknown method');
    return transaction(this.db, () => {
      if (this.sourceSeen(chatId, messageId)) return { outcome: 'duplicate' };
      const id = this.nextId('in');
      this.db.prepare(`INSERT INTO demo_payments (id, method, name, amount_cents, status, received_at, source, source_chat_id, source_message_id, parser_version, created_at, recipient_tag)
                       VALUES (?, ?, ?, ?, 'pending', ?, 'telegram', ?, ?, ?, ?, ?)`)
        .run(id, method, name, amountCents, receivedAt, String(chatId), messageId, parserVersion, new Date().toISOString(), recipient);
      return { outcome: 'created', id };
    });
  }

  // A Telegram message is recorded at most once, as a payment OR an attention event.
  sourceSeen(chatId, messageId) {
    return Boolean(this.db.prepare('SELECT 1 FROM demo_payments WHERE source_chat_id = ? AND source_message_id = ?').get(String(chatId), messageId)
      || this.db.prepare('SELECT 1 FROM attention_events WHERE source_chat_id = ? AND source_message_id = ?').get(String(chatId), messageId));
  }

  // ---- Admin Attention ---------------------------------------------------
  // Review items only. Nothing here is ever read by settlement-core totals, and
  // demo reset does not delete them.
  createAttentionEvent({ method, eventType, amountCents, reason, text, messageAt, chatId, messageId, parserVersion }) {
    if (!Core.METHODS.includes(method)) throw new Error('Unknown method');
    return transaction(this.db, () => {
      if (this.sourceSeen(chatId, messageId)) return { outcome: 'duplicate' };
      const id = this.nextId('att');
      this.db.prepare(`INSERT INTO attention_events (id, method, event_type, amount_cents, reason, original_text, message_at, source_chat_id, source_message_id, parser_version, status, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, method, eventType, amountCents ?? null, reason, String(text).slice(0, 2000), messageAt, String(chatId), messageId, parserVersion, new Date().toISOString());
      return { outcome: 'created', id };
    });
  }

  // Pending first (newest first), then ignored (newest first). Telegram chat
  // and message IDs are kept server-side only.
  listAttention() {
    const rows = this.db.prepare(`SELECT * FROM attention_events
                                  ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, message_at DESC, id DESC`).all();
    return {
      pendingCount: rows.filter(r => r.status === 'pending').length,
      events: rows.map(r => ({
        id: r.id, method: r.method, eventType: r.event_type, amountCents: r.amount_cents, reason: r.reason,
        originalText: r.original_text, messageAt: r.message_at, createdAt: r.created_at, parserVersion: r.parser_version,
        status: r.status, ignoredAt: r.ignored_at, ignoredById: r.ignored_by_id, ignoredBy: r.ignored_by,
      })),
    };
  }

  // Idempotent: the first ignore is recorded; repeats change nothing.
  ignoreAttention(id, user) {
    const r = this.db.prepare(`UPDATE attention_events SET status = 'ignored', ignored_at = ?, ignored_by_id = ?, ignored_by = ?
                               WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), user.id, user.username, id);
    if (r.changes) return { changed: true };
    if (!this.db.prepare('SELECT 1 FROM attention_events WHERE id = ?').get(id)) throw err(404, 'Attention event not found.');
    return { changed: false };
  }

  findCashoutByCallbackToken(token) {
    const r = typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) ? this.db.prepare('SELECT * FROM demo_cashouts WHERE callback_token = ?').get(token) : null;
    return r ? cashoutFromRow(r) : null;
  }

  // pending -> done, attributed to the Telegram user. Returns false if the
  // cash-out was no longer pending (already completed or cancelled).
  completeCashoutFromTelegram(id, { telegramUserId, displayName }) {
    const r = this.db.prepare(`UPDATE demo_cashouts SET status = 'done', completed_at = ?, completed_by_id = NULL, completed_by = ?,
                                 completed_via = 'telegram', completed_by_telegram_id = ?,
                                 message_sync_needed = 1, message_sync_attempts = 0, message_sync_next_at = ?
                               WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), displayName, String(telegramUserId), Date.now(), id);
    return r.changes === 1;
  }

  // Outbox: rows due for (re)delivery.
  dueDeliveries(now = Date.now()) {
    return this.db.prepare(`SELECT * FROM demo_cashouts WHERE status = 'pending' AND delivery_status IN ('queued', 'retrying')
                            AND delivery_next_at <= ? ORDER BY delivery_next_at LIMIT 20`).all(now).map(cashoutFromRow);
  }

  // Claims a row for sending; false if it was already claimed or changed.
  claimDelivery(id) {
    return this.db.prepare(`UPDATE demo_cashouts SET delivery_status = 'sending', delivery_attempts = delivery_attempts + 1
                            WHERE id = ? AND status = 'pending' AND delivery_status IN ('queued', 'retrying')`).run(id).changes === 1;
  }

  markDelivered(id, chatId, messageId) {
    // If the request changed while the send was in flight: completed -> the
    // message is re-rendered; cancelled -> the new message is queued for deletion.
    this.db.prepare(`UPDATE demo_cashouts SET delivery_status = 'sent', delivered_at = ?, telegram_chat_id = ?, telegram_message_id = ?,
                       delivery_last_error = NULL, message_sync_needed = CASE WHEN status = 'done' THEN 1 ELSE message_sync_needed END,
                       message_sync_next_at = ?,
                       telegram_delete_status = CASE WHEN status = 'cancelled' THEN 'pending' ELSE telegram_delete_status END,
                       telegram_delete_next_at = ?
                     WHERE id = ?`).run(new Date().toISOString(), String(chatId), messageId, Date.now(), Date.now(), id);
  }

  markDeliveryFailed(id, error, nextAt, final) {
    this.db.prepare(`UPDATE demo_cashouts SET delivery_status = CASE WHEN status = 'pending' THEN ? ELSE 'skipped' END,
                       delivery_last_error = ?, delivery_next_at = ? WHERE id = ?`).run(final ? 'failed' : 'retrying', String(error).slice(0, 200), nextAt, id);
  }

  retryDelivery(id) {
    const r = this.db.prepare(`UPDATE demo_cashouts SET delivery_status = 'retrying', delivery_attempts = 0, delivery_next_at = ?
                               WHERE id = ? AND status = 'pending' AND delivery_status = 'failed'`).run(Date.now(), id);
    if (!r.changes) throw err(409, 'Only pending cash-outs whose delivery failed can be retried.');
  }

  // A crash between "claim" and "record message ID" leaves rows in 'sending';
  // they are retried on startup. That may duplicate the Telegram message, never
  // the financial request (the orphan's button is rejected by message-ID check).
  recoverInterruptedDeliveries() {
    this.db.prepare(`UPDATE demo_cashouts SET delivery_status = 'retrying', delivery_next_at = ? WHERE delivery_status = 'sending'`).run(Date.now());
  }

  // ---- Telegram message removal for cancelled requests ----------------------
  dueDeletions(now = Date.now()) {
    return this.db.prepare(`SELECT * FROM demo_cashouts WHERE status = 'cancelled' AND telegram_delete_status = 'pending'
                            AND telegram_message_id IS NOT NULL AND telegram_delete_next_at <= ? LIMIT 20`).all(now).map(cashoutFromRow);
  }

  // outcome: 'deleted' (Telegram confirmed) or 'already_absent' (Telegram
  // reported the message no longer exists). Nothing else counts as removed.
  markTelegramDeleted(id, outcome) {
    this.db.prepare(`UPDATE demo_cashouts SET telegram_delete_status = ?, telegram_deleted_at = ?, telegram_delete_error = NULL
                     WHERE id = ? AND telegram_delete_status = 'pending'`).run(outcome, new Date().toISOString(), id);
  }

  markTelegramDeleteFailed(id, error, nextAt, final) {
    this.db.prepare(`UPDATE demo_cashouts SET telegram_delete_attempts = telegram_delete_attempts + 1, telegram_delete_next_at = ?,
                       telegram_delete_error = ?, telegram_delete_status = CASE WHEN ? THEN 'failed' ELSE telegram_delete_status END
                     WHERE id = ? AND telegram_delete_status = 'pending'`).run(nextAt, String(error).slice(0, 200), final ? 1 : 0, id);
  }

  retryTelegramDelete(id) {
    const r = this.db.prepare(`UPDATE demo_cashouts SET telegram_delete_status = 'pending', telegram_delete_attempts = 0, telegram_delete_next_at = ?
                               WHERE id = ? AND status = 'cancelled' AND telegram_delete_status = 'failed'`).run(Date.now(), id);
    if (!r.changes) throw err(409, 'Only cancelled requests whose Telegram removal failed can be retried.');
  }

  dueMessageSyncs(now = Date.now()) {
    return this.db.prepare(`SELECT * FROM demo_cashouts WHERE message_sync_needed = 1 AND telegram_message_id IS NOT NULL
                            AND message_sync_next_at <= ? LIMIT 20`).all(now).map(cashoutFromRow);
  }

  markMessageSynced(id, status) {
    // Only clear the flag if the status has not changed again since the edit.
    this.db.prepare('UPDATE demo_cashouts SET message_sync_needed = 0 WHERE id = ? AND status = ?').run(id, status);
  }

  markMessageSyncFailed(id, nextAt, final) {
    this.db.prepare(`UPDATE demo_cashouts SET message_sync_attempts = message_sync_attempts + 1, message_sync_next_at = ?,
                       message_sync_needed = CASE WHEN ? THEN 0 ELSE message_sync_needed END WHERE id = ?`).run(nextAt, final ? 1 : 0, id);
  }

  logTelegramEvent({ updateId = null, kind, outcome, chatId = null, messageId = null, telegramUserId = null, refId = null, detail = null }) {
    this.db.prepare(`INSERT INTO telegram_events (at, update_id, kind, outcome, chat_id, message_id, telegram_user_id, ref_id, detail)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), updateId, kind, outcome,
      chatId === null ? null : String(chatId), messageId, telegramUserId === null ? null : String(telegramUserId), refId, detail);
  }

  telegramMeta(key) {
    return this.db.prepare('SELECT value FROM telegram_meta WHERE key = ?').get(key)?.value;
  }

  setTelegramMeta(key, value) {
    this.db.prepare('INSERT INTO telegram_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  deletePayment(id, user) {
    const r = this.db.prepare(`UPDATE demo_payments SET status = 'deleted', deleted_at = ?, deleted_by_id = ?, deleted_by = ?
                               WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), user.id, user.username, id);
    if (!r.changes) throw err(409, 'Only pending payments can be deleted.');
  }

  restorePayment(id, user) {
    const r = this.db.prepare(`UPDATE demo_payments SET status = 'pending', restored_at = ?, restored_by_id = ?, restored_by = ?
                               WHERE id = ? AND status = 'deleted'`).run(new Date().toISOString(), user.id, user.username, id);
    if (!r.changes) throw err(409, 'This payment is not in the trash.');
  }

  listTrash() {
    return this.state().payments.filter(p => p.status === 'deleted').map(p => ({
      id: p.id, method: p.method, name: p.name, amountCents: p.amountCents, receivedAt: p.receivedAt,
      deletedAt: p.deletedAt, deletedById: p.deletedById, deletedBy: p.deletedBy,
    }));
  }

  calculations() {
    const s = this.state();
    return Object.fromEntries(Core.METHODS.map(m => [m, Core.totals(s, m)]));
  }

  listSettlements() {
    const s = this.state();
    return s.settlements.map(r => {
      const number = Core.settlementNumber(s, r);
      return { ...r, number, color: Core.settlementColor(number) };
    });
  }

  previewSettlement(paymentId) {
    const p = Core.previewSettlement(this.state(), paymentId);
    if (!p.selected) throw err(409, p.error);
    return {
      ok: p.ok, error: p.error, method: p.method, selected: { id: p.selected.id, name: p.selected.name },
      incomingCents: p.incomingCents, outgoingCents: p.outgoingCents, netCents: p.netCents, remainingCents: p.remainingCents,
    };
  }

  // Recomputes the settlement from current server state; nothing from the
  // client's preview is trusted.
  commitSettlement(paymentId, user) {
    return transaction(this.db, () => {
      const s = this.state();
      const preview = Core.previewSettlement(s, paymentId);
      if (!preview.ok) throw err(409, preview.error);
      const result = Core.commitSettlement(s, paymentId, user.username, new Date().toISOString(), this.nextId('SET'));
      const record = { ...result.record, adminId: user.id };
      this.insertSettlement(record, user.id);
      const link = this.db.prepare('UPDATE demo_cashouts SET settlement_id = ? WHERE id = ?');
      record.cashouts.forEach(o => link.run(record.id, o.id));
      return record;
    });
  }
}

function parseCents(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [a, b = ''] = value.trim().split('.');
  const n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

module.exports = { DemoLedger, parseCents };
