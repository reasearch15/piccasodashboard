'use strict';
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { parsePaymentMessage } = require('../server/telegram/parser');
const { loadTelegramConfig } = require('../server/telegram/config');
const { cashoutText } = require('../server/telegram/messages');
const { openLedgerDb, LEDGER_MIGRATIONS } = require('../server/db');
const { DemoLedger } = require('../server/demo-ledger');

// Synthetic values only. The token is random per run and only ever sent to the
// local mock server.
const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
const CHATS = { chimeIn: '-1001000000001', venmoIn: '-1001000000002', chimeOut: '-1001000000003', venmoOut: '-1001000000004' };
const COMPLETER = 111, COMPLETER_2 = 222, STRANGER = 333;

const tgEnv = base => ({
  PICASSO_TELEGRAM_MODE: 'polling',
  PICASSO_TELEGRAM_BOT_TOKEN: TOKEN,
  PICASSO_TELEGRAM_API_BASE: base,
  PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHATS.chimeIn,
  PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: CHATS.venmoIn,
  PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: CHATS.chimeOut,
  PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: CHATS.venmoOut,
  PICASSO_TELEGRAM_COMPLETER_IDS: `${COMPLETER},${COMPLETER_2}`,
  PICASSO_VENMO_PARSER: 'provisional', // demo-only; production keeps Venmo in review
});

// Synthetic message in the real Chime "Larry's BOT" layout (chime-v1).
const chime = (sender, amount, recipient = 'Test-Recipient-1') =>
  ['🟢 Hi $' + recipient + ',', 'You received $' + amount + ' from ' + sender + '.', '08:39 PM - 14 Oct 2026', '➕ Total In: 15.00$', '➖ Total Out: 0.00$'].join('\n');

let updateId = 1000, messageId = 1;
const msgUpdate = (chat, text, { mid = ++messageId, date = Math.floor(Date.now() / 1000) } = {}) => ({
  update_id: ++updateId,
  message: { message_id: mid, date, chat: { id: Number(chat), type: 'supergroup' }, from: { id: 777, is_bot: false, first_name: 'Notifier' }, text },
});
const cbUpdate = (o, fromId, { botId = 424242, data = `c:${o.callbackToken}`, mid = o.telegramMessageId, chat = o.telegramChatId } = {}) => ({
  update_id: ++updateId,
  callback_query: {
    id: `cq${updateId}`, data,
    from: { id: fromId, is_bot: false, first_name: fromId === COMPLETER ? 'Alice' : 'Someone', last_name: fromId === COMPLETER ? 'Ops' : undefined },
    message: { message_id: mid, chat: { id: Number(chat) }, from: { id: botId, is_bot: true } },
  },
});

describe('Telegram bridge (mocked Bot API)', () => {
  let tg, srv, admin, staff, staffId, staffPw;
  const totals = async m => (await admin.get('/api/calculations')).json.totals[m];
  const payments = async () => (await staff.get('/api/payments')).json.payments;
  const cashout = async id => (await admin.get('/api/cashouts')).json.cashouts.find(o => o.id === id);
  const newCashout = async (method, amount = '20.00', who = staff) => {
    const r = await who.post('/api/cashouts', { method, name: '@synthetic-recipient', amount });
    assert.equal(r.status, 201);
    await srv.telegram.processOutbox();
    return srv.ledger.getCashout(r.json.id);
  };
  const events = () => srv.ledger.db.prepare('SELECT * FROM telegram_events ORDER BY id').all();

  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer(tgEnv(tg.base));
    await srv.telegram.init();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    staffPw = randomPassword();
    staffId = (await admin.post('/api/staff', { username: 'jordan', password: staffPw })).json.staff.id;
    staff = srv.client();
    await staff.login('jordan', staffPw);
  });
  after(async () => { await srv.close(); await tg.close(); });

  it('1. valid Chime message creates a red pending payment at the top', async () => {
    await srv.telegram.handleUpdate(msgUpdate(CHATS.chimeIn, chime('Olivia Carter', '45.00')));
    const list = await payments();
    assert.deepEqual([list[0].method, list[0].name, list[0].amountCents, list[0].status], ['Chime', 'Olivia Carter', 4500, 'pending']);
    assert.ok(!('source_chat_id' in list[0]) && !JSON.stringify(list).includes(CHATS.chimeIn), 'no Telegram IDs exposed');
    const row = srv.ledger.db.prepare("SELECT * FROM demo_payments WHERE source = 'telegram'").get();
    assert.equal(row.source_chat_id, CHATS.chimeIn);
    assert.equal(row.parser_version, 'chime-v1');
    assert.equal(row.recipient_tag, '$Test-Recipient-1');
    assert.ok(row.created_at && row.received_at);
  });

  it('2. valid provisional Venmo message creates a pending payment; newest pending first', async () => {
    await srv.telegram.handleUpdate(msgUpdate(CHATS.venmoIn, 'Ethan Reed sent you $1,250', { date: Math.floor(Date.now() / 1000) + 5 }));
    const list = await payments();
    assert.deepEqual([list[0].method, list[0].name, list[0].amountCents], ['Venmo', 'Ethan Reed', 125000]);
    assert.equal(list[1].name, 'Olivia Carter');
    assert.equal((await staff.post(`/api/payments/${list[0].id}/accept`)).status, 204, 'staff can accept it');
    const p = (await payments()).find(x => x.id === list[0].id);
    assert.deepEqual([p.status, p.acceptedById], ['accepted', staffId]);
  });

  it('3. duplicate Telegram messages create exactly one payment', async () => {
    const u = msgUpdate(CHATS.chimeIn, chime('Maya Lin', '10.00'));
    await srv.telegram.handleUpdate(u);
    await srv.telegram.handleUpdate(u);
    await srv.telegram.handleUpdate({ ...u, update_id: ++updateId });
    assert.equal((await payments()).filter(p => p.name === 'Maya Lin').length, 1);
    assert.ok(events().some(e => e.outcome === 'duplicate_message'));
    // Same message_id in the *other* group is a different message.
    await srv.telegram.handleUpdate(msgUpdate(CHATS.venmoIn, 'Maya Lin sent you $10.00', { mid: u.message.message_id }));
    assert.equal((await payments()).filter(p => p.name === 'Maya Lin').length, 2);
  });

  it('4. malformed / non-payment messages are rejected and logged without text', async () => {
    const before = (await payments()).length;
    for (const text of ['hello team', 'Olivia sent you', 'sent you $40.00', 'Olivia Carter sent you $45.5', 'Olivia Carter sent you $45.00\nthanks',
      '<b>Bob</b> sent you $5.00', 'Olivia Carter received $45.00', '12345 sent you $5.00', undefined]) {
      await srv.telegram.handleUpdate(msgUpdate(CHATS.chimeIn, text));
    }
    assert.equal((await payments()).length, before);
    // Since Admin Attention, money-like rejects become review items; none are payments.
    const rejected = events().filter(e => e.outcome.startsWith('rejected_') || e.outcome === 'attention_created');
    assert.ok(rejected.length >= 9);
    assert.ok(rejected.every(e => !/Olivia|Bob|hello/.test(e.detail || '')), 'message text is not stored');
  });

  it('5. missing or ambiguous amounts are rejected', async () => {
    const before = (await payments()).length;
    for (const [text, reason] of [
      ['Olivia Carter sent you money', 'not_payment'],
      ['Olivia Carter sent you $45 and $5', 'ambiguous_amount'],
      ['Olivia Carter sent you $', 'missing_amount'],
      ['Olivia Carter sent you $0.00', 'invalid_amount'],
      ['Olivia Carter sent you $999,999,999', 'amount_out_of_range'],
    ]) assert.equal(parsePaymentMessage(text).reason, reason, text);
    await srv.telegram.handleUpdate(msgUpdate(CHATS.venmoIn, 'Olivia Carter sent you $45 and $5'));
    assert.equal((await payments()).length, before);
  });

  it('6. messages from unrelated groups, cash-out groups, private chats and the bot itself are ignored', async () => {
    const before = (await payments()).length;
    await srv.telegram.handleUpdate(msgUpdate('-1009999999999', 'Olivia Carter sent you $45.00'));
    await srv.telegram.handleUpdate(msgUpdate(CHATS.chimeOut, 'Olivia Carter sent you $45.00'));
    await srv.telegram.handleUpdate(msgUpdate('555', 'Olivia Carter sent you $45.00'));
    const own = msgUpdate(CHATS.chimeIn, chime('Olivia Carter', '45.00'));
    own.message.from = { id: 424242, is_bot: true };
    await srv.telegram.handleUpdate(own);
    const edited = msgUpdate(CHATS.chimeIn, chime('Olivia Carter', '99.00'));
    await srv.telegram.handleUpdate({ update_id: edited.update_id, edited_message: edited.message });
    assert.equal((await payments()).length, before);
    const outcomes = events().slice(-5).map(e => e.outcome);
    assert.deepEqual(outcomes, ['ignored_unconfigured_chat', 'ignored_not_incoming_group', 'ignored_unconfigured_chat', 'ignored_own_message', 'ignored_edit']);
  });

  it('7. cash-out requests are routed to the matching method group, in the agreed format', async () => {
    tg.state.calls.length = 0;
    const c = await newCashout('Chime', '150.00');
    const v = await newCashout('Venmo', '75.25', admin);
    const sends = tg.callsOf('sendMessage');
    assert.deepEqual(sends.map(s => String(s.params.chat_id)), [CHATS.chimeOut, CHATS.venmoOut]);
    assert.equal(sends[0].params.text, [
      'PICASSO CASH OUT', 'Method: Chime', 'Recipient: @synthetic-recipient', 'Amount: $150.00',
      'Requested by: jordan', `Request ID: CO-${String(c.requestNo).padStart(6, '0')}`, 'Status: PENDING'].join('\n'));
    assert.equal(sends[0].params.parse_mode, undefined, 'plain text, no formatting injection');
    const button = sends[0].params.reply_markup.inline_keyboard[0][0];
    assert.deepEqual(Object.keys(button).sort(), ['callback_data', 'text']);
    assert.equal(button.text, 'Completed');
    assert.match(button.callback_data, /^c:[0-9a-f]{32}$/);
    assert.ok(!button.callback_data.includes(c.id));
    assert.match(sends[1].params.text, /Method: Venmo[\s\S]*Requested by: CharsiNew/);
    const shown = await cashout(c.id);
    assert.deepEqual([shown.status, shown.deliveryStatus, shown.createdById], ['pending', 'delivered', staffId]);
    assert.ok(!JSON.stringify(shown).includes(CHATS.chimeOut));
    const stored = srv.ledger.getCashout(c.id);
    assert.equal(stored.telegramChatId, CHATS.chimeOut);
    assert.equal(stored.telegramMessageId, sends[0].params && tg.state.nextMessageId - 1);
    assert.equal((await staff.post(`/api/cashouts/${c.id}/complete`)).status, 409, 'dashboard cannot complete when Telegram is on');
  });

  it('8. delivery failures retry without completing or duplicating the cash-out', async () => {
    const before = await totals('Chime');
    const countBefore = srv.ledger.db.prepare('SELECT COUNT(*) n FROM demo_cashouts').get().n;
    tg.state.fail.sendMessage = Infinity;
    const id = (await staff.post('/api/cashouts', { method: 'Chime', name: '@flaky', amount: '33.00' })).json.id;
    for (let i = 0; i < srv.config.telegram.maxDeliveryAttempts; i++) {
      srv.ledger.db.prepare('UPDATE demo_cashouts SET delivery_next_at = 0 WHERE id = ?').run(id);
      await srv.telegram.processOutbox();
    }
    let o = await cashout(id);
    assert.deepEqual([o.status, o.deliveryStatus], ['pending', 'failed']);
    assert.deepEqual(await totals('Chime'), before, 'pending/failed requests never touch Completed Out');
    assert.equal(srv.ledger.db.prepare('SELECT COUNT(*) n FROM demo_cashouts').get().n, countBefore + 1);
    assert.ok(!JSON.stringify(o).includes('Bad Gateway'), 'no Telegram error text on the dashboard');
    assert.equal((await staff.post(`/api/cashouts/${id}/retry-delivery`)).status, 403);
    tg.state.fail.sendMessage = 0;
    assert.equal((await admin.post(`/api/cashouts/${id}/retry-delivery`)).status, 204);
    await srv.telegram.processOutbox();
    o = await cashout(id);
    assert.deepEqual([o.status, o.deliveryStatus], ['pending', 'delivered']);
    assert.equal(srv.ledger.db.prepare('SELECT COUNT(*) n FROM demo_cashouts').get().n, countBefore + 1);
  });

  it('8b. Telegram rate limits (429 retry_after) are honoured', async () => {
    tg.state.fail.sendMessage = 1;
    tg.state.failWith.sendMessage = { status: 429, description: 'Too Many Requests: retry after 7', retry_after: 7 };
    const id = (await staff.post('/api/cashouts', { method: 'Venmo', name: '@slow', amount: '1.00' })).json.id;
    const t0 = Date.now();
    await srv.telegram.processOutbox();
    const row = srv.ledger.db.prepare('SELECT delivery_status, delivery_next_at FROM demo_cashouts WHERE id = ?').get(id);
    assert.equal(row.delivery_status, 'retrying');
    assert.ok(row.delivery_next_at >= t0 + 7000);
    delete tg.state.failWith.sendMessage;
  });

  it('9. "Completed" marks the right cash-out done, attributes it, and edits the message', async () => {
    const chimeBefore = await totals('Chime'), venmoBefore = await totals('Venmo');
    const a = await newCashout('Chime', '40.00');
    const b = await newCashout('Chime', '60.00');
    tg.state.calls.length = 0;
    const r = await srv.telegram.handleUpdate(cbUpdate(a, COMPLETER));
    assert.deepEqual(r, { completed: true });
    const done = await cashout(a.id);
    assert.deepEqual([done.status, done.completedBy, done.createdBy], ['done', 'Alice Ops', 'jordan']);
    assert.equal((await cashout(b.id)).status, 'pending', 'other cash-out untouched');
    const row = srv.ledger.db.prepare('SELECT completed_via, completed_by_telegram_id, completed_at FROM demo_cashouts WHERE id = ?').get(a.id);
    assert.deepEqual([row.completed_via, row.completed_by_telegram_id], ['telegram', String(COMPLETER)]);
    assert.ok(row.completed_at);
    assert.equal((await totals('Chime')).completedOut, chimeBefore.completedOut + 4000);
    assert.deepEqual(await totals('Venmo'), venmoBefore, 'Venmo accounting unaffected');
    await srv.telegram.processOutbox();
    const edit = tg.callsOf('editMessageText').find(c => c.params.message_id === a.telegramMessageId);
    assert.match(edit.params.text, /Status: COMPLETED\nCompleted by: Alice Ops$/);
    assert.deepEqual(edit.params.reply_markup, { inline_keyboard: [] }, 'button removed');
    assert.equal(tg.callsOf('answerCallbackQuery')[0].params.text, 'Marked completed.');
  });

  it('10. unauthorized users, forged tokens and mismatched messages cannot complete', async () => {
    const o = await newCashout('Venmo', '12.00');
    await srv.telegram.handleUpdate(cbUpdate(o, STRANGER));
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER, { data: `c:${'0'.repeat(32)}` }));
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER, { mid: o.telegramMessageId + 99 }));
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER, { chat: CHATS.chimeOut }));
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER, { botId: 1 }));
    const spoof = cbUpdate(o, STRANGER);
    spoof.callback_query.from.first_name = 'Alice';
    spoof.callback_query.from.last_name = 'Ops';
    spoof.callback_query.from.username = 'alice_ops';
    await srv.telegram.handleUpdate(spoof);
    assert.equal((await cashout(o.id)).status, 'pending');
    const outcomes = events().slice(-6).map(e => e.outcome);
    assert.deepEqual(outcomes, ['rejected_unauthorized_user', 'rejected_unknown_request', 'rejected_message_mismatch', 'rejected_message_mismatch', 'rejected_message_mismatch', 'rejected_unauthorized_user']);
  });

  it('11. repeated callbacks / duplicate updates do not double-count', async () => {
    const before = (await totals('Venmo')).completedOut;
    const o = await newCashout('Venmo', '25.00');
    const u = cbUpdate(o, COMPLETER);
    await Promise.all([srv.telegram.handleUpdate(u), srv.telegram.handleUpdate(u), srv.telegram.handleUpdate(cbUpdate(o, COMPLETER_2))]);
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER));
    assert.equal((await totals('Venmo')).completedOut, before + 2500);
    const ev = events().filter(e => e.ref_id === o.id);
    assert.equal(ev.filter(e => e.outcome === 'cashout_completed').length, 1);
    assert.equal(ev.filter(e => e.outcome === 'duplicate_completion').length, 3);
    assert.equal((await cashout(o.id)).completedBy, 'Alice Ops');
  });

  it('12. cancelled requests cannot be completed; their Telegram message is deleted', async () => {
    const o = await newCashout('Chime', '18.00');
    assert.equal((await admin.post(`/api/cashouts/${o.id}/cancel`)).status, 204);
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER));
    const after = await cashout(o.id);
    assert.deepEqual([after.status, after.cancelledBy], ['cancelled', 'CharsiNew']);
    assert.equal(events().at(-1).outcome, 'rejected_cancelled');
    await srv.telegram.processOutbox();
    const del = tg.callsOf('deleteMessage').filter(c => c.params.message_id === o.telegramMessageId);
    assert.equal(del.length, 1);
    assert.equal(String(del[0].params.chat_id), CHATS.chimeOut);
    assert.equal((await cashout(o.id)).telegramRemoval, 'removed');
  });

  it('12b. a request cancelled before delivery is never sent', async () => {
    const id = (await staff.post('/api/cashouts', { method: 'Venmo', name: '@never', amount: '9.00' })).json.id;
    assert.equal((await admin.post(`/api/cashouts/${id}/cancel`)).status, 204);
    tg.state.calls.length = 0;
    await srv.telegram.processOutbox();
    assert.equal(tg.callsOf('sendMessage').length, 0);
  });

  it('13. completed requests cannot be cancelled', async () => {
    const o = await newCashout('Chime', '11.00');
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER));
    const r = await admin.post(`/api/cashouts/${o.id}/cancel`);
    assert.equal(r.status, 409);
    assert.equal((await cashout(o.id)).status, 'done');
  });

  it('14. simultaneous cancel and complete: exactly one wins, atomically', async () => {
    for (let i = 0; i < 6; i++) {
      const o = await newCashout(i % 2 ? 'Venmo' : 'Chime', '5.00');
      const before = (await totals(o.method)).completedOut;
      const [cancel] = await Promise.all([
        admin.post(`/api/cashouts/${o.id}/cancel`),
        srv.telegram.handleUpdate(cbUpdate(o, COMPLETER)),
      ]);
      const final = await cashout(o.id);
      const delta = (await totals(o.method)).completedOut - before;
      if (final.status === 'cancelled') { assert.equal(cancel.status, 204); assert.equal(delta, 0); }
      else { assert.equal(final.status, 'done'); assert.equal(cancel.status, 409); assert.equal(delta, 500); }
      const row = srv.ledger.db.prepare('SELECT completed_at, cancelled_at FROM demo_cashouts WHERE id = ?').get(o.id);
      assert.ok(!(row.completed_at && row.cancelled_at), 'never both');
    }
  });

  it('a failed Telegram edit never reverses a committed completion, and is retried', async () => {
    const o = await newCashout('Venmo', '7.00');
    tg.state.fail.editMessageText = 2;
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER));
    for (let i = 0; i < 3; i++) {
      srv.ledger.db.prepare('UPDATE demo_cashouts SET message_sync_next_at = 0 WHERE id = ?').run(o.id);
      await srv.telegram.processOutbox();
      assert.equal((await cashout(o.id)).status, 'done');
    }
    const row = srv.ledger.db.prepare('SELECT message_sync_needed FROM demo_cashouts WHERE id = ?').get(o.id);
    assert.equal(row.message_sync_needed, 0, 'edit eventually succeeded');
    tg.state.fail.editMessageText = 1;
    tg.state.failWith.editMessageText = { status: 400, description: 'Bad Request: message is not modified' };
    srv.ledger.db.prepare('UPDATE demo_cashouts SET message_sync_needed = 1, message_sync_next_at = 0 WHERE id = ?').run(o.id);
    await srv.telegram.processOutbox();
    assert.equal(srv.ledger.db.prepare('SELECT message_sync_needed FROM demo_cashouts WHERE id = ?').get(o.id).message_sync_needed, 0);
    delete tg.state.failWith.editMessageText;
  });

  it('15. dashboard receives authenticated real-time updates (signals only)', async () => {
    assert.equal((await srv.client().get('/api/events')).status, 401);
    const ctrl = new AbortController();
    const res = await fetch(`${srv.base}/api/events`, { headers: { Cookie: staff.cookieHeader() }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    let buf = '';
    const waitFor = async needle => {
      const deadline = Date.now() + 3000;
      while (!buf.includes(needle) && Date.now() < deadline) buf += new TextDecoder().decode((await reader.read()).value);
      assert.ok(buf.includes(needle), `stream should contain ${needle}`);
    };
    await waitFor('event: ready');
    await srv.telegram.handleUpdate(msgUpdate(CHATS.chimeIn, chime('Live Update', '3.00')));
    await waitFor('"topics":["payments"]');
    const o = await newCashout('Chime', '4.00');
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER));
    await waitFor('"topics":["cashouts"]');
    const payloads = buf.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    assert.ok(payloads.every(d => Object.keys(d).every(k => k === 'topics')), 'only topic names travel over the stream');
    assert.ok(!/Live Update|Alice|amount|Cents/.test(buf));
    // Disabling the account closes the stream at the next check.
    await admin.post(`/api/staff/${staffId}/disable`);
    srv.events.publish(['payments']);
    const end = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r('timeout'), 2000))]);
    assert.equal(end.done, true, 'stream closed for disabled user');
    ctrl.abort();
    await admin.post(`/api/staff/${staffId}/enable`);
    assert.equal((await staff.login('jordan', staffPw)).status, 200);
  });

  it('16. settlement math is unchanged with Telegram-sourced records', async () => {
    const a2 = srv.client();
    await a2.login(srv.adminUsername, srv.adminPassword);
    await srv.ledger.reset();
    await srv.telegram.handleUpdate(msgUpdate(CHATS.venmoIn, 'Grace Hall sent you $50.00'));
    const p = (await a2.get('/api/payments')).json.payments.find(x => x.name === 'Grace Hall');
    await a2.post(`/api/payments/${p.id}/accept`);
    const o = await newCashout('Venmo', '100.00', a2);
    await srv.telegram.handleUpdate(cbUpdate(o, COMPLETER));
    const c = await newCashout('Chime', '999.00', a2);
    await srv.telegram.handleUpdate(cbUpdate(c, COMPLETER));
    // Venmo: p5 800 + p6 50 + Grace 50 incoming; o1 300 + Telegram 100 outgoing.
    const preview = (await a2.post('/api/settlements/preview', { paymentId: p.id })).json;
    assert.deepEqual([preview.incomingCents, preview.outgoingCents, preview.netCents], [90000, 40000, 50000]);
    assert.equal((await a2.post('/api/settlements', { paymentId: p.id })).status, 201);
    const v = (await a2.get('/api/calculations')).json.totals.Venmo;
    assert.deepEqual([v.acceptedIn, v.completedOut, v.totalSettlements, v.running], [102000, 40000, 62000, 0]);
    const ch = (await a2.get('/api/calculations')).json.totals.Chime;
    assert.equal(ch.completedOut, 8000 + 99900, 'Chime completion only in Chime');
    const s = (await a2.get('/api/settlements')).json.settlements.at(-1);
    assert.equal(s.cashouts.find(x => x.id === o.id).requestedBy, 'CharsiNew');
    assert.equal((await a2.get('/api/cashouts')).json.cashouts.find(x => x.id === o.id).settled, true);
  });

  it('audit: every Telegram event is recorded without the bot token', () => {
    const all = JSON.stringify(events());
    assert.ok(!all.includes(TOKEN) && !all.includes(TOKEN.split(':')[1]));
    for (const k of ['payment_created', 'duplicate_message', 'cashout_delivered', 'cashout_delivery_retry', 'cashout_completed', 'rejected_unauthorized_user', 'duplicate_completion', 'rejected_cancelled']) {
      assert.ok(all.includes(k), k);
    }
  });
});

describe('Telegram polling, webhook and configuration', () => {
  it('polling consumes updates once, persists the offset, and refuses to run alongside a webhook', async () => {
    const tg = await startMockTelegram(TOKEN);
    const srv = await startServer(tgEnv(tg.base));
    try {
      tg.state.updates.push(msgUpdate(CHATS.chimeIn, chime('Poll Test', '8.00')));
      await srv.telegram.start();
      const deadline = Date.now() + 3000;
      while (!srv.ledger.listPayments().some(p => p.name === 'Poll Test') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      assert.ok(srv.ledger.listPayments().some(p => p.name === 'Poll Test'));
      assert.equal(Number(srv.ledger.telegramMeta('update_offset')), tg.state.updates[0].update_id + 1);
      srv.telegram.stop();
      tg.state.webhookUrl = 'https://example.invalid/hook';
      await assert.rejects(srv.telegram.start(), /webhook is registered/);
    } finally { srv.telegram.stop(); await srv.close(); await tg.close(); }
  });

  it('webhook mode requires the secret token header', async () => {
    const tg = await startMockTelegram(TOKEN);
    const secret = crypto.randomBytes(32).toString('base64url');
    const srv = await startServer({ ...tgEnv(tg.base), PICASSO_TELEGRAM_MODE: 'webhook', PICASSO_TELEGRAM_WEBHOOK_SECRET: secret });
    try {
      await srv.telegram.init();
      const send = (hdr, u) => fetch(`${srv.base}/api/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify(u) });
      assert.equal((await send({}, msgUpdate(CHATS.chimeIn, chime('Hook Test', '2.00')))).status, 401);
      assert.equal((await send({ 'X-Telegram-Bot-Api-Secret-Token': 'x'.repeat(secret.length) }, msgUpdate(CHATS.chimeIn, chime('Hook Test', '2.00')))).status, 401);
      assert.ok(!srv.ledger.listPayments().some(p => p.name === 'Hook Test'));
      assert.equal((await send({ 'X-Telegram-Bot-Api-Secret-Token': secret }, msgUpdate(CHATS.chimeIn, chime('Hook Test', '2.00')))).status, 200);
      assert.ok(srv.ledger.listPayments().some(p => p.name === 'Hook Test'));
    } finally { await srv.close(); await tg.close(); }
    // Polling servers expose no webhook route at all.
    const tg2 = await startMockTelegram(TOKEN);
    const srv2 = await startServer(tgEnv(tg2.base));
    try { assert.equal((await fetch(`${srv2.base}/api/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404); }
    finally { await srv2.close(); await tg2.close(); }
  });

  it('startup validation rejects unsafe or incomplete configuration', () => {
    const env = tgEnv('http://127.0.0.1:9');
    assert.equal(loadTelegramConfig({}).enabled, false, 'off by default');
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_BOT_TOKEN: '' }), /BOT_TOKEN/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_API_BASE: undefined }), /ALLOW_LIVE/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: CHATS.chimeIn, PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS: 'true' }), /must be different/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: CHATS.chimeOut }), /more than one role/);
    assert.equal(loadTelegramConfig({ ...env, PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: CHATS.chimeOut, PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS: 'true' }).enabled, true);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_COMPLETER_IDS: '' }), /COMPLETER_IDS/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_COMPLETER_IDS: 'alice' }), /COMPLETER_IDS/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: 'my-group' }), /CHIME_CASHOUT/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_MODE: 'webhook' }), /WEBHOOK_SECRET/);
    assert.throws(() => loadTelegramConfig({ ...env, PICASSO_TELEGRAM_MODE: 'both' }), /off, polling or webhook/);
  });

  it('no bot token or chat ID is hardcoded in source', () => {
    const root = path.join(__dirname, '..');
    for (const dir of ['server', 'server/telegram', 'public']) {
      for (const f of fs.readdirSync(path.join(root, dir)).filter(f => /\.(js|html)$/.test(f))) {
        const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
        assert.ok(!/\d{6,}:[A-Za-z0-9_-]{30,}/.test(src), `${dir}/${f} contains a token-like string`);
        assert.ok(!/-100\d{10}/.test(src), `${dir}/${f} contains a chat ID`);
      }
    }
  });

  it('cash-out message text renders all statuses', () => {
    const o = { method: 'Venmo', name: '@exampleuser', amountCents: 15000, createdBy: 'John', requestNo: 123, status: 'pending' };
    assert.equal(cashoutText(o), 'PICASSO CASH OUT\nMethod: Venmo\nRecipient: @exampleuser\nAmount: $150.00\nRequested by: John\nRequest ID: CO-000123\nStatus: PENDING');
    assert.match(cashoutText({ ...o, status: 'done', completedBy: 'Alice Ops' }), /Status: COMPLETED\nCompleted by: Alice Ops$/);
  });
});

describe('18. Existing demo ledger and history survive the v2 migration', () => {
  it('a v1 database migrates in place with every record intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picasso-mig-'));
    try {
      // Build a genuine v1 database: v1 schema only, seeded, with a settlement.
      const v1 = new DatabaseSync(path.join(dir, 'demo-ledger.db'));
      v1.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      v1.exec(LEDGER_MIGRATIONS[0]);
      v1.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
      const ledgerV1 = new DemoLedger(v1);
      ledgerV1.db.prepare("UPDATE demo_payments SET status='accepted', accepted_at=?, accepted_by_id='staff-x', accepted_by='Riley', accept_order=8 WHERE id='p1'").run(new Date().toISOString());
      ledgerV1.commitSettlement('p1', { id: 'admin-x', username: 'CharsiNew' });
      const snapshot = JSON.stringify(ledgerV1.state());
      v1.close();

      const migrated = openLedgerDb(dir);
      assert.equal(migrated.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, LEDGER_MIGRATIONS.length);
      const ledger = new DemoLedger(migrated);
      const after = ledger.state();
      // Old fields identical; only new Telegram fields (null/defaults) appear.
      const strip = st => JSON.stringify({ ...st, cashouts: st.cashouts.map(({ requestNo, deliveryStatus, deliveryAttempts, messageSyncAttempts, telegramChatId, telegramMessageId, callbackToken, telegramDeleteStatus, telegramDeleteAttempts, ...rest }) => rest) });
      assert.equal(strip(after), strip(JSON.parse(snapshot)));
      assert.ok(after.cashouts.every(o => o.deliveryStatus === 'not_required' && o.telegramMessageId === null));
      assert.equal(after.settlements.at(-1).incoming.find(x => x.id === 'p1').acceptedBy, 'Riley');
      assert.ok(migrated.prepare("SELECT COUNT(*) n FROM demo_payments WHERE source = 'demo'").get().n >= 11);
      migrated.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
