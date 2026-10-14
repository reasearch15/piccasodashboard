'use strict';
// StaffHelp bot: Completed button, admin-only cancellation with Telegram
// message deletion, and shared incoming/cash-out groups. Mocked Bot API only;
// synthetic chat IDs shaped like the real basic-group IDs.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { classifyMessage, isCashoutRequest } = require('../server/telegram/parser');
const { loadTelegramConfig } = require('../server/telegram/config');

const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
const SECRET = crypto.randomBytes(32).toString('base64url');
const CHIME = '-5000000301', VENMO = '-5000000302'; // each group: incoming AND cash-out
const STAFF_TG = 501, ADMIN_TG = 502, STRANGER_TG = 999;
const BOT_ID = 424242;
const env = base => ({
  PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00+05:45',
  PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: TOKEN, PICASSO_TELEGRAM_API_BASE: base,
  PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHIME, PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: CHIME,
  PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: VENMO, PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: VENMO,
  PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS: 'true',
  PICASSO_TELEGRAM_COMPLETER_IDS: `${STAFF_TG},${ADMIN_TG}`,
  PICASSO_LISTENER_INGEST_SECRET: SECRET,
  PICASSO_PAYMENT_SOURCE_SENDER_IDS: '777000111',
});
const chimePayment = (sender, amount) =>
  ['\u{1F7E2} Hi $Synthetic-Payee-9,', `You received $${amount} from ${sender}.`, '08:39 PM - 14 Oct 2026', '➕ Total In: 15.00$', '➖ Total Out: 0.00$'].join('\n');
let updateId = 30000, mid = 3000;

describe('StaffHelp bot: completion, admin cancellation, shared groups', () => {
  let tg, srv, admin, staff;
  const now = () => Math.floor(Date.now() / 1000);
  const ingest = body => fetch(`${srv.base}/api/ingest/telegram-message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET }, body: JSON.stringify({ senderId: 777000111, ...body }),
  }).then(r => r.json());
  const view = async id => (await admin.get('/api/cashouts')).json.cashouts.find(o => o.id === id);
  const totals = async m => (await admin.get('/api/calculations')).json.totals[m];
  const newCashout = async (method = 'Chime', amount = '25.00', who = staff) => {
    const r = await who.post('/api/cashouts', { method, name: '@synthetic-tag', amount });
    assert.equal(r.status, 201);
    await srv.telegram.processOutbox();
    return srv.ledger.getCashout(r.json.id);
  };
  const press = (o, fromId, first = 'Tester') => srv.telegram.handleUpdate({
    update_id: ++updateId,
    callback_query: { id: `cq${updateId}`, data: `c:${o.callbackToken}`, from: { id: fromId, is_bot: false, first_name: first },
      message: { message_id: o.telegramMessageId, chat: { id: Number(o.telegramChatId) }, from: { id: BOT_ID, is_bot: true } } },
  });
  const deletesOf = o => tg.callsOf('deleteMessage').filter(c => c.params.message_id === o.telegramMessageId && String(c.params.chat_id) === o.telegramChatId);
  const lastEvent = () => srv.ledger.db.prepare('SELECT outcome FROM telegram_events ORDER BY id DESC LIMIT 1').get().outcome;

  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer(env(tg.base));
    await srv.telegram.init();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'helper', password: pw });
    staff = srv.client();
    await staff.login('helper', pw);
  });
  after(async () => { await srv.close(); await tg.close(); });

  it('shared groups: config accepted only with the explicit opt-in; cash-outs post to the method\'s shared group', async () => {
    const e = env('http://127.0.0.1:9');
    assert.throws(() => loadTelegramConfig({ ...e, PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS: 'false' }), /more than one role/);
    const c = await newCashout('Chime');
    const v = await newCashout('Venmo');
    assert.deepEqual([c.telegramChatId, v.telegramChatId], [CHIME, VENMO]);
  });

  it('authorized staff completes: amount counted once, attributed, message updated', async () => {
    const before = (await totals('Chime')).completedOut;
    const o = await newCashout('Chime', '40.00');
    await press(o, STAFF_TG, 'Helper');
    const done = await view(o.id);
    assert.deepEqual([done.status, done.completedBy], ['done', 'Helper']);
    assert.equal((await totals('Chime')).completedOut, before + 4000);
    await srv.telegram.processOutbox();
    const edit = tg.callsOf('editMessageText').filter(c => c.params.message_id === o.telegramMessageId).at(-1);
    assert.match(edit.params.text, /Status: COMPLETED/);
    assert.deepEqual(edit.params.reply_markup, { inline_keyboard: [] });
  });

  it('admin (Telegram ID on the allowlist) can complete too', async () => {
    const o = await newCashout('Venmo', '12.00');
    await press(o, ADMIN_TG, 'Owner');
    assert.equal((await view(o.id)).status, 'done');
  });

  it('unauthorized Telegram users cannot complete; requested amounts never count until completed', async () => {
    const before = await totals('Chime');
    const o = await newCashout('Chime', '99.00');
    assert.deepEqual(await totals('Chime'), before, 'creating a request pays nothing');
    await press(o, STRANGER_TG);
    assert.equal(lastEvent(), 'rejected_unauthorized_user');
    assert.equal((await view(o.id)).status, 'pending');
    assert.deepEqual(await totals('Chime'), before);
  });

  it('duplicate button presses complete once and count once', async () => {
    const before = (await totals('Chime')).completedOut;
    const o = await newCashout('Chime', '7.00');
    await Promise.all([press(o, STAFF_TG), press(o, STAFF_TG), press(o, ADMIN_TG)]);
    assert.equal((await totals('Chime')).completedOut, before + 700);
    const n = srv.ledger.db.prepare("SELECT COUNT(*) n FROM telegram_events WHERE ref_id = ? AND outcome = 'cashout_completed'").get(o.id).n;
    assert.equal(n, 1);
  });

  it('admin cancels: recorded, audited, Telegram message deleted (confirmed), never counted', async () => {
    const before = (await totals('Chime')).completedOut;
    const o = await newCashout('Chime', '30.00');
    assert.equal((await admin.post(`/api/cashouts/${o.id}/cancel`)).status, 204);
    let v = await view(o.id);
    assert.deepEqual([v.status, v.cancelledBy, v.telegramRemoval], ['cancelled', 'CharsiNew', 'pending'], 'not claimed removed before Telegram confirms');
    await srv.telegram.processOutbox();
    assert.equal(deletesOf(o).length, 1);
    v = await view(o.id);
    assert.equal(v.telegramRemoval, 'removed');
    assert.equal((await totals('Chime')).completedOut, before, 'cancelled amount never counted');
    const row = srv.ledger.db.prepare('SELECT telegram_delete_status, telegram_deleted_at FROM demo_cashouts WHERE id = ?').get(o.id);
    assert.equal(row.telegram_delete_status, 'deleted');
    assert.ok(row.telegram_deleted_at);
    assert.equal(srv.accounts.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'cashout_cancelled' AND target_id = ?").get(o.id).n, 1);
    // The deleted request's button can no longer complete it.
    await press(o, STAFF_TG);
    assert.equal((await view(o.id)).status, 'cancelled');
  });

  it('staff can never cancel (server-side), and nothing is deleted', async () => {
    const o = await newCashout('Venmo', '15.00');
    const r = await staff.post(`/api/cashouts/${o.id}/cancel`);
    assert.equal(r.status, 403);
    await srv.telegram.processOutbox();
    assert.equal((await view(o.id)).status, 'pending');
    assert.equal(deletesOf(o).length, 0);
  });

  it('repeated cancellation: one state change, one deletion, one audit entry', async () => {
    const o = await newCashout('Chime', '8.00');
    const results = await Promise.all([1, 2, 3].map(() => admin.post(`/api/cashouts/${o.id}/cancel`)));
    assert.deepEqual(results.map(r => r.status).sort(), [204, 409, 409]);
    await srv.telegram.processOutbox();
    await srv.telegram.processOutbox();
    assert.equal(deletesOf(o).length, 1);
    assert.equal(srv.accounts.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'cashout_cancelled' AND target_id = ?").get(o.id).n, 1);
  });

  it('completed requests cannot be cancelled or reversed', async () => {
    const before = (await totals('Venmo')).completedOut;
    const o = await newCashout('Venmo', '5.00');
    await press(o, STAFF_TG);
    assert.equal((await admin.post(`/api/cashouts/${o.id}/cancel`)).status, 409);
    await srv.telegram.processOutbox();
    assert.equal((await view(o.id)).status, 'done');
    assert.equal((await totals('Venmo')).completedOut, before + 500);
    assert.equal(deletesOf(o).length, 0, 'completed messages are never deleted');
  });

  it('cancel vs complete race: exactly one wins; delete only when cancel wins', async () => {
    for (let i = 0; i < 6; i++) {
      const o = await newCashout(i % 2 ? 'Venmo' : 'Chime', '3.00');
      const before = (await totals(o.method)).completedOut;
      const [cancel] = await Promise.all([admin.post(`/api/cashouts/${o.id}/cancel`), press(o, STAFF_TG)]);
      await srv.telegram.processOutbox();
      const v = await view(o.id);
      const delta = (await totals(o.method)).completedOut - before;
      if (v.status === 'cancelled') {
        assert.deepEqual([cancel.status, delta, deletesOf(o).length], [204, 0, 1]);
      } else {
        assert.deepEqual([v.status, cancel.status, delta, deletesOf(o).length], ['done', 409, 300, 0]);
      }
    }
  });

  it('temporary deletion failure retries; nothing is claimed until confirmed; money untouched', async () => {
    const before = await totals('Chime');
    const o = await newCashout('Chime', '11.00');
    await admin.post(`/api/cashouts/${o.id}/cancel`);
    tg.state.fail.deleteMessage = 2;
    tg.state.failWith.deleteMessage = { status: 502, description: 'Bad Gateway' };
    for (let i = 0; i < 2; i++) {
      await srv.telegram.processOutbox();
      assert.equal((await view(o.id)).telegramRemoval, 'pending');
      assert.equal(lastEvent(), 'cashout_message_delete_retry');
      srv.ledger.db.prepare('UPDATE demo_cashouts SET telegram_delete_next_at = 0 WHERE id = ?').run(o.id);
    }
    await srv.telegram.processOutbox();
    assert.equal((await view(o.id)).telegramRemoval, 'removed');
    assert.equal((await view(o.id)).status, 'cancelled');
    assert.deepEqual(await totals('Chime'), before);
    delete tg.state.failWith.deleteMessage;
  });

  it('permanent deletion refusal is visible, falls back to a CANCELLED edit, and is retryable by admin only', async () => {
    const o = await newCashout('Venmo', '6.00');
    await admin.post(`/api/cashouts/${o.id}/cancel`);
    tg.state.fail.deleteMessage = 1;
    tg.state.failWith.deleteMessage = { status: 400, description: "Bad Request: message can't be deleted for everyone" };
    tg.state.calls.length = 0;
    await srv.telegram.processOutbox();
    let v = await view(o.id);
    assert.deepEqual([v.status, v.telegramRemoval], ['cancelled', 'failed']);
    assert.equal(lastEvent(), 'cashout_message_delete_failed');
    assert.ok(!JSON.stringify(v).includes("can't be deleted"), 'no Telegram error text on the dashboard');
    // The message is neutralised so nobody pays a cancelled request.
    const edit = tg.callsOf('editMessageText').find(c => c.params.message_id === o.telegramMessageId);
    assert.match(edit.params.text, /Status: CANCELLED/);
    assert.deepEqual(edit.params.reply_markup, { inline_keyboard: [] });
    assert.equal((await staff.post(`/api/cashouts/${o.id}/retry-telegram-removal`)).status, 403);
    delete tg.state.failWith.deleteMessage;
    assert.equal((await admin.post(`/api/cashouts/${o.id}/retry-telegram-removal`)).status, 204);
    await srv.telegram.processOutbox();
    v = await view(o.id);
    assert.equal(v.telegramRemoval, 'removed');
    assert.equal((await admin.post(`/api/cashouts/${o.id}/retry-telegram-removal`)).status, 409, 'nothing left to retry');
  });

  it('a message already gone counts as removed only because Telegram says so', async () => {
    const o = await newCashout('Chime', '4.00');
    tg.state.deleted ??= new Set();
    tg.state.deleted.add(`${o.telegramChatId}:${o.telegramMessageId}`); // someone deleted it by hand
    await admin.post(`/api/cashouts/${o.id}/cancel`);
    await srv.telegram.processOutbox();
    assert.equal((await view(o.id)).telegramRemoval, 'removed');
    assert.equal(srv.ledger.db.prepare('SELECT telegram_delete_status s FROM demo_cashouts WHERE id = ?').get(o.id).s, 'already_absent');
  });

  it('a request cancelled before it was ever posted needs no deletion', async () => {
    const id = (await staff.post('/api/cashouts', { method: 'Chime', name: '@never-sent', amount: '2.00' })).json.id;
    await admin.post(`/api/cashouts/${id}/cancel`);
    tg.state.calls.length = 0;
    await srv.telegram.processOutbox();
    assert.equal(tg.callsOf('sendMessage').length + tg.callsOf('deleteMessage').length, 0);
    assert.equal((await view(id)).telegramRemoval, null);
  });

  it('shared groups: payments, cash-out messages and bot posts are told apart', async () => {
    const payments0 = srv.ledger.listPayments().length;
    const attention0 = srv.ledger.listAttention().events.length;
    const o = await newCashout('Chime', '50.00');
    const ownText = tg.callsOf('sendMessage').at(-1).params.text;
    // The listener relays our own bot post back from the shared group.
    assert.deepEqual(await ingest({ chatId: CHIME, messageId: ++mid, date: now(), text: ownText, senderId: BOT_ID }), { outcome: 'logged' });
    assert.equal(lastEvent(), 'ignored_own_message');
    // Even without a sender ID, the cash-out format is never a payment.
    await ingest({ chatId: CHIME, messageId: ++mid, date: now(), text: ownText });
    assert.equal(lastEvent(), 'ignored_cashout_request');
    // Staff-typed requests in the existing format (with its spelling).
    for (const text of ['!! Cashout Request !!\nTag name : $Some-Tag\nAmoun : $50', '!! Cashout Request !!\nTag name :\nAmoun :', 'Tag name : @abc\nAmount : 20$']) {
      await ingest({ chatId: VENMO, messageId: ++mid, date: now(), text });
      assert.equal(lastEvent(), 'ignored_cashout_request', text);
    }
    assert.equal(srv.ledger.listPayments().length, payments0);
    assert.equal(srv.ledger.listAttention().events.length, attention0);
    // A real Chime payment in the same group still becomes a payment.
    assert.deepEqual(await ingest({ chatId: CHIME, messageId: ++mid, date: now(), text: chimePayment('Real Payer', '14.0') }), { outcome: 'created' });
    const p = srv.ledger.listPayments()[0];
    assert.deepEqual([p.method, p.name, p.amountCents, p.status], ['Chime', 'Real Payer', 1400, 'pending']);
    assert.equal(srv.ledger.getCashout(o.id).status, 'pending', 'cash-outs unaffected');
  });

  it('classifier: cash-out formats are recognised; payments and adjustments are not cash-outs', () => {
    assert.equal(isCashoutRequest('!! Cashout Request !!\nTag name :\nAmoun :'), true);
    assert.equal(isCashoutRequest('PICASSO CASH OUT\nMethod: Chime'), true);
    assert.equal(isCashoutRequest(chimePayment('A B', '1')), false);
    assert.equal(isCashoutRequest("Larry's BOT\nTotal In adjusted by -8.00$"), false);
    assert.equal(isCashoutRequest('Amount : 5'), false, 'one field alone is not enough');
    assert.equal(classifyMessage('!! Cashout Request !!\nTag name : x\nAmoun : $5', 'Chime').kind, 'cashout_request');
  });

  it('duplicate Telegram updates and historical messages create nothing', async () => {
    const m = { chatId: CHIME, messageId: ++mid, date: now(), text: chimePayment('Once Only', '9') };
    await ingest(m);
    await ingest(m);
    assert.equal(srv.ledger.listPayments().filter(p => p.name === 'Once Only').length, 1);
    const n = srv.ledger.listPayments().length;
    await ingest({ chatId: CHIME, messageId: ++mid, date: now() - 13 * 3600, text: chimePayment('Old Backlog', '9') });
    assert.equal(lastEvent(), 'ignored_too_old_for_live');
    assert.equal(srv.ledger.listPayments().length, n);
  });
});
