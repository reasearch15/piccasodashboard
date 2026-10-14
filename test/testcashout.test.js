'use strict';
// Explicitly marked $0.00 TEST cash-outs: allowed only when flagged (admin),
// labelled everywhere, workflow-complete, and never part of any money figure.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { LEDGER_MIGRATIONS, openLedgerDb } = require('../server/db');
const { DemoLedger, parseCents } = require('../server/demo-ledger');

describe('$0.00 TEST cash-outs (dashboard, demo ledger)', () => {
  let srv, admin, staff;
  const list = async () => (await admin.get('/api/cashouts')).json.cashouts;
  const totals = async () => (await admin.get('/api/calculations')).json.totals;

  before(async () => {
    srv = await startServer();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'tester', password: pw });
    staff = srv.client();
    await staff.login('tester', pw);
  });
  after(() => srv.close());

  it('an explicitly marked test request with amount 0 succeeds and is labelled', async () => {
    for (const amount of ['0', '0.0', '0.00']) {
      const r = await admin.post('/api/cashouts', { method: 'Chime', name: '@test-tag', amount, test: true });
      assert.equal(r.status, 201, amount);
      const o = (await list()).find(x => x.id === r.json.id);
      assert.deepEqual([o.isTest, o.amountCents, o.status], [true, 0, 'pending']);
      assert.match(o.requestId, /^CO-\d{6}$/, 'request IDs preserved');
    }
  });

  it('normal requests keep strict validation: zero, negative and bad decimals are rejected', async () => {
    for (const amount of ['0', '0.00', '-5', '-0.01', '1.234', '1.', '.5', 'abc', '', ' ']) {
      assert.equal((await admin.post('/api/cashouts', { method: 'Chime', name: '@x', amount })).status, 400, `normal ${JSON.stringify(amount)}`);
    }
    assert.equal(parseCents('0'), null, 'parseCents stays strict');
    assert.equal(parseCents('0.01'), 1);
    assert.equal((await admin.post('/api/cashouts', { method: 'Chime', name: '@x', amount: '0.01' })).status, 201, 'smallest real amount still works');
  });

  it('a test request must be exactly $0.00, with a real boolean flag', async () => {
    for (const amount of ['5', '0.01', '-0', '00.00', '0.000', 'zero']) {
      assert.equal((await admin.post('/api/cashouts', { method: 'Venmo', name: '@x', amount, test: true })).status, 400, `test ${amount}`);
    }
    for (const test of ['true', 1, 'yes']) {
      assert.equal((await admin.post('/api/cashouts', { method: 'Venmo', name: '@x', amount: '0', test })).status, 400, `flag ${JSON.stringify(test)}`);
    }
    assert.equal((await admin.post('/api/cashouts', { method: 'PayPal', name: '@x', amount: '0', test: true })).status, 400);
    assert.equal((await admin.post('/api/cashouts', { method: 'Venmo', name: '', amount: '0', test: true })).status, 400);
  });

  it('only admins can create test requests; staff cash-outs are unchanged', async () => {
    assert.equal((await staff.post('/api/cashouts', { method: 'Chime', name: '@x', amount: '0', test: true })).status, 403);
    assert.equal((await staff.post('/api/cashouts', { method: 'Chime', name: '@x', amount: '12.50' })).status, 201);
  });

  it('completed test requests never touch totals or settlement records; real ones still do', async () => {
    const before = await totals();
    const t = (await admin.post('/api/cashouts', { method: 'Venmo', name: '@test-done', amount: '0', test: true })).json.id;
    assert.equal((await admin.post(`/api/cashouts/${t}/complete`)).status, 204, 'normal completion workflow (demo)');
    assert.deepEqual(await totals(), before, 'TEST completion changes nothing');
    const real = (await admin.post('/api/cashouts', { method: 'Venmo', name: '@real', amount: '3.00' })).json.id;
    await admin.post(`/api/cashouts/${real}/complete`);
    const after = await totals();
    assert.equal(after.Venmo.completedOut, before.Venmo.completedOut + 300);
    // Settle Venmo: the record lists the real cash-out and never the test one.
    const p = (await admin.get('/api/payments')).json.payments.find(x => x.method === 'Venmo' && x.status === 'accepted' && !x.settled);
    const r = await admin.post('/api/settlements', { paymentId: p.id });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const ids = r.json.settlement.cashouts.map(c => c.id);
    assert.ok(ids.includes(real));
    assert.ok(!ids.includes(t), 'test request is not in the settlement record');
    const rows = await list();
    assert.deepEqual([rows.find(x => x.id === t).settled, rows.find(x => x.id === real).settled], [false, true]);
    assert.equal(srv.ledger.getCashout(t).settlementId, null);
  });

  it('cancelling a test request works like any other (admin only)', async () => {
    const t = (await admin.post('/api/cashouts', { method: 'Chime', name: '@test-cancel', amount: '0', test: true })).json.id;
    assert.equal((await staff.post(`/api/cashouts/${t}/cancel`)).status, 403);
    assert.equal((await admin.post(`/api/cashouts/${t}/cancel`)).status, 204);
    assert.equal((await list()).find(x => x.id === t).status, 'cancelled');
  });

  it('the dashboard renders the TEST — $0.00 label and admin-only form option', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(js, /o\.isTest\?'TEST — \$0\.00':money\(o\.amountCents\)/);
    assert.match(js, /test-pill">TEST — \$0\.00/);
    assert.match(js, /\$\{admin\(\)\?'<label><input id="test-cashout"/);
    assert.doesNotMatch(js, /Send to Telegram|queuedelivery/);
  });
});

describe('$0.00 TEST cash-outs through the Telegram workflow (mocked)', () => {
  const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
  const CH = { chimeIn: '-1003000000001', venmoIn: '-1003000000002', chimeOut: '-1003000000003', venmoOut: '-1003000000004' };
  let tg, srv, admin;
  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer({
      PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: TOKEN, PICASSO_TELEGRAM_API_BASE: tg.base,
      PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CH.chimeIn, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: CH.venmoIn,
      PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: CH.chimeOut, PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: CH.venmoOut,
      PICASSO_TELEGRAM_COMPLETER_IDS: '111', PICASSO_VENMO_PARSER: 'provisional',
    });
    await srv.telegram.init();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
  });
  after(async () => { await srv.close(); await tg.close(); });

  it('never sends a TEST request to Telegram and never counts it', async () => {
    const before = (await admin.get('/api/calculations')).json.totals;
    const sendsBefore = tg.callsOf('sendMessage').length;
    const id = (await admin.post('/api/cashouts', { method: 'Chime', name: '@test-tg', amount: '0.00', test: true })).json.id;
    await srv.telegram.processOutbox();
    const o = srv.ledger.getCashout(id);
    assert.equal(o.deliveryStatus, 'not_required');
    assert.equal(o.callbackToken, null);
    assert.equal(tg.callsOf('sendMessage').length, sendsBefore);
    assert.equal((await admin.get('/api/cashouts')).json.cashouts.find(x => x.id === id).deliveryStatus, null);
    assert.deepEqual((await admin.get('/api/calculations')).json.totals, before);
  });

  it('a real request still shows its real amount (unchanged format)', async () => {
    await admin.post('/api/cashouts', { method: 'Venmo', name: '@real-tg', amount: '7.25' });
    await srv.telegram.processOutbox();
    const text = tg.callsOf('sendMessage').at(-1).params.text;
    assert.ok(!/TEST/.test(text));
    assert.match(text, /^PICASSO CASH OUT\nMethod: Venmo\nRecipient: @real-tg\nAmount: \$7\.25\n/);
  });
});

describe('Ledger migration v6 (table rebuild for TEST cash-outs)', () => {
  it('keeps every existing cash-out, column value and index; enforces the new rule in the database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picasso-v6-'));
    try {
      // Build a v5 production-shaped ledger with real data.
      const v5 = new DatabaseSync(path.join(dir, 'ledger.db'));
      v5.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      LEDGER_MIGRATIONS.slice(0, 5).forEach((sql, i) => { v5.exec(sql); v5.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, 'x'); });
      const START = '2026-10-13T00:00:00+05:45';
      // Rows written with v5-era SQL (the current code already knows is_test).
      v5.prepare(`INSERT INTO demo_cashouts (id, method, name, amount_cents, status, created_at, created_by_id, created_by, completed_at,
                    completed_by, request_no, delivery_status, delivery_attempts, delivered_at, telegram_chat_id, telegram_message_id,
                    callback_token, completed_via, completed_by_telegram_id)
                  VALUES ('out-1', 'Chime', '@a', 500, 'done', 't0', 'u1', 'CharsiNew', 't1', 'T', 1, 'sent', 1, 't0', '-1', 54,
                    'aaaabbbbccccddddeeeeffff00001111', 'telegram', '9')`).run();
      v5.prepare(`INSERT INTO demo_cashouts (id, method, name, amount_cents, status, created_at, created_by_id, created_by, cancelled_at,
                    cancelled_by, request_no, telegram_chat_id, telegram_message_id, telegram_delete_status, telegram_deleted_at)
                  VALUES ('out-2', 'Venmo', '@b', 250, 'cancelled', 't2', 'u1', 'CharsiNew', 't3', 'CharsiNew', 2, '-1', 55, 'deleted', 't4')`).run();
      v5.prepare(`INSERT INTO demo_cashouts (id, method, name, amount_cents, status, created_at, request_no) VALUES ('out-3', 'Chime', '@c', 1, 'pending', 't5', 3)`).run();
      const before = v5.prepare('SELECT * FROM demo_cashouts ORDER BY rowid').all();
      v5.close();

      const db = openLedgerDb(dir, 'production');
      assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, LEDGER_MIGRATIONS.length);
      const after = db.prepare('SELECT * FROM demo_cashouts ORDER BY rowid').all();
      assert.deepEqual(after.map(({ is_test, ...r }) => r), before.map(r => ({ ...r })), 'every column of every row unchanged');
      assert.ok(after.every(r => r.is_test === 0));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'demo_cashouts' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
      assert.deepEqual(idx, ['demo_cashouts_callback', 'demo_cashouts_request_no']);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'demo_cashouts_v6'").get().n, 0);
      const l2 = new DemoLedger(db, { mode: 'production', paymentStartMs: Date.parse(START), paymentStartRaw: START });
      const t = l2.calculations();
      assert.deepEqual([t.Chime.completedOut, t.Venmo.completedOut, t.Chime.runningOut], [500, 0, 500], 'existing completed cash-out still counted exactly once');
      // The database itself refuses: $0 real, non-zero test, and duplicate request numbers.
      const ins = db.prepare("INSERT INTO demo_cashouts (id, method, name, amount_cents, status, created_at, is_test, request_no) VALUES (?, 'Chime', 'x', ?, 'pending', 'now', ?, ?)");
      assert.throws(() => ins.run('r0', 0, 0, 900), /CHECK/);
      assert.throws(() => ins.run('t5', 500, 1, 901), /CHECK/);
      assert.throws(() => ins.run('dup', 100, 0, after[0].request_no), /UNIQUE/);
      ins.run('t0', 0, 1, 902);
      db.close();
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  });
});
