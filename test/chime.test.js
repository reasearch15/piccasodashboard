'use strict';
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { parseChimeMessage, classifyMessage } = require('../server/telegram/parser');
const { loadTelegramConfig } = require('../server/telegram/config');

// Synthetic fixtures modelled on the real Larry's BOT Chime layout. Names and
// tags are invented; nothing here comes from a real conversation.
const fixture = ({ tag = 'Test-Payee-1', amount = '14.0', sender = 'Amanda M.', time = '08:39 PM - 14 Oct 2026', totalIn = '15.00', totalOut = '0.00', extra = [] } = {}) =>
  [`\u{1F7E2} Hi $${tag},`, `You received $${amount} from ${sender}`, time, `➕ Total In: ${totalIn}$`, `➖ Total Out: ${totalOut}$`, ...extra].filter(Boolean).join('\n');

describe('Chime parser (chime-v1)', () => {
  it('reads the individual payment, sender and recipient from the real layout', () => {
    const r = parseChimeMessage(fixture());
    assert.deepEqual(r, { ok: true, name: 'Amanda M.', amountCents: 1400, recipient: '$Test-Payee-1', parserVersion: 'chime-v1' });
  });

  it('accepts $14, $14.0, $14.00 (and $1,250.5) as exact integer cents', () => {
    for (const [amount, cents] of [['14', 1400], ['14.0', 1400], ['14.00', 1400], ['14.5', 1450], ['1,250.5', 125050], ['0.99', 99]]) {
      assert.equal(parseChimeMessage(fixture({ amount })).amountCents, cents, amount);
    }
  });

  it('ignores Total In / Total Out: the payment amount never comes from the summary', () => {
    const r = parseChimeMessage(fixture({ amount: '14.0', totalIn: '9,999.00', totalOut: '123.45' }));
    assert.equal(r.amountCents, 1400);
  });

  it('keeps an initial\'s period but drops a sentence period', () => {
    assert.equal(parseChimeMessage(fixture({ sender: 'Amanda M.' })).name, 'Amanda M.');
    assert.equal(parseChimeMessage(fixture({ sender: 'Amanda Moore.' })).name, 'Amanda Moore');
    assert.equal(parseChimeMessage(fixture({ sender: "Mary-Jo O'Neil" })).name, "Mary-Jo O'Neil");
  });

  it('tolerates the optional time line and CRLF line endings', () => {
    assert.equal(parseChimeMessage(fixture({ time: null })).ok, true);
    assert.equal(parseChimeMessage(fixture().replace(/\n/g, '\r\n')).ok, true);
  });

  it('rejects anything ambiguous or malformed instead of guessing', () => {
    const cases = [
      [fixture({ amount: '14.000' }), 'malformed'],
      [fixture({ amount: '14.' }), 'malformed'],
      [fixture({ amount: '-14.00' }), 'malformed'],
      [fixture({ amount: '0' }), 'invalid_amount'],
      [fixture({ amount: 'fourteen' }), 'malformed'],
      [fixture({ sender: '' }), 'malformed'],
      [fixture({ sender: '123' }), 'malformed'],
      [fixture({ tag: '' }), 'unexpected_line'],
      [fixture({ extra: ['You received $5.00 from Someone Else.'] }), 'ambiguous_amount'],
      [fixture({ extra: ['Note: reversed'] }), 'unexpected_line'],
      [fixture().replace(/^.*Hi.*\n/u, ''), 'missing_recipient'],
      [['Hi $A-1,', 'Hi $B-2,', 'You received $1.00 from Ann Lee.'].join('\n'), 'ambiguous_recipient'],
      [fixture({ amount: '999,999,999' }), 'amount_out_of_range'],
    ];
    for (const [text, reason] of cases) assert.equal(parseChimeMessage(text).reason, reason, text);
  });

  it('classification: payment vs summary-only vs adjustment vs unrelated', () => {
    assert.equal(classifyMessage(fixture(), 'Chime').kind, 'payment');
    const summary = ['\u{1F7E2} Hi $Test-Payee-1,', '08:39 PM - 14 Oct 2026', '➕ Total In: 15.00$', '➖ Total Out: 0.00$'].join('\n');
    assert.deepEqual(classifyMessage(summary, 'Chime'), { kind: 'none', reason: 'summary_only' });
    const adj = classifyMessage("Larry's BOT\nTotal In adjusted by -8.00$", 'Chime');
    assert.deepEqual([adj.kind, adj.eventType, adj.amountCents], ['attention', 'total_in_adjustment', -800]);
    assert.equal(classifyMessage('good morning', 'Chime').kind, 'none');
    // A garbled payment line is surfaced for review, never turned into a payment.
    const garbled = classifyMessage(fixture({ amount: '14.000' }), 'Chime');
    assert.deepEqual([garbled.kind, garbled.amountCents], ['attention', null]);
    // The parser is picked by the group's method, never by the text.
    assert.notEqual(classifyMessage(fixture(), 'Venmo').kind, 'payment');
    assert.notEqual(classifyMessage('Olivia Carter sent you $45.00', 'Chime').kind, 'payment');
  });

  it('accepts the basic-group style chat ID used by the Chime group', () => {
    const cfg = loadTelegramConfig({
      PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: `123456:${'x'.repeat(35)}`, PICASSO_TELEGRAM_API_BASE: 'http://127.0.0.1:9',
      PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: '-5000000001', PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: '-5000000002',
      PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: '-5000000003', PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: '-5000000004',
      PICASSO_TELEGRAM_COMPLETER_IDS: '1',
    });
    assert.equal(cfg.incomingMethodByChat.get('-5000000001'), 'Chime');
  });
});

describe('Listener ingest endpoint (for a future Telethon listener)', () => {
  const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
  const SECRET = crypto.randomBytes(32).toString('base64url');
  const CHIME_IN = '-5000000101';
  const env = (base, extra = {}) => ({
    PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: TOKEN, PICASSO_TELEGRAM_API_BASE: base,
    PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHIME_IN, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: '-5000000102',
    PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: '-5000000103', PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: '-5000000104',
    PICASSO_TELEGRAM_COMPLETER_IDS: '1', PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00+05:45', ...extra,
  });
  let tg, srv, mid = 700;
  const now = () => Math.floor(Date.now() / 1000);
  const ingest = (body, secret = SECRET) => fetch(`${srv.base}/api/ingest/telegram-message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': secret }, body: JSON.stringify({ senderId: 777000111, ...body }),
  });

  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer(env(tg.base, { PICASSO_LISTENER_INGEST_SECRET: SECRET, PICASSO_PAYMENT_SOURCE_SENDER_IDS: '777000111' }));
    await srv.telegram.init();
  });
  after(async () => { await srv.close(); await tg.close(); });

  it('creates a red pending Chime payment, never auto-accepted, with timestamp, parser version and recipient', async () => {
    const date = now() - 5;
    const r = await ingest({ chatId: CHIME_IN, messageId: ++mid, date, text: fixture({ sender: 'Synthetic Sender.', amount: '14' }), senderId: 777000111 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { outcome: 'created' });
    const p = srv.ledger.listPayments()[0];
    assert.deepEqual([p.method, p.name, p.amountCents, p.status, p.acceptedBy ?? null], ['Chime', 'Synthetic Sender', 1400, 'pending', null]);
    assert.equal(p.receivedAt, new Date(date * 1000).toISOString());
    const row = srv.ledger.db.prepare('SELECT parser_version, recipient_tag, source_chat_id, source_message_id FROM demo_payments WHERE id = ?').get(p.id);
    assert.deepEqual([row.parser_version, row.recipient_tag, row.source_chat_id, row.source_message_id], ['chime-v1', '$Test-Payee-1', CHIME_IN, mid]);
    const admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const shown = (await admin.get('/api/payments')).json.payments[0];
    assert.ok(!JSON.stringify(shown).includes(CHIME_IN) && !('recipient_tag' in shown), 'Telegram details stay server-side');
  });

  it('deduplicates by chat ID + message ID, across the listener and the Bot API path', async () => {
    const body = { chatId: CHIME_IN, messageId: ++mid, date: now(), text: fixture({ sender: 'Dup Test' }) };
    assert.deepEqual(await (await ingest(body)).json(), { outcome: 'created' });
    assert.deepEqual(await (await ingest(body)).json(), { outcome: 'duplicate' });
    await srv.telegram.handleUpdate({ update_id: 1, message: { message_id: body.messageId, date: body.date, chat: { id: Number(CHIME_IN) }, from: { id: 5 }, text: body.text } });
    assert.equal(srv.ledger.listPayments().filter(p => p.name === 'Dup Test').length, 1);
  });

  it('summary-only, adjustment, unrelated and historical messages create no payment', async () => {
    const before = srv.ledger.listPayments().length;
    await ingest({ chatId: CHIME_IN, messageId: ++mid, date: now(), text: '➕ Total In: 15.00$\n➖ Total Out: 0.00$' });
    await ingest({ chatId: CHIME_IN, messageId: ++mid, date: now(), text: "Larry's BOT\nTotal In adjusted by -8.00$" });
    await ingest({ chatId: CHIME_IN, messageId: ++mid, date: now(), text: 'shift change at 9' });
    await ingest({ chatId: CHIME_IN, messageId: ++mid, date: now() - 86400, text: fixture({ sender: 'Old Message' }) });
    await ingest({ chatId: '-5999999999', messageId: ++mid, date: now(), text: fixture({ sender: 'Wrong Group' }) });
    assert.equal(srv.ledger.listPayments().length, before);
    assert.equal(srv.ledger.listAttention().events.length, 1, 'only the adjustment goes to Admin Attention');
    const outcomes = srv.ledger.db.prepare('SELECT outcome FROM telegram_events ORDER BY id DESC LIMIT 5').all().map(r => r.outcome).reverse();
    assert.deepEqual(outcomes, ['rejected_summary_only', 'attention_created', 'rejected_unexpected_line', 'ignored_too_old_for_live', 'ignored_unconfigured_chat']);
  });

  it('rejects wrong secrets and bad input; route does not exist without a secret', async () => {
    assert.equal((await ingest({ chatId: CHIME_IN, messageId: ++mid, date: now(), text: fixture() }, 'x'.repeat(SECRET.length))).status, 401);
    assert.equal((await ingest({ chatId: CHIME_IN, messageId: 'abc', date: now(), text: 'x' })).status, 400);
    const r = await fetch(`${srv.base}/api/ingest/telegram-message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET, 'X-Forwarded-For': '203.0.113.9' }, body: '{}' });
    assert.equal(r.status, 403, 'proxied (non-local) requests refused');
    const tg2 = await startMockTelegram(TOKEN);
    const srv2 = await startServer(env(tg2.base));
    try { assert.equal((await fetch(`${srv2.base}/api/ingest/telegram-message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404); }
    finally { await srv2.close(); await tg2.close(); }
  });

  it('staff can accept an ingested payment; it is never accepted automatically', async () => {
    const admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'kim', password: pw });
    const staff = srv.client();
    await staff.login('kim', pw);
    const p = (await staff.get('/api/payments')).json.payments.find(x => x.status === 'pending' && x.method === 'Chime');
    assert.equal((await staff.post(`/api/payments/${p.id}/accept`)).status, 204);
    assert.equal((await staff.get('/api/payments')).json.payments.find(x => x.id === p.id).acceptedBy, 'kim');
  });
});
