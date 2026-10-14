'use strict';
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { classifyMessage } = require('../server/telegram/parser');

// Synthetic values only; the token goes nowhere but the local mock.
const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
const CHATS = { chimeIn: '-1002000000001', venmoIn: '-1002000000002', chimeOut: '-1002000000003', venmoOut: '-1002000000004' };
const env = base => ({
  PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: TOKEN, PICASSO_TELEGRAM_API_BASE: base,
  PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHATS.chimeIn, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: CHATS.venmoIn,
  PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: CHATS.chimeOut, PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: CHATS.venmoOut,
  PICASSO_TELEGRAM_COMPLETER_IDS: '111', PICASSO_VENMO_PARSER: 'provisional',
});
let updateId = 5000, messageId = 100;
const now = () => Math.floor(Date.now() / 1000);
const msg = (chat, text, { mid = ++messageId, date = now(), fromBot = true } = {}) => ({
  update_id: ++updateId,
  message: { message_id: mid, date, chat: { id: Number(chat), type: 'supergroup' }, from: { id: 9001, is_bot: fromBot, first_name: "Larry's BOT" }, text },
});

describe('Admin Attention: classification', () => {
  it('recognises signed Total In / Total Out adjustments in integer cents', () => {
    const cases = [
      ["Larry's BOT\nTotal In adjusted by -8.00$", 'total_in_adjustment', -800],
      ["Larry's BOT\nTotal In adjusted by +12.50$", 'total_in_adjustment', 1250],
      ["Larry's BOT\nTotal Out adjusted by -1,000.00$", 'total_out_adjustment', -100000],
      ['Total Out adjusted by 3$', 'total_out_adjustment', 300],
    ];
    for (const [text, type, cents] of cases) {
      const c = classifyMessage(text);
      assert.deepEqual([c.kind, c.eventType, c.amountCents], ['attention', type, cents], text);
    }
  });

  it('never invents amounts for unrecognised financial notifications', () => {
    for (const text of [
      "Larry's BOT\nTotal In adjusted by $",            // missing amount
      "Larry's BOT\nTotal In adjusted by -8.5$",         // malformed amount
      "Larry's BOT\nTotal In adjusted by -8.00",          // no currency marker
      'Total In adjusted by -8.00$\nTotal Out adjusted by 2.00$', // two adjustments
      'Total In adjusted by -8.00$ (was $50.00)',         // extra amount
      'Refund issued to Olivia Carter',
      'Olivia Carter sent you $45.5',
      'Payment failed for Ethan Reed $20.00',
    ]) {
      const c = classifyMessage(text);
      assert.deepEqual([c.kind, c.eventType, c.amountCents], ['attention', 'unrecognized_financial', null], text);
    }
  });

  it('keeps payments as payments and ignores plain conversation', () => {
    assert.equal(classifyMessage('Olivia Carter sent you $45.00').kind, 'payment');
    for (const text of ['good morning team', 'who is on shift?', 'ok', '', undefined]) assert.equal(classifyMessage(text).kind, 'none', String(text));
  });
});

describe('Admin Attention: end to end (mocked Telegram)', () => {
  let tg, srv, admin, staff, staffPw;
  const list = async (c = admin) => (await c.get('/api/attention')).json;

  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer(env(tg.base));
    await srv.telegram.init();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    staffPw = randomPassword();
    await admin.post('/api/staff', { username: 'sam', password: staffPw });
    staff = srv.client();
    await staff.login('sam', staffPw);
  });
  after(async () => { await srv.close(); await tg.close(); });

  it('positive and negative Total In / Total Out adjustments create pending events with the right method', async () => {
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, "Larry's BOT\nTotal In adjusted by -8.00$", { date: now() - 30 }));
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, "Larry's BOT\nTotal In adjusted by +4.00$", { date: now() - 20 }));
    await srv.telegram.handleUpdate(msg(CHATS.venmoIn, "Larry's BOT\nTotal Out adjusted by -2.25$", { date: now() - 10 }));
    await srv.telegram.handleUpdate(msg(CHATS.venmoIn, "Larry's BOT\nTotal Out adjusted by 6.00$", { date: now() }));
    const { events, pendingCount } = await list();
    assert.equal(pendingCount, 4);
    assert.deepEqual(events.map(e => [e.method, e.eventType, e.amountCents, e.status]), [
      ['Venmo', 'total_out_adjustment', 600, 'pending'],
      ['Venmo', 'total_out_adjustment', -225, 'pending'],
      ['Chime', 'total_in_adjustment', 400, 'pending'],
      ['Chime', 'total_in_adjustment', -800, 'pending'],
    ], 'newest first');
    assert.equal(events.at(-1).originalText, "Larry's BOT\nTotal In adjusted by -8.00$");
    assert.equal(events[0].parserVersion, 'provisional-v1');
    assert.ok(!JSON.stringify(events).includes(CHATS.chimeIn), 'no Telegram IDs in the API');
    const row = srv.ledger.db.prepare('SELECT source_chat_id, source_message_id, message_at FROM attention_events WHERE amount_cents = -800').get();
    assert.equal(row.source_chat_id, CHATS.chimeIn);
    assert.ok(Number.isInteger(row.source_message_id) && row.message_at);
  });

  it('duplicates never create a second record, and one message never becomes both a payment and an event', async () => {
    const u = msg(CHATS.chimeIn, "Larry's BOT\nTotal In adjusted by -1.00$");
    await srv.telegram.handleUpdate(u);
    await srv.telegram.handleUpdate(u);
    await srv.telegram.handleUpdate({ ...u, update_id: ++updateId });
    assert.equal((await list()).events.filter(e => e.amountCents === -100).length, 1);
    // Same chat+message ID arriving with payment-shaped text is still a duplicate.
    const paymentsBefore = srv.ledger.listPayments().length;
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, 'Olivia Carter sent you $45.00', { mid: u.message.message_id }));
    assert.equal(srv.ledger.listPayments().length, paymentsBefore);
    // And a real payment message goes only to the Payment Panel.
    const attentionBefore = (await list()).events.length;
    await srv.telegram.handleUpdate(msg(CHATS.venmoIn, 'Olivia Carter sent you $45.00', { fromBot: false }));
    assert.equal(srv.ledger.listPayments().length, paymentsBefore + 1);
    assert.equal((await list()).events.length, attentionBefore);
  });

  it('missing amounts become unrecognised events with no amount; chit-chat creates nothing', async () => {
    const before = (await list()).events.length;
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, "Larry's BOT\nTotal In adjusted by $"));
    const e = (await list()).events[0];
    assert.deepEqual([e.eventType, e.amountCents, e.status], ['unrecognized_financial', null, 'pending']);
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, 'see you all tomorrow'));
    assert.equal((await list()).events.length, before + 1);
  });

  it('historical messages are not processed', async () => {
    const before = (await list()).events.length;
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, "Larry's BOT\nTotal In adjusted by -9.00$", { date: now() - 3600 }));
    assert.equal((await list()).events.length, before);
    assert.equal(srv.ledger.db.prepare('SELECT outcome FROM telegram_events ORDER BY id DESC LIMIT 1').get().outcome, 'ignored_historical');
  });

  it('staff cannot reach Admin Attention through the API', async () => {
    const id = (await list()).events[0].id;
    for (const [m, url] of [['GET', '/api/attention'], ['POST', `/api/attention/${id}/ignore`]]) {
      const r = await staff.request(m, url);
      assert.equal(r.status, 403, url);
      assert.deepEqual(Object.keys(r.json), ['error']);
    }
    assert.equal((await srv.client().get('/api/attention')).status, 401);
    assert.equal((await list()).events.find(e => e.id === id).status, 'pending');
    for (const url of ['/api/payments', '/api/cashouts', '/api/session']) {
      assert.ok(!/attention|adjusted/i.test((await staff.get(url)).text), url);
    }
  });

  it('Ignore is atomic, attributed, idempotent, and moves the event below pending ones', async () => {
    const before = await list();
    const target = before.events.find(e => e.amountCents === -800);
    const results = await Promise.all([1, 2, 3].map(() => admin.post(`/api/attention/${target.id}/ignore`)));
    assert.ok(results.every(r => r.status === 204));
    const after = await list();
    assert.equal(after.pendingCount, before.pendingCount - 1);
    const ignored = after.events.find(e => e.id === target.id);
    const adminId = srv.accounts.findByUsername('CharsiNew').id;
    assert.deepEqual([ignored.status, ignored.ignoredBy, ignored.ignoredById], ['ignored', 'CharsiNew', adminId]);
    assert.ok(ignored.ignoredAt);
    assert.equal(ignored.originalText, target.originalText, 'details preserved');
    const firstIgnoredAt = ignored.ignoredAt;
    await admin.post(`/api/attention/${target.id}/ignore`);
    assert.equal((await list()).events.find(e => e.id === target.id).ignoredAt, firstIgnoredAt, 'repeat changes nothing');
    const statuses = after.events.map(e => e.status);
    assert.deepEqual(statuses, [...statuses].sort((a, b) => (a === 'pending' ? 0 : 1) - (b === 'pending' ? 0 : 1)), 'pending above ignored');
    assert.equal((await admin.post('/api/attention/att-999999/ignore')).status, 404);
    const audits = srv.accounts.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'attention_ignored'").get().n;
    assert.equal(audits, 1, 'one audit entry despite repeats');
  });

  it('attention events never change any calculation or settlement', async () => {
    const snapshot = async () => JSON.stringify([(await admin.get('/api/calculations')).json, (await admin.get('/api/settlements')).json]);
    const before = await snapshot();
    await srv.telegram.handleUpdate(msg(CHATS.venmoIn, "Larry's BOT\nTotal In adjusted by -500.00$"));
    await srv.telegram.handleUpdate(msg(CHATS.chimeIn, "Larry's BOT\nTotal Out adjusted by +250.00$"));
    for (const e of (await list()).events.filter(x => x.status === 'pending')) await admin.post(`/api/attention/${e.id}/ignore`);
    assert.equal(await snapshot(), before);
    // Demo reset never deletes attention events.
    const count = (await list()).events.length;
    await admin.post('/api/demo/reset');
    assert.equal((await list()).events.length, count);
  });
});

describe('Admin Attention: persistence', () => {
  it('pending and ignored events survive a server restart', async () => {
    const tg = await startMockTelegram(TOKEN);
    let srv = await startServer(env(tg.base));
    const reuse = { dataDir: srv.dataDir, adminPassword: srv.adminPassword };
    try {
      await srv.telegram.init();
      await srv.telegram.handleUpdate(msg(CHATS.chimeIn, "Larry's BOT\nTotal In adjusted by -8.00$"));
      await srv.telegram.handleUpdate(msg(CHATS.venmoIn, "Larry's BOT\nTotal Out adjusted by 2.00$"));
      const a = srv.client();
      await a.login(srv.adminUsername, srv.adminPassword);
      const first = (await a.get('/api/attention')).json;
      await a.post(`/api/attention/${first.events.find(e => e.amountCents === -800).id}/ignore`);
      const before = (await a.get('/api/attention')).json;
      await srv.close({ keep: true });

      srv = await startServer(env(tg.base), reuse);
      const b = srv.client();
      await b.login(srv.adminUsername, srv.adminPassword);
      assert.deepEqual((await b.get('/api/attention')).json, before);
    } finally {
      await srv.close();
      await tg.close();
    }
  });
});

describe('Admin Attention: frontend', () => {
  it('nav item is admin-only and removed for staff; no browser storage', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /class="nav admin-only" data-page="attention"/);
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(js, /restricted=p=>\[[^\]]*'attention'/);
    assert.ok(!/localStorage|sessionStorage/.test(js));
  });
});
