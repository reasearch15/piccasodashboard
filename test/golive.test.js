'use strict';
// Go-live safety tests: production ledger, the 13 Oct 2026 (Asia/Kathmandu)
// activation boundary, Venmo review-only, backfill preview/apply. Synthetic
// group IDs and messages only; Telegram is a local mock.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { loadConfig } = require('../server/config');
const { openLedgerDb } = require('../server/db');
const { DemoLedger } = require('../server/demo-ledger');
const { previewBackfill, applyBackfill } = require('../server/telegram/backfill');

const BOUNDARY = '2026-10-13T00:00:00+05:45';
const BOUNDARY_S = Date.parse(BOUNDARY) / 1000; // 2026-10-12T18:15:00Z
const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
const SECRET = crypto.randomBytes(32).toString('base64url');
const CHIME = '-5000000201', VENMO = '-5000000202';
const env = base => ({
  PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: BOUNDARY,
  PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: TOKEN, PICASSO_TELEGRAM_API_BASE: base,
  PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHIME, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: VENMO,
  PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: '-5000000203', PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: '-5000000204',
  PICASSO_TELEGRAM_COMPLETER_IDS: '1', PICASSO_LISTENER_INGEST_SECRET: SECRET, PICASSO_PAYMENT_SOURCE_SENDER_IDS: '777000111',
});
const chime = (sender, amount, tag = 'Synthetic-Payee-1') =>
  ['\u{1F7E2} Hi $' + tag + ',', 'You received $' + amount + ' from ' + sender + '.', '08:39 PM - 14 Oct 2026', '➕ Total In: 15.00$', '➖ Total Out: 0.00$'].join('\n');
const at = iso => Math.floor(Date.parse(iso) / 1000);
let mid = 9000;

describe('Go-live safeguards (production ledger, activation boundary)', () => {
  let tg, srv, admin, staff, reuse;
  const ingest = body => fetch(`${srv.base}/api/ingest/telegram-message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET }, body: JSON.stringify({ senderId: 777000111, ...body }),
  }).then(r => r.json());
  const names = () => srv.ledger.listPayments().map(p => p.name);
  const login = async () => {
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
  };

  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer(env(tg.base));
    reuse = { dataDir: srv.dataDir, adminPassword: srv.adminPassword };
    await srv.telegram.init();
    await login();
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'pat', password: pw });
    staff = srv.client();
    await staff.login('pat', pw);
  });
  after(async () => { await srv.close(); await tg.close(); });

  it('12a. production ledger is a separate, unseeded file; demo data is absent', async () => {
    assert.ok(fs.existsSync(path.join(srv.dataDir, 'ledger.db')));
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'demo-ledger.db')));
    assert.deepEqual(srv.ledger.listPayments(), []);
    assert.equal(srv.ledger.state().settlements.length, 0);
    assert.equal(srv.ledger.meta('ledger_kind'), 'production');
    assert.equal(srv.ledger.meta('payment_start_at'), BOUNDARY);
    assert.equal((await admin.post('/api/demo/reset')).status, 403, 'production can never be reset');
    assert.equal((await admin.get('/api/session')).json.dataMode, 'production');
  });

  it('1/2/3/4. boundary: before excluded, exactly-at and after included (absolute time, not strings)', () => {
    const msgs = [
      { label: 'Oct 12 Nepal noon', date: at('2026-10-12T12:00:00+05:45') },
      { label: 'one second early', date: BOUNDARY_S - 1 },
      { label: 'exactly at boundary', date: BOUNDARY_S },
      { label: 'Oct 13 00:00 UTC', date: at('2026-10-13T00:00:00Z') },
      { label: 'Oct 12 23:00 UTC', date: at('2026-10-12T23:00:00Z') },
      { label: 'Oct 12 18:00 UTC', date: at('2026-10-12T18:00:00Z') },
      { label: 'Oct 14', date: at('2026-10-14T14:54:00+05:45') },
    ].map(m => ({ chatId: CHIME, senderId: 777000111, messageId: ++mid, date: m.date, text: chime(m.label.replace(/[^A-Za-z ]/g, '').trim() || 'X', '10') }));
    const p = previewBackfill(srv.ledger, srv.config.telegram, msgs);
    assert.equal(p.counts.before_cutoff, 3);
    assert.equal(p.counts.payment_candidate, 4);
    assert.equal(srv.ledger.listPayments().length, 0, 'preview writes nothing');
    applyBackfill(srv.telegram, msgs, { approvedBy: 'owner (test)' });
    assert.deepEqual(names().sort(), ['Oct UTC', 'Oct UTC', 'Oct', 'exactly at boundary'].sort());
    // 2026-10-13T00:00Z (05:45 Nepal) and 2026-10-12T23:00Z are after the boundary; 18:00Z is before it.
    assert.ok(srv.ledger.listPayments().every(p => p.status === 'pending' && !p.acceptedBy), 'never auto-accepted');
    assert.equal(srv.ledger.db.prepare("SELECT COUNT(*) n FROM telegram_events WHERE outcome = 'ignored_before_cutoff'").get().n, 3);
  });

  it('5. edits never import or change anything (even after the boundary)', async () => {
    const before = names().length;
    const old = { chatId: CHIME, messageId: ++mid, date: at('2026-10-10T10:00:00+05:45'), text: chime('Old Edited', '50'), edited: true };
    assert.deepEqual(await ingest(old), { outcome: 'ignored_edit' });
    assert.deepEqual(await ingest({ ...old, date: Math.floor(Date.now() / 1000) }), { outcome: 'ignored_edit' });
    await srv.telegram.handleUpdate({ update_id: 1, edited_message: { message_id: old.messageId, date: old.date, edit_date: Math.floor(Date.now() / 1000), chat: { id: Number(CHIME) }, text: old.text } });
    assert.equal(previewBackfill(srv.ledger, srv.config.telegram, [old]).counts.edited, 1);
    assert.equal(names().length, before);
  });

  it('6/7. a live Chime payment is parsed once; duplicates are rejected', async () => {
    const m = { chatId: CHIME, messageId: ++mid, date: Math.floor(Date.now() / 1000), text: chime('Amanda M', '14.0', 'Synthetic-Payee-2') };
    assert.deepEqual(await ingest(m), { outcome: 'created' });
    assert.deepEqual(await ingest(m), { outcome: 'duplicate' });
    const list = (await staff.get('/api/payments')).json.payments;
    assert.deepEqual([list[0].method, list[0].name, list[0].amountCents, list[0].status], ['Chime', 'Amanda M.', 1400, 'pending']);
    assert.equal(srv.ledger.db.prepare('SELECT recipient_tag FROM demo_payments WHERE source_message_id = ?').get(m.messageId).recipient_tag, '$Synthetic-Payee-2');
    assert.equal(previewBackfill(srv.ledger, srv.config.telegram, [m]).counts.duplicate, 1);
  });

  it('8. adjustments go to Admin Attention (and obey the boundary)', async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await ingest({ chatId: CHIME, messageId: ++mid, date: now, text: "Larry's BOT\nTotal In adjusted by -8.00$" })).outcome, 'created');
    const before = srv.ledger.listAttention().events.length;
    const old = [{ chatId: CHIME, senderId: 777000111, messageId: ++mid, date: BOUNDARY_S - 60, text: "Larry's BOT\nTotal Out adjusted by 5.00$" }];
    applyBackfill(srv.telegram, old, { approvedBy: 'owner (test)' });
    assert.equal(srv.ledger.listAttention().events.length, before, 'pre-boundary adjustment not captured');
    const e = (await admin.get('/api/attention')).json.events[0];
    assert.deepEqual([e.eventType, e.amountCents, e.status], ['total_in_adjustment', -800, 'pending']);
  });

  it('9. Venmo messages are held for review, never auto-parsed into payments', async () => {
    const now = Math.floor(Date.now() / 1000);
    const before = names().length;
    for (const text of ['Olivia Carter sent you $45.00', 'Olivia Carter paid you $45.00', chime('Some One', '20'), 'You have a new payment of $12']) {
      await ingest({ chatId: VENMO, messageId: ++mid, date: now, text });
    }
    assert.equal(names().length, before);
    const venmo = srv.ledger.listAttention().events.filter(e => e.method === 'Venmo');
    assert.equal(venmo.length, 4);
    assert.ok(venmo.every(e => e.amountCents === null && e.eventType === 'unrecognized_financial'), 'no amount asserted for unverified Venmo');
    await ingest({ chatId: VENMO, messageId: ++mid, date: now, text: 'thanks all' });
    assert.equal(srv.ledger.listAttention().events.filter(e => e.method === 'Venmo').length, 4, 'plain chat creates nothing');
  });

  it('11. staff cannot access Admin Attention', async () => {
    assert.equal((await staff.get('/api/attention')).status, 403);
    const id = srv.ledger.listAttention().events[0].id;
    assert.equal((await staff.post(`/api/attention/${id}/ignore`)).status, 403);
  });

  it('13. settlement calculations are unchanged on the production ledger', async () => {
    const pending = (await admin.get('/api/payments')).json.payments.filter(p => p.method === 'Chime' && p.status === 'pending');
    for (const p of pending) assert.equal((await staff.post(`/api/payments/${p.id}/accept`)).status, 204);
    const t0 = (await admin.get('/api/calculations')).json.totals;
    const accepted = pending.reduce((n, p) => n + p.amountCents, 0);
    assert.deepEqual([t0.Chime.acceptedIn, t0.Chime.running, t0.Venmo.acceptedIn], [accepted, accepted, 0]);
    const last = (await admin.get('/api/payments')).json.payments.filter(p => p.method === 'Chime' && p.status === 'accepted')[0];
    const preview = (await admin.post('/api/settlements/preview', { paymentId: last.id })).json;
    assert.equal(preview.incomingCents + 0, preview.netCents);
    assert.equal((await admin.post('/api/settlements', { paymentId: last.id })).status, 201);
    const s = (await admin.get('/api/settlements')).json.settlements;
    assert.deepEqual([s.length, s[0].number, s[0].color], [1, 1, '#3B82F6']);
    // Attention events still did not touch totals.
    assert.equal((await admin.get('/api/calculations')).json.totals.Chime.acceptedIn, accepted);
  });

  it('10. restart/reconnect never imports older payments, and history survives', async () => {
    const before = JSON.stringify([srv.ledger.listPayments(), srv.ledger.listSettlements(), srv.ledger.listAttention()]);
    await srv.close({ keep: true });
    srv = await startServer(env(tg.base), reuse);
    await srv.telegram.init();
    await login();
    // Telegram re-delivers a backlog after reconnect: older and already-seen messages.
    tg.state.updates.push(
      { update_id: 77001, message: { message_id: ++mid, date: BOUNDARY_S - 3600, chat: { id: Number(CHIME) }, from: { id: 777000111 }, text: chime('Pre Boundary', '99') } },
      { update_id: 77002, message: { message_id: ++mid, date: BOUNDARY_S + 3600, chat: { id: Number(CHIME) }, from: { id: 777000111 }, text: chime('Backlog After Boundary', '99') } },
    );
    for (const u of tg.state.updates) await srv.telegram.handleUpdate(u);
    assert.equal(JSON.stringify([srv.ledger.listPayments(), srv.ledger.listSettlements(), srv.ledger.listAttention()]), before,
      'pre-boundary is excluded and older backlog is not auto-imported (needs approved backfill)');
    const outcomes = srv.ledger.db.prepare('SELECT outcome FROM telegram_events ORDER BY id DESC LIMIT 2').all().map(r => r.outcome);
    assert.deepEqual(outcomes.sort(), ['ignored_before_cutoff', 'ignored_historical']);
  });

  it('7b. boundary is persisted: a changed PICASSO_PAYMENT_START_AT is refused', async () => {
    const dir = srv.dataDir;
    await srv.close({ keep: true });
    const cfg = loadConfig({ ...env(tg.base), PICASSO_DATA_DIR: dir, PICASSO_PAYMENT_START_AT: '2026-10-01T00:00:00+05:45' });
    const db = openLedgerDb(dir, 'production');
    try { assert.throws(() => new DemoLedger(db, { mode: 'production', paymentStartMs: cfg.paymentStartMs, paymentStartRaw: cfg.paymentStartRaw }), /cannot be changed silently/); } finally { db.close(); }
    // Same instant written in UTC is the same boundary and is accepted.
    const same = loadConfig({ ...env(tg.base), PICASSO_DATA_DIR: dir, PICASSO_PAYMENT_START_AT: '2026-10-12T18:15:00Z' });
    const l = new DemoLedger(openLedgerDb(dir, 'production'), { mode: 'production', paymentStartMs: same.paymentStartMs, paymentStartRaw: same.paymentStartRaw });
    l.db.close();
    srv = await startServer(env(tg.base), reuse);
  });

  it('12b. demo and production ledgers refuse to open each other', () => {
    const db = openLedgerDb(srv.dataDir, 'production');
    try { assert.throws(() => new DemoLedger(db, { mode: 'demo' }), /production ledger; refusing to open it in demo mode/); } finally { db.close(); }
    assert.throws(() => loadConfig({ PICASSO_TELEGRAM_MODE: 'polling', ...env('https://api.telegram.org'), PICASSO_TELEGRAM_ALLOW_LIVE: 'true', PICASSO_LEDGER_MODE: 'demo' }), /requires PICASSO_LEDGER_MODE=production/);
    assert.throws(() => loadConfig({ ...env('http://127.0.0.1:9'), PICASSO_LEDGER_MODE: 'demo' }), /listener ingest requires PICASSO_LEDGER_MODE=production/);
    assert.throws(() => loadConfig({ ...env('http://127.0.0.1:9'), PICASSO_VENMO_PARSER: 'provisional' }), /not allowed in production/);
    assert.throws(() => loadConfig({ ...env('http://127.0.0.1:9'), PICASSO_PAYMENT_START_AT: '2026-10-13 00:00' }), /explicit offset/);
    assert.throws(() => loadConfig({ ...env('http://127.0.0.1:9'), PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00' }), /explicit offset/);
  });

  it('backfill apply requires a named approver', () => {
    assert.throws(() => applyBackfill(srv.telegram, [], { approvedBy: '' }), /approving owner/);
  });

  it('14. nothing in Picasso references TeleLedger or any Telethon session file', () => {
    const root = path.join(__dirname, '..');
    for (const dir of ['server', 'server/telegram', 'public']) {
      for (const f of fs.readdirSync(path.join(root, dir)).filter(f => /\.(js|html)$/.test(f))) {
        const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
        assert.ok(!/teleledger|['"`][^'"`\n]*\.session['"`]|TelegramClient/i.test(src), `${dir}/${f}`);
      }
    }
  });
});
