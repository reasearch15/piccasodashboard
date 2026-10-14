'use strict';
// Incoming-payment parsers for Larry's BOT notifications. Chime uses chime-v1.
// Venmo uses venmo-v1 (same multiline layout) ONLY when PICASSO_VENMO_PARSER=
// venmo-v1 is set explicitly; the default "review" keeps every Venmo message in
// Admin Attention. All parsers are strict: anything else is never guessed.
//
// ---- Chime (chime-v1), from a real sample ----------------------------------
//
//   🟢 Hi $Kristen-Huey-1,
//   You received $14.0 from Amanda M.
//   08:39 PM - 14 Oct 2026
//   ➕ Total In: 15.00$
//   ➖ Total Out: 0.00$
//
// The payment is the single "You received $X from NAME" line. The greeting
// gives the recipient tag. The time line and the Total In / Total Out summary
// lines are recognised and ignored (they are running totals, not payments).
// Any other line makes the message unsafe to auto-read.

const CHIME_PARSER_VERSION = 'chime-v1';
const CHIME_GREETING = /^(?:\p{Extended_Pictographic}️?\s*)?Hi \$(?<tag>[A-Za-z0-9][A-Za-z0-9-]{0,63}),?$/u;
const CHIME_RECEIVED = /^You received \$(?<dollars>\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(?<cents>\d{1,2}))? from (?<name>\p{L}[\p{L} .'-]{0,78})$/u;
const CHIME_TIME = /^\d{1,2}:\d{2}\s?(?:AM|PM) - \d{1,2} [A-Z][a-z]{2} \d{4}$/;
const CHIME_TOTAL = /^(?:\p{Extended_Pictographic}️?\s*)?Total (?:In|Out)\s*:\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\$$/u;

// "Amanda M." keeps the period of an initial; "Amanda Moore." loses the
// sentence-ending one.
const cleanName = raw => {
  let n = raw.replace(/\s+/g, ' ').trim();
  if (n.endsWith('.') && !/(?:^|\s)\p{Lu}\.$/u.test(n)) n = n.slice(0, -1).trim();
  return n;
};

// One strict grammar for Larry's multiline notifications. Only the greeting
// differs per method. The payment is the single "You received $X from NAME"
// line; time and Total In / Total Out lines are recognised and skipped (they
// are running totals, never payments); any other line rejects the message.
function parseLarryMessage(text, { greeting, version, recipient }) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'no_text' };
  if (text.length > 1000) return { ok: false, reason: 'too_long' };
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let greet = null, received = null;
  for (const line of lines) {
    let m;
    if ((m = greeting.exec(line))) {
      if (greet !== null) return { ok: false, reason: 'ambiguous_recipient' };
      greet = m.groups;
    } else if ((m = CHIME_RECEIVED.exec(line))) {
      if (received) return { ok: false, reason: 'ambiguous_amount' };
      received = m.groups;
    } else if (CHIME_TIME.test(line) || CHIME_TOTAL.test(line)) {
      // Known lines with no bearing on the individual payment.
    } else {
      return { ok: false, reason: /you received/i.test(line) ? 'malformed' : 'unexpected_line' };
    }
  }
  // Every line was a known non-payment line (greeting/time/totals only).
  if (!received) return { ok: false, reason: 'summary_only' };
  if (!greet) return { ok: false, reason: 'missing_recipient' };
  const name = cleanName(received.name);
  if (name.replace(/[^\p{L}]/gu, '').length < 2) return { ok: false, reason: 'missing_sender' };
  const amountCents = Number(received.dollars.replace(/,/g, '')) * 100 + Number((received.cents || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, reason: 'invalid_amount' };
  if (amountCents > MAX_CENTS) return { ok: false, reason: 'amount_out_of_range' };
  return { ok: true, name, amountCents, recipient: recipient(greet), parserVersion: version };
}

function parseChimeMessage(text) {
  return parseLarryMessage(text, { greeting: CHIME_GREETING, version: CHIME_PARSER_VERSION, recipient: g => `$${g.tag}` });
}

// ---- Venmo (venmo-v1, explicit opt-in) ---------------------------------------
// Same layout as chime-v1. The greeting may carry the recipient as a cash-tag
// style "$Tag" or a Venmo "@handle"; nothing else is accepted.
//
//   🟢 Hi @Test-Handle,
//   You received $20.0 from Test Payer.
//   09:15 AM - 15 Oct 2026
//   ➕ Total In: 35.00$
//   ➖ Total Out: 0.00$
const VENMO_PARSER_VERSION = 'venmo-v1';
const VENMO_GREETING = /^(?:\p{Extended_Pictographic}\uFE0F?\s*)?Hi (?<sigil>[$@])(?<tag>[A-Za-z0-9][A-Za-z0-9_-]{0,63}),?$/u;
function parseVenmoMessage(text) {
  return parseLarryMessage(text, { greeting: VENMO_GREETING, version: VENMO_PARSER_VERSION, recipient: g => `${g.sigil}${g.tag}` });
}

// ---- Venmo (provisional) ---------------------------------------------------
//
//   <Sender Name> sent you $<amount>
//
//   Olivia Carter sent you $45.00
//   Ethan Reed sent you $1,250
//
// Replace this module (and bump PARSER_VERSION) once real samples are reviewed.

const PARSER_VERSION = 'provisional-v1';
const VENMO_REVIEW_VERSION = 'venmo-review-v1';
const MAX_CENTS = 10_000_000; // $100,000.00 sanity ceiling
const PATTERN = /^(?<name>\p{L}[\p{L} .'-]{0,78}\p{L}\.?) sent you \$(?<dollars>\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(?<cents>\d{2}))?\.?$/u;

function parsePaymentMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'no_text' };
  const t = text.trim();
  if (t.length > 300) return { ok: false, reason: 'too_long' };
  const dollarSigns = (t.match(/\$/g) || []).length;
  if (!dollarSigns) return { ok: false, reason: 'not_payment' };
  if (dollarSigns > 1) return { ok: false, reason: 'ambiguous_amount' };
  if (/[\r\n]/.test(t)) return { ok: false, reason: 'malformed' };
  const m = PATTERN.exec(t);
  if (!m) return { ok: false, reason: /\$\s*\d/.test(t) ? 'malformed' : 'missing_amount' };
  const name = m.groups.name.replace(/\s+/g, ' ').trim();
  if (name.replace(/[^\p{L}]/gu, '').length < 2) return { ok: false, reason: 'missing_sender' };
  const amountCents = Number(m.groups.dollars.replace(/,/g, '')) * 100 + Number(m.groups.cents || 0);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, reason: 'invalid_amount' };
  if (amountCents > MAX_CENTS) return { ok: false, reason: 'amount_out_of_range' };
  return { ok: true, name, amountCents, parserVersion: PARSER_VERSION };
}

// ---- Admin Attention -------------------------------------------------------
// Recognised adjustment notification (any header lines, then exactly one):
//
//   Larry's BOT
//   Total In adjusted by -8.00$
//
// Sign may be "+", "-" or absent (absent = positive). "Total Out" works the
// same way. Amounts are read exactly as written; nothing is inferred.
const ADJUSTMENT_LINE = /^total (in|out) adjusted by ([+-]?)(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{2}))?\s?\$$/i;
const ADJUSTMENT_HINT = /\btotal\s+(in|out)\b|\badjust/i;
// Words that make a message financially suspicious even without a usable amount.
const FINANCIAL_HINT = /\$|\b(usd|refund(ed)?|revers(al|ed)|chargeback|dispute[d]?|withdraw(al|n)?|deposit(ed)?|balance|transfer(red)?|declined|returned|cancel(led|ed)?\s+payment|payment\s+(failed|cancel(led|ed)?))\b/i;

function parseAdjustment(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const hits = lines.map(l => ADJUSTMENT_LINE.exec(l)).filter(Boolean);
  if (hits.length !== 1) return null;
  const [, dir, sign, dollars, cents] = hits[0];
  const magnitude = Number(dollars.replace(/,/g, '')) * 100 + Number(cents || 0);
  if (!Number.isSafeInteger(magnitude) || magnitude === 0 || magnitude > MAX_CENTS) return null;
  // Any other dollar amount in the message makes it ambiguous.
  if ((text.match(/\$/g) || []).length !== 1) return null;
  return {
    eventType: dir.toLowerCase() === 'in' ? 'total_in_adjustment' : 'total_out_adjustment',
    amountCents: sign === '-' ? -magnitude : magnitude,
  };
}

// ---- Cash-out request messages (shared groups) ------------------------------
// Chime and Venmo each use ONE group for incoming payments and cash-out
// requests, so cash-out messages must be recognised explicitly and never read
// as payments or "suspicious" notifications:
//   - Picasso's own bot message, first line "PICASSO CASH OUT"
//   - the staff-typed request, first line "!! Cashout Request !!" with
//     "Tag name :" / "Amoun :" (that spelling, or "Amount :")
const CASHOUT_HEADER = /^(?:PICASSO CASH OUT|!!\s*Cash\s*-?\s*out\s+Request\s*!!)$/i;
const CASHOUT_FIELD = /^(?:Tag\s*name|Amoun|Amount)\s*:/i;
function isCashoutRequest(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (CASHOUT_HEADER.test(lines[0])) return true;
  return lines.filter(l => CASHOUT_FIELD.test(l)).length >= 2 && lines.some(l => /^Tag\s*name\s*:/i.test(l));
}

// Decides what one Telegram message becomes. Every message yields exactly one
// outcome, so a message can never be both a payment and an attention event.
//   cashout_request -> no record (logged; cash-outs come only from the dashboard)
//   payment   -> Payment Panel (pending)
//   attention -> Admin Attention (pending review; amount only if recognised)
//   none      -> no financial record (logged only)
// The parser is chosen by the group's configured method, never by the text.
function classifyMessage(text, method = 'Venmo', { venmoParser = 'provisional' } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { kind: 'none', reason: 'no_text' };
  // Checked first: a cash-out request is never a payment or an attention item.
  if (isCashoutRequest(text)) return { kind: 'cashout_request', reason: 'cashout_request' };
  const payment = method === 'Chime' ? parseChimeMessage(text)
    : venmoParser === 'venmo-v1' ? parseVenmoMessage(text)
    : parsePaymentMessage(text);
  // Unverified Venmo: even a message that looks like a payment is only held
  // for review, never turned into a payment, and no amount is asserted.
  if (method === 'Venmo' && venmoParser === 'review' && payment.ok) {
    return { kind: 'attention', eventType: 'unrecognized_financial', amountCents: null, reason: 'venmo_format_unverified', parserVersion: VENMO_REVIEW_VERSION };
  }
  if (payment.ok) return { kind: 'payment', ...payment };
  // Chime running-total summaries are not payments and not adjustments.
  if (payment.reason === 'summary_only') return { kind: 'none', reason: 'summary_only' };
  const adj = parseAdjustment(text.trim());
  if (adj) return { kind: 'attention', ...adj, reason: 'recognized_adjustment', parserVersion: method === 'Chime' ? CHIME_PARSER_VERSION : PARSER_VERSION };
  if (ADJUSTMENT_HINT.test(text)) return { kind: 'attention', eventType: 'unrecognized_financial', amountCents: null, reason: 'unparsed_adjustment', parserVersion: PARSER_VERSION };
  if (FINANCIAL_HINT.test(text)) return { kind: 'attention', eventType: 'unrecognized_financial', amountCents: null, reason: `suspicious_${payment.reason}`, parserVersion: PARSER_VERSION };
  return { kind: 'none', reason: payment.reason };
}

module.exports = { parsePaymentMessage, parseChimeMessage, parseVenmoMessage, classifyMessage, isCashoutRequest, PARSER_VERSION, CHIME_PARSER_VERSION, VENMO_PARSER_VERSION };
