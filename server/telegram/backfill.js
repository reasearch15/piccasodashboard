'use strict';
// Backfill of messages exported from the Picasso listener (JSON Lines, one
// {chatId, messageId, date, text, edited?} per line).
//
//   preview (default): read-only. Reports what each message WOULD become:
//                      counts only, nothing is written.
//   apply:             needs the owner's explicit approval. It goes through the
//                      exact same path as live messages: cutoff, classify, dedupe.
//
// Edited messages are always excluded, and so is anything before the boundary.
const { classifyMessage } = require('./parser');

function previewBackfill(ledger, cfg, messages) {
  const counts = { total: 0, payment: 0, attention: 0, no_record: 0, before_cutoff: 0, edited: 0, duplicate: 0, other_chat: 0, invalid: 0 };
  const byMethod = { Chime: { payment: 0, attention: 0, amountCents: 0 }, Venmo: { payment: 0, attention: 0, amountCents: 0 } };
  const rejectedReasons = {};
  for (const m of messages) {
    counts.total++;
    if (!/^-?\d{1,20}$/.test(String(m.chatId)) || !Number.isInteger(m.messageId) || !Number.isInteger(m.date)) { counts.invalid++; continue; }
    const method = cfg.incomingMethodByChat.get(String(m.chatId));
    if (!method) { counts.other_chat++; continue; }
    if (m.edited) { counts.edited++; continue; }
    if (cfg.paymentStartMs != null && m.date * 1000 < cfg.paymentStartMs) { counts.before_cutoff++; continue; }
    if (ledger.sourceSeen(m.chatId, m.messageId)) { counts.duplicate++; continue; }
    const c = classifyMessage(m.text, method, { venmoParser: cfg.venmoParser });
    if (c.kind === 'payment') { counts.payment++; byMethod[method].payment++; byMethod[method].amountCents += c.amountCents; }
    else if (c.kind === 'attention') { counts.attention++; byMethod[method].attention++; }
    else { counts.no_record++; rejectedReasons[c.reason] = (rejectedReasons[c.reason] || 0) + 1; }
  }
  return { counts, byMethod, rejectedReasons, boundary: cfg.paymentStartMs == null ? null : new Date(cfg.paymentStartMs).toISOString() };
}

function applyBackfill(bot, messages, { approvedBy }) {
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) throw new Error('Backfill apply requires the approving owner name.');
  const outcomes = {};
  for (const m of messages) {
    if (m.edited) { outcomes.edited = (outcomes.edited || 0) + 1; continue; }
    const r = bot.handleMessage(null, { message_id: m.messageId, date: m.date, text: m.text, chat: { id: Number(m.chatId) }, from: { id: m.senderId ?? null } }, { backfill: true });
    const k = r?.outcome ?? 'skipped_or_logged';
    outcomes[k] = (outcomes[k] || 0) + 1;
  }
  bot.ledger.logTelegramEvent({ kind: 'backfill', outcome: 'backfill_applied', detail: `approved_by=${approvedBy.slice(0, 60)} ${JSON.stringify(outcomes)}`.slice(0, 500) });
  return outcomes;
}

module.exports = { previewBackfill, applyBackfill };
