'use strict';
// Reconciliation of existing Admin Attention events (e.g. Venmo notifications
// received before venmo-v1 existed) into PENDING payments.
//
// Evidence model: an attention event stores the original text, chat, message
// ID and time, but NOT the sender. Sender evidence therefore comes only from a
// trusted listener export of the same messages. A message is converted only if:
//   * it is inside the operator-given chat and message-ID range,
//   * the chat is the configured incoming group for the event's method,
//   * the event is still pending (not ignored or already resolved),
//   * no payment exists yet for the same Telegram message,
//   * the export contains the message, unedited, with IDENTICAL text,
//   * the export's sender is a configured payment sender (Larry's bot), and
//   * the live decision function, with the requested parser, yields a payment.
// Everything else is reported with the reason and left untouched.
const crypto = require('node:crypto');
const { decideMessage } = require('./incoming');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function parseRange(spec) {
  const m = /^(\d{1,12})(?:-(\d{1,12}))?$/.exec(String(spec || ''));
  if (!m) throw new Error('--ids must be N or N-M');
  const from = Number(m[1]), to = Number(m[2] ?? m[1]);
  if (to < from || to - from > 10_000) throw new Error('--ids range is invalid or too large');
  return { from, to };
}

function planReconciliation(ledger, cfg, { chatId, range, exportMessages, parser }) {
  const chat = String(chatId);
  const method = cfg.incomingMethodByChat.get(chat);
  if (!method) throw new Error(`Chat ${chat} is not a configured incoming group.`);
  const decisionCfg = { ...cfg, venmoParser: parser };
  const byKey = new Map();
  const duplicateInExport = new Set();
  for (const m of exportMessages) {
    if (String(m.chatId) !== chat || !Number.isInteger(m.messageId)) continue;
    if (byKey.has(m.messageId)) duplicateInExport.add(m.messageId);
    byKey.set(m.messageId, m);
  }
  const events = ledger.db.prepare(`SELECT * FROM attention_events WHERE source_chat_id = ? AND source_message_id BETWEEN ? AND ?
                                    ORDER BY source_message_id`).all(chat, range.from, range.to);
  const rows = events.map(ev => {
    const row = {
      eventId: ev.id, chatId: chat, messageId: ev.source_message_id, messageAt: ev.message_at, method: ev.method,
      eventReason: ev.reason, eventStatus: ev.status, storedTextSha256: sha256(ev.original_text),
      senderId: null, senderVerified: false, exportTextMatches: null, amountCents: null, parserVersion: null, action: null,
    };
    const ex = byKey.get(ev.source_message_id);
    if (ex) {
      row.senderId = ex.senderId == null ? null : String(ex.senderId);
      row.senderVerified = Boolean(row.senderId && cfg.sourceSenderIds?.has(row.senderId));
      row.exportTextMatches = typeof ex.text === 'string' && ex.text === ev.original_text;
    }
    const keep = reason => { row.action = `keep:${reason}`; return row; };
    if (ev.method !== method) return keep('wrong_group');
    if (ev.resolution) return keep('already_resolved');
    if (ev.status !== 'pending') return keep('not_pending');
    if (ledger.db.prepare('SELECT 1 FROM demo_payments WHERE source_chat_id = ? AND source_message_id = ?').get(chat, ev.source_message_id)) return keep('payment_exists');
    if (!ex) return keep('no_sender_evidence');
    if (duplicateInExport.has(ev.source_message_id)) return keep('ambiguous_export');
    if (ex.edited) return keep('edited');
    if (!row.exportTextMatches) return keep('text_mismatch');
    if (!row.senderVerified) return keep('sender_not_verified');
    // The original Telegram date comes from the stored event, which the
    // export's date must agree with.
    const evDate = Math.floor(Date.parse(ev.message_at) / 1000);
    if (ex.date !== evDate) return keep('date_mismatch');
    const d = decideMessage(decisionCfg, {
      message_id: ev.source_message_id, date: evDate, text: ev.original_text, edited: false,
      chat: { id: Number(chat) }, from: { id: row.senderId },
    });
    if (d.decision === 'ignore') return keep(d.outcome);
    if (d.decision === 'cashout_request') return keep('cashout_request');
    if (d.decision !== 'payment') return keep(`not_parsed(${d.parsed.reason})`);
    row.amountCents = d.parsed.amountCents;
    row.parserVersion = d.parsed.parserVersion;
    row.action = 'convert';
    row.parsed = { name: d.parsed.name, amountCents: d.parsed.amountCents, recipient: d.parsed.recipient ?? null, parserVersion: d.parsed.parserVersion };
    return row;
  });
  const inRangeEventIds = new Set(events.map(e => e.source_message_id));
  const exportOnly = [...byKey.keys()].filter(id => id >= range.from && id <= range.to && !inRangeEventIds.has(id)).sort((a, b) => a - b);
  const summary = { events: rows.length, convert: 0, convertTotalCents: 0, keep: {} };
  for (const r of rows) {
    if (r.action === 'convert') { summary.convert++; summary.convertTotalCents += r.amountCents; }
    else summary.keep[r.action] = (summary.keep[r.action] || 0) + 1;
  }
  // The approval token covers every decision, amount and identity, the
  // parser and the trusted senders: any change requires a new dry run.
  const token = sha256(JSON.stringify({
    chat, range, parser, senders: [...(cfg.sourceSenderIds || [])].sort(), boundary: cfg.paymentStartMs ?? null,
    rows: rows.map(r => [r.eventId, r.messageId, r.action, r.amountCents, r.senderId, r.storedTextSha256]),
  }));
  return { rows, summary, exportOnly, token };
}

function applyReconciliation(ledger, plan, { approval, admin }) {
  if (approval !== plan.token) throw new Error('Approval token does not match the current dry run. Run the dry run again and review it.');
  if (!admin?.id || !admin?.username) throw new Error('An admin account is required to apply reconciliation.');
  const outcomes = {};
  for (const r of plan.rows.filter(x => x.action === 'convert')) {
    const res = ledger.reconcileAttentionToPayment({ eventId: r.eventId, chatId: r.chatId, messageId: r.messageId, parsed: r.parsed, admin });
    outcomes[res.outcome] = (outcomes[res.outcome] || 0) + 1;
  }
  return outcomes;
}

module.exports = { planReconciliation, applyReconciliation, parseRange };
