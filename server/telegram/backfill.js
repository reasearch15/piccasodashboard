'use strict';
// Historical import of messages exported by the Picasso listener
// (listener/ `export-history`, JSON Lines: one {chatId, messageId, date, text,
// senderId, edited} per line, plus one {"_meta": {...}} line).
//
//   preview: read-only. Classifies every message with the SAME decision
//            function as live ingestion, writes an audit file and prints an
//            approval token. Nothing is written to the ledger.
//   apply:   requires that approval token (bound to the exact export file and
//            the decision configuration) and a named approver. Idempotent:
//            (chat ID, message ID) de-duplication makes re-runs and resumes
//            after an interruption safe, and live ingestion can run alongside.
const crypto = require('node:crypto');
const { decideMessage } = require('./incoming');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const iso = s => new Date(s * 1000).toISOString();

function parseExport(text) {
  const messages = [];
  let meta = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let v;
    try { v = JSON.parse(line); } catch { throw new Error(`Export line ${i + 1} is not valid JSON.`); }
    if (v && v._meta) meta = v._meta; else messages.push(v);
  });
  return { meta, messages };
}

// Everything that changes decisions is part of the approval token.
function decisionFingerprint(cfg) {
  return JSON.stringify({
    boundaryMs: cfg.paymentStartMs ?? null,
    chats: [...cfg.incomingMethodByChat.entries()].sort(),
    senders: [...(cfg.sourceSenderIds || [])].sort(),
    ownBot: cfg.ownBotId ? String(cfg.ownBotId) : null,
    venmoParser: cfg.venmoParser,
  });
}
const approvalToken = (exportText, cfg) => sha256(sha256(exportText) + '\n' + decisionFingerprint(cfg));

const toMsg = m => ({ message_id: m.messageId, date: m.date, text: m.text, edited: Boolean(m.edited), chat: { id: Number(m.chatId) }, from: { id: m.senderId ?? null } });
const validShape = m => m && /^-?\d{1,20}$/.test(String(m.chatId)) && Number.isInteger(m.messageId) && m.messageId > 0 && Number.isInteger(m.date)
  && (m.text == null || typeof m.text === 'string');

const ATTENTION_BUCKET = { recognized_adjustment: 'adjustment', unverified_payment_source: 'unverified_source', venmo_format_unverified: 'venmo_review' };
const IGNORE_BUCKET = {
  ignored_unconfigured_chat: 'other_chat', ignored_not_incoming_group: 'other_chat', ignored_own_message: 'staffhelp_bot',
  rejected_malformed_update: 'invalid', ignored_edit: 'edited', ignored_before_cutoff: 'before_cutoff',
};

function previewBackfill(ledger, cfg, messages, { meta = null } = {}) {
  const buckets = ['payment_candidate', 'venmo_review', 'adjustment', 'unverified_source', 'ambiguous', 'cashout_excluded', 'no_record',
    'duplicate', 'duplicate_in_export', 'before_cutoff', 'edited', 'staffhelp_bot', 'other_chat', 'invalid'];
  const counts = Object.fromEntries([['inspected', 0], ...buckets.map(b => [b, 0])]);
  const byMethod = {};
  const ensure = m => (byMethod[m] ??= { payment_candidates: 0, totalCents: 0, earliest: null, latest: null, attention_events: 0 });
  const rejectedReasons = {};
  const decisions = [];
  const seen = new Set();
  for (const m of messages) {
    counts.inspected++;
    const row = { chatId: String(m?.chatId ?? ''), messageId: m?.messageId ?? null, date: Number.isInteger(m?.date) ? iso(m.date) : null, senderId: m?.senderId == null ? null : String(m.senderId) };
    let bucket, extra = {};
    if (!validShape(m)) bucket = 'invalid';
    else {
      const d = decideMessage(cfg, toMsg(m));
      row.method = d.method ?? null;
      const key = `${row.chatId}:${m.messageId}`;
      if (d.decision === 'ignore') bucket = IGNORE_BUCKET[d.outcome] || 'invalid';
      else if (seen.has(key)) bucket = 'duplicate_in_export';
      else if (ledger.sourceSeen(m.chatId, m.messageId)) bucket = 'duplicate';
      else if (d.decision === 'payment') {
        bucket = 'payment_candidate';
        extra = { amountCents: d.parsed.amountCents, parserVersion: d.parsed.parserVersion };
        const s = ensure(d.method);
        s.payment_candidates++;
        s.totalCents += d.parsed.amountCents;
        s.earliest = s.earliest && s.earliest < row.date ? s.earliest : row.date;
        s.latest = s.latest && s.latest > row.date ? s.latest : row.date;
      } else if (d.decision === 'attention') {
        bucket = ATTENTION_BUCKET[d.parsed.reason] || 'ambiguous';
        extra = { reason: d.parsed.reason, parserVersion: d.parsed.parserVersion, ...(d.parsed.amountCents != null ? { adjustmentCents: d.parsed.amountCents } : {}) };
        ensure(d.method).attention_events++;
      } else if (d.decision === 'cashout_request') bucket = 'cashout_excluded';
      else {
        bucket = 'no_record';
        extra = { reason: d.parsed.reason };
        rejectedReasons[d.parsed.reason] = (rejectedReasons[d.parsed.reason] || 0) + 1;
      }
      if (validShape(m)) seen.add(key);
    }
    counts[bucket]++;
    // No sender names or message text: hash only, so reviewers can match
    // a row to Telegram without the file carrying personal data.
    decisions.push({ ...row, decision: bucket, ...extra, textSha256: typeof m?.text === 'string' ? sha256(m.text) : null });
  }
  const limitations = [];
  for (const [chatId, c] of Object.entries(meta?.chats || {})) {
    if (!c.reachedBoundary) limitations.push(`chat ${chatId}: oldest reachable message is ${c.oldestDate || 'unknown'}; history before it is not visible to this account`);
    if (c.floodWaits) limitations.push(`chat ${chatId}: Telegram rate-limited the export ${c.floodWaits} time(s) (waited and resumed)`);
  }
  if (!meta) limitations.push('export has no _meta line: completeness of the history read is unknown');
  return {
    boundary: cfg.paymentStartMs == null ? null : new Date(cfg.paymentStartMs).toISOString(),
    counts, byMethod, rejectedReasons, limitations, decisions,
    effectOnTotals: 'None until staff/admin accept: every imported payment is created PENDING; attention events never change totals.',
  };
}

// Writes each message through the live path (cutoff, classification, sender
// verification, de-duplication). Returns per-outcome counts.
function applyBackfill(bot, messages, { approvedBy, onProgress } = {}) {
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) throw new Error('Backfill apply requires the approving owner name.');
  const outcomes = {};
  let n = 0;
  for (const m of messages) {
    n++;
    let k;
    if (!validShape(m)) k = 'invalid';
    else if (m.edited) k = 'ignored_edit';
    else {
      const r = bot.handleMessage(null, toMsg(m), { backfill: true });
      k = r?.outcome ?? 'logged';
    }
    outcomes[k] = (outcomes[k] || 0) + 1;
    if (onProgress && n % 200 === 0) onProgress(n, messages.length);
  }
  bot.ledger.logTelegramEvent({ kind: 'backfill', outcome: 'backfill_applied', detail: `approved_by=${approvedBy.slice(0, 60)} ${JSON.stringify(outcomes)}`.slice(0, 500) });
  return outcomes;
}

module.exports = { parseExport, previewBackfill, applyBackfill, approvalToken, decisionFingerprint };
