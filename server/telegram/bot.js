'use strict';
// Telegram bridge: reads incoming payment messages, delivers cash-out
// requests, and handles the "Completed" button. Exactly one update source runs:
// long polling OR the webhook route, chosen by PICASSO_TELEGRAM_MODE.

const { decideMessage } = require('./incoming');
const { cashoutText, completedKeyboard, NO_KEYBOARD } = require('./messages');

const OUTBOX_INTERVAL_MS = 3_000;
const HISTORY_GRACE_MS = 60_000;
const backoff = attempt => Math.min(2 ** attempt * 2_000, 5 * 60_000);

class TelegramBot {
  constructor({ config, ledger, events, api, log = console }) {
    this.cfg = config;
    this.ledger = ledger;
    this.events = events;
    this.api = api;
    this.log = log;
    this.botId = null;
    this.running = false;
    this.outboxBusy = null;
    this.outboxRerun = false;
  }

  // ---- lifecycle -------------------------------------------------------
  async init() {
    const me = await this.api.call('getMe');
    this.botId = String(me.id);
    this.startedAt = Date.now();
    this.ledger.recoverInterruptedDeliveries();
  }

  async start() {
    await this.init();
    if (this.cfg.mode === 'polling') {
      // Never run polling while a webhook is registered (Telegram also forbids it).
      const info = await this.api.call('getWebhookInfo');
      if (info.url) throw new Error('A webhook is registered for this bot; refusing to start long polling. Remove it deliberately (deleteWebhook) or use webhook mode.');
    }
    this.running = true;
    this.outboxTimer = setInterval(() => this.processOutbox(), OUTBOX_INTERVAL_MS);
    this.outboxTimer.unref();
    if (this.cfg.mode === 'polling') this.pollLoop();
    this.log.log(`Telegram bridge started (${this.cfg.mode}).`);
  }

  stop() {
    this.running = false;
    clearInterval(this.outboxTimer);
    this.pollAbort?.abort();
  }

  async pollLoop() {
    while (this.running) {
      try {
        const offset = Number(this.ledger.telegramMeta('update_offset') || 0);
        const updates = await this.api.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message', 'callback_query'] });
        for (const u of updates) {
          await this.handleUpdate(u);
          this.ledger.setTelegramMeta('update_offset', u.update_id + 1);
        }
      } catch (e) {
        if (!this.running) return;
        this.log.error(`Telegram polling error: ${e.message}`);
        await new Promise(r => setTimeout(r, e.retryAfter ? e.retryAfter * 1000 : 5_000));
      }
    }
  }

  // ---- update dispatch ---------------------------------------------------
  async handleUpdate(update) {
    const updateId = Number.isInteger(update?.update_id) ? update.update_id : null;
    try {
      if (update.message) return this.handleMessage(updateId, update.message);
      if (update.callback_query) return await this.handleCallback(updateId, update.callback_query);
      if (update.edited_message) {
        // Edits never change an already-recorded payment.
        const m = update.edited_message;
        return this.ledger.logTelegramEvent({ updateId, kind: 'edited_message', outcome: 'ignored_edit', chatId: m.chat?.id ?? null, messageId: m.message_id ?? null });
      }
      this.ledger.logTelegramEvent({ updateId, kind: 'other', outcome: 'ignored_update_type' });
    } catch (e) {
      this.log.error(`Telegram update ${updateId} failed: ${e.message}`);
      this.ledger.logTelegramEvent({ updateId, kind: 'error', outcome: 'handler_error', detail: e.message.slice(0, 200) });
    }
  }

  // options:
  //   backfill: an owner-approved historical import (server/backfill.js)
  //   listener: from the user-account listener, whose own catch-up window and
  //             the ingest endpoint's age limit replace the startup check below
  handleMessage(updateId, msg, { backfill = false, listener = false } = {}) {
    const chatId = String(msg.chat?.id ?? '');
    const base = { updateId, kind: 'message', chatId, messageId: msg.message_id ?? null };
    const d = decideMessage({ ...this.cfg, ownBotId: this.botId }, msg);
    if (d.decision === 'ignore') return this.ledger.logTelegramEvent({ ...base, outcome: d.outcome });
    const method = d.method;

    // Bot API path: never process a backlog Telegram queued while we were
    // offline (anything sent before the bridge started) unless approved.
    if (!backfill && !listener && this.startedAt && msg.date * 1000 < this.startedAt - HISTORY_GRACE_MS) {
      return this.ledger.logTelegramEvent({ ...base, outcome: 'ignored_historical' });
    }

    const parsed = d.parsed;
    if (d.decision === 'attention') {
      const r = this.ledger.createAttentionEvent({
        method, eventType: parsed.eventType, amountCents: parsed.amountCents, reason: parsed.reason, text: msg.text,
        messageAt: new Date(msg.date * 1000).toISOString(), chatId, messageId: msg.message_id, parserVersion: parsed.parserVersion,
      });
      this.ledger.logTelegramEvent({ ...base, outcome: r.outcome === 'created' ? 'attention_created' : 'duplicate_message', refId: r.id ?? null, detail: `${parsed.eventType} ${parsed.reason}` });
      if (r.outcome === 'created') this.events.publish(['attention']);
      return r;
    }
    if (d.decision === 'cashout_request') {
      // Shared group: cash-out requests are created only from the dashboard and
      // are never turned into payments or attention events from chat text.
      return this.ledger.logTelegramEvent({ ...base, outcome: 'ignored_cashout_request', detail: `method=${method}` });
    }
    if (d.decision !== 'payment') {
      // Reason and length only; ordinary chat text is not stored.
      return this.ledger.logTelegramEvent({ ...base, outcome: `rejected_${parsed.reason}`, detail: `method=${method} len=${String(msg.text ?? '').length}` });
    }
    const r = this.ledger.createIncomingPayment({
      method, name: parsed.name, amountCents: parsed.amountCents,
      receivedAt: new Date(msg.date * 1000).toISOString(),
      chatId, messageId: msg.message_id, parserVersion: parsed.parserVersion, recipient: parsed.recipient ?? null,
    });
    this.ledger.logTelegramEvent({ ...base, outcome: r.outcome === 'created' ? 'payment_created' : 'duplicate_message', refId: r.id ?? null, detail: `parser=${parsed.parserVersion}` });
    if (r.outcome === 'created') this.events.publish(['payments']);
    return r;
  }

  async handleCallback(updateId, cq) {
    const chatId = String(cq.message?.chat?.id ?? '');
    const messageId = cq.message?.message_id ?? null;
    const telegramUserId = String(cq.from?.id ?? '');
    const base = { updateId, kind: 'callback', chatId, messageId, telegramUserId };
    const answer = text => this.api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }).catch(() => {});

    const data = typeof cq.data === 'string' ? cq.data : '';
    const cashout = data.startsWith('c:') ? this.ledger.findCashoutByCallbackToken(data.slice(2)) : null;
    if (!cashout) {
      this.ledger.logTelegramEvent({ ...base, outcome: 'rejected_unknown_request' });
      return answer('Unknown request.');
    }
    // The button must be on the exact message our bot sent to the correct
    // method's cash-out group, per the server-side mapping.
    const expectedChat = this.cfg.cashoutChatByMethod[cashout.method];
    if (chatId !== expectedChat || chatId !== cashout.telegramChatId || messageId !== cashout.telegramMessageId
        || (cq.message?.from && String(cq.message.from.id) !== this.botId)) {
      this.ledger.logTelegramEvent({ ...base, outcome: 'rejected_message_mismatch', refId: cashout.id });
      return answer('This button does not match its request.');
    }
    // Bots can never complete. Humans must still belong to this exact group at
    // click time; membership lookup failure is denied rather than guessed.
    if (!telegramUserId || cq.from?.is_bot) {
      this.ledger.logTelegramEvent({ ...base, outcome: 'rejected_unauthorized_user', refId: cashout.id });
      return answer('You are not authorized to complete cash-outs.');
    }
    let member;
    try {
      member = await this.api.call('getChatMember', { chat_id: expectedChat, user_id: telegramUserId });
    } catch (e) {
      this.ledger.logTelegramEvent({ ...base, outcome: 'rejected_membership_unverified', refId: cashout.id, detail: e.message.slice(0, 200) });
      return answer('Could not verify group membership. Try again.');
    }
    const activeMember = ['creator', 'administrator', 'member'].includes(member?.status)
      || (member?.status === 'restricted' && member.is_member === true);
    if (!activeMember || member?.user?.is_bot || String(member?.user?.id ?? '') !== telegramUserId) {
      this.ledger.logTelegramEvent({ ...base, outcome: 'rejected_unauthorized_user', refId: cashout.id });
      return answer('You are not authorized to complete cash-outs.');
    }
    const displayName = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ').trim().slice(0, 64) || (cq.from.username ? `@${cq.from.username}` : `Telegram user`);
    const completed = this.ledger.completeCashoutFromTelegram(cashout.id, { telegramUserId, displayName });
    if (!completed) {
      const current = this.ledger.getCashout(cashout.id);
      this.ledger.logTelegramEvent({ ...base, outcome: current.status === 'done' ? 'duplicate_completion' : 'rejected_cancelled', refId: cashout.id });
      // Completed: make sure the message is re-rendered. Cancelled: removal was
      // already queued by the cancellation itself.
      if (current.status === 'done') this.ledger.db.prepare('UPDATE demo_cashouts SET message_sync_needed = 1, message_sync_next_at = ? WHERE id = ? AND telegram_message_id IS NOT NULL').run(Date.now(), cashout.id);
      this.kick();
      return answer(current.status === 'done' ? 'Already completed.' : 'This request was cancelled.');
    }
    this.ledger.logTelegramEvent({ ...base, outcome: 'cashout_completed', refId: cashout.id });
    this.events.publish(['cashouts']);
    await answer('Marked completed.');
    this.kick();
    return { completed: true };
  }

  // ---- outbox: deliveries and message edits --------------------------------
  kick() {
    if (this.running) setImmediate(() => this.processOutbox());
  }

  processOutbox() {
    // Serialised so one row is never sent twice concurrently.
    if (this.outboxBusy) {
      this.outboxRerun = true;
      return this.outboxBusy;
    }
    this.outboxBusy = (async () => {
      do {
        this.outboxRerun = false;
        await this.runOutbox();
      } while (this.outboxRerun);
    })().finally(() => { this.outboxBusy = null; });
    return this.outboxBusy;
  }

  async runOutbox() {
    for (const o of this.ledger.dueDeliveries()) await this.deliver(o);
    for (const o of this.ledger.dueDeletions()) await this.deleteCancelled(o);
    for (const o of this.ledger.dueMessageSyncs()) await this.syncMessage(o);
  }

  // Removes a cancelled request's message from its group. Only a confirmed
  // delete, or Telegram reporting the message is already gone, counts as
  // removed. Temporary failures retry with backoff. A permanent refusal (for
  // example, older than Telegram allows bots to delete) is marked failed for
  // the admin to see and retry, and the message is edited to CANCELLED with no
  // button so nobody acts on it. Money is never touched here.
  async deleteCancelled(o) {
    const where = { chatId: o.telegramChatId, messageId: o.telegramMessageId, refId: o.id };
    try {
      await this.api.call('deleteMessage', { chat_id: o.telegramChatId, message_id: o.telegramMessageId });
      this.ledger.markTelegramDeleted(o.id, 'deleted');
      this.ledger.logTelegramEvent({ kind: 'message_delete', outcome: 'cashout_message_deleted', ...where });
    } catch (e) {
      if (/message to delete not found/i.test(e.description || '')) {
        this.ledger.markTelegramDeleted(o.id, 'already_absent');
        this.ledger.logTelegramEvent({ kind: 'message_delete', outcome: 'cashout_message_already_absent', ...where });
      } else {
        const permanent = (e.status === 400 || e.status === 403) && !e.retryAfter;
        const attempts = o.telegramDeleteAttempts + 1;
        const final = permanent || attempts >= this.cfg.maxDeliveryAttempts;
        this.ledger.markTelegramDeleteFailed(o.id, e.message, Date.now() + (e.retryAfter ? e.retryAfter * 1000 : backoff(attempts)), final);
        this.ledger.logTelegramEvent({ kind: 'message_delete', outcome: final ? 'cashout_message_delete_failed' : 'cashout_message_delete_retry', ...where, detail: e.message.slice(0, 200) });
        if (final) this.ledger.db.prepare('UPDATE demo_cashouts SET message_sync_needed = 1, message_sync_attempts = 0, message_sync_next_at = ? WHERE id = ?').run(Date.now(), o.id);
      }
    }
    this.events.publish(['cashouts']);
  }

  async deliver(o) {
    const chatId = this.cfg.cashoutChatByMethod[o.method];
    if (!chatId) throw new Error(`No cash-out chat for ${o.method}`);
    if (!this.ledger.claimDelivery(o.id)) return;
    try {
      const sent = await this.api.call('sendMessage', { chat_id: chatId, text: cashoutText(o), reply_markup: completedKeyboard(o.callbackToken) });
      this.ledger.markDelivered(o.id, chatId, sent.message_id);
      this.ledger.logTelegramEvent({ kind: 'delivery', outcome: 'cashout_delivered', chatId, messageId: sent.message_id, refId: o.id });
    } catch (e) {
      const attempts = o.deliveryAttempts + 1;
      const final = attempts >= this.cfg.maxDeliveryAttempts;
      const wait = e.retryAfter ? e.retryAfter * 1000 : backoff(attempts);
      this.ledger.markDeliveryFailed(o.id, e.message, Date.now() + wait, final);
      this.ledger.logTelegramEvent({ kind: 'delivery', outcome: final ? 'cashout_delivery_failed' : 'cashout_delivery_retry', chatId, refId: o.id, detail: e.message.slice(0, 200) });
    }
    this.events.publish(['cashouts']);
  }

  async syncMessage(o) {
    try {
      await this.api.call('editMessageText', { chat_id: o.telegramChatId, message_id: o.telegramMessageId, text: cashoutText(o), reply_markup: NO_KEYBOARD });
      this.ledger.markMessageSynced(o.id, o.status);
    } catch (e) {
      if (/message is not modified/i.test(e.description || '')) return this.ledger.markMessageSynced(o.id, o.status);
      // A failed edit never touches the financial status; it is just retried.
      const final = o.messageSyncAttempts + 1 >= this.cfg.maxSyncAttempts;
      this.ledger.markMessageSyncFailed(o.id, Date.now() + (e.retryAfter ? e.retryAfter * 1000 : backoff(o.messageSyncAttempts + 1)), final);
      this.ledger.logTelegramEvent({ kind: 'message_edit', outcome: final ? 'edit_gave_up' : 'edit_retry', chatId: o.telegramChatId, messageId: o.telegramMessageId, refId: o.id, detail: e.message.slice(0, 200) });
    }
  }
}

module.exports = { TelegramBot };
