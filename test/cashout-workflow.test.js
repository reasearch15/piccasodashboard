'use strict';
// Outgoing Telegram cash-out workflow, run for BOTH a $0.00 TEST request and a
// real request: delivery, Completed button, cancellation (queued / in flight /
// delivered), message deletion and retries, stale buttons, permissions and
// idempotency. Production-shaped setup (production ledger, shared incoming and
// cash-out groups); Telegram is a local mock.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const { startServer, randomPassword } = require('./helpers');
const { startMockTelegram } = require('./mock-telegram');
const { isCashoutRequest } = require('../server/telegram/parser');

const TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
const CHIME = '-5000000601', VENMO = '-5000000602'; // each: incoming AND cash-out
const COMPLETER = 701, STRANGER = 799, BOT_ID = 424242;
const ENV = base => ({
  PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00+05:45',
  PICASSO_TELEGRAM_MODE: 'polling', PICASSO_TELEGRAM_BOT_TOKEN: TOKEN, PICASSO_TELEGRAM_API_BASE: base,
  PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHIME, PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID: CHIME,
  PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: VENMO, PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID: VENMO,
  PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS: 'true', PICASSO_TELEGRAM_COMPLETER_IDS: String(COMPLETER),
});
// Each kind of request under test: how to create it and what it may change.
const KINDS = [
  { label: 'TEST $0.00', body: m => ({ method: m, name: '@workflow-test', amount: '0.00', test: true }), cents: 0, isTest: true },
  { label: 'real', body: m => ({ method: m, name: '@workflow-real', amount: '12.34' }), cents: 1234, isTest: false },
];
let updateId = 90000;

describe('Outgoing cash-out workflow (TEST and real)', () => {
  let tg, srv, admin, staff;
  const totals = async () => (await admin.get('/api/calculations')).json.totals;
  const view = async id => (await admin.get('/api/cashouts')).json.cashouts.find(o => o.id === id);
  const sendsTo = id => {
    const o = srv.ledger.getCashout(id);
    return tg.callsOf('sendMessage').filter(c => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `c:${o.callbackToken}`);
  };
  const deletesOf = o => tg.callsOf('deleteMessage').filter(c => c.params.message_id === o.telegramMessageId && String(c.params.chat_id) === o.telegramChatId);
  const press = (o, fromId = COMPLETER) => srv.telegram.handleUpdate({
    update_id: ++updateId,
    callback_query: { id: `cq${updateId}`, data: `c:${o.callbackToken}`, from: { id: fromId, is_bot: false, first_name: 'Ops' },
      message: { message_id: o.telegramMessageId, chat: { id: Number(o.telegramChatId) }, from: { id: BOT_ID, is_bot: true } } },
  });
  const create = async (kind, method = 'Chime', who = admin) => {
    const r = await who.post('/api/cashouts', kind.body(method));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.id;
  };
  const delivered = async (kind, method = 'Chime') => {
    const id = await create(kind, method);
    await srv.telegram.processOutbox();
    return srv.ledger.getCashout(id);
  };
  const audits = (action, id) => srv.accounts.db.prepare('SELECT COUNT(*) n FROM audit_log WHERE action = ? AND target_id = ?').get(action, id).n;

  before(async () => {
    tg = await startMockTelegram(TOKEN);
    srv = await startServer(ENV(tg.base));
    await srv.telegram.init();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'workflow.staff', password: pw });
    staff = srv.client();
    await staff.login('workflow.staff', pw);
  });
  after(async () => { await srv.close(); await tg.close(); });

  for (const kind of KINDS) {
    describe(kind.label, () => {
      it('is delivered once to the correct shared group, correctly labelled, and tracked', async () => {
        for (const [method, chat] of [['Chime', CHIME], ['Venmo', VENMO]]) {
          const id = await create(kind, method);
          assert.equal((await view(id)).deliveryStatus, 'pending');
          await srv.telegram.processOutbox();
          await srv.telegram.processOutbox(); // a second pass must not resend
          const sends = sendsTo(id);
          assert.equal(sends.length, 1);
          assert.equal(String(sends[0].params.chat_id), chat);
          const text = sends[0].params.text;
          assert.ok(text.startsWith('PICASSO CASH OUT\n'));
          assert.ok(isCashoutRequest(text), 'never read back as a payment in the shared group');
          if (kind.isTest) {
            assert.match(text, /\nTEST REQUEST: not a real payment, do not send money\n/);
            assert.match(text, /\nAmount: TEST — \$0\.00\n/);
          } else {
            assert.ok(!/TEST/.test(text));
            assert.match(text, /\nAmount: \$12\.34\n/);
          }
          const v = await view(id);
          assert.deepEqual([v.deliveryStatus, v.isTest, v.amountCents], ['delivered', kind.isTest, kind.cents]);
          assert.match(v.requestId, /^CO-\d{6}$/);
        }
      });

      it('Completed button: allowlisted user completes once; strangers rejected; message updated', async () => {
        const before = await totals();
        const o = await delivered(kind);
        await press(o, STRANGER);
        assert.equal((await view(o.id)).status, 'pending', 'stranger rejected');
        await Promise.all([press(o), press(o), press(o)]);
        assert.equal((await view(o.id)).status, 'done');
        const done = srv.ledger.db.prepare("SELECT COUNT(*) n FROM telegram_events WHERE ref_id = ? AND outcome = 'cashout_completed'").get(o.id).n;
        assert.equal(done, 1, 'exactly one completion');
        await srv.telegram.processOutbox();
        const edit = tg.callsOf('editMessageText').filter(c => c.params.message_id === o.telegramMessageId).at(-1).params;
        assert.match(edit.text, /Status: COMPLETED/);
        if (kind.isTest) assert.match(edit.text, /Amount: TEST — \$0\.00/);
        assert.deepEqual(edit.reply_markup, { inline_keyboard: [] }, 'button removed');
        const after = await totals();
        assert.equal(after.Chime.completedOut - before.Chime.completedOut, kind.isTest ? 0 : kind.cents);
        assert.equal((await admin.post(`/api/cashouts/${o.id}/cancel`)).status, 409, 'completed cannot be cancelled');
        assert.equal(deletesOf(o).length, 0, 'completed messages are never deleted');
      });

      it('cancelling a queued request means it is never sent, even after retries or a restart', async () => {
        const id = await create(kind);
        assert.equal((await admin.post(`/api/cashouts/${id}/cancel`)).status, 204);
        srv.ledger.recoverInterruptedDeliveries();
        for (let i = 0; i < 3; i++) await srv.telegram.processOutbox();
        assert.equal(sendsTo(id).length, 0);
        const v = await view(id);
        assert.deepEqual([v.status, v.deliveryStatus, v.telegramRemoval], ['cancelled', null, null]);
      });

      it('cancelling while the send is in flight deletes the message as soon as it exists', async () => {
        const id = await create(kind);
        tg.state.delayMs.sendMessage = 150;
        const outbox = srv.telegram.processOutbox();
        await new Promise(r => setTimeout(r, 40)); // the send is now in flight
        assert.equal(srv.ledger.db.prepare('SELECT delivery_status s FROM demo_cashouts WHERE id = ?').get(id).s, 'sending');
        assert.equal((await admin.post(`/api/cashouts/${id}/cancel`)).status, 204);
        await outbox;
        delete tg.state.delayMs.sendMessage;
        await srv.telegram.processOutbox();
        const o = srv.ledger.getCashout(id);
        assert.equal(sendsTo(id).length, 1);
        assert.equal(deletesOf(o).length, 1, 'late message deleted');
        assert.equal((await view(id)).telegramRemoval, 'removed');
      });

      it('cancelling a delivered request deletes its message once; repeats change nothing', async () => {
        const before = await totals();
        const o = await delivered(kind);
        const results = await Promise.all([1, 2, 3].map(() => admin.post(`/api/cashouts/${o.id}/cancel`)));
        assert.deepEqual(results.map(r => r.status).sort(), [204, 409, 409]);
        assert.equal((await view(o.id)).telegramRemoval, 'pending', 'not claimed removed before Telegram confirms');
        await srv.telegram.processOutbox();
        await srv.telegram.processOutbox();
        assert.equal(deletesOf(o).length, 1);
        const v = await view(o.id);
        assert.deepEqual([v.status, v.telegramRemoval, v.cancelledBy], ['cancelled', 'removed', 'CharsiNew']);
        assert.equal(audits('cashout_cancelled', o.id), 1);
        assert.deepEqual(await totals(), before);
      });

      it('staff can never cancel; nothing is deleted', async () => {
        const o = await delivered(kind);
        assert.equal((await staff.post(`/api/cashouts/${o.id}/cancel`)).status, 403);
        await srv.telegram.processOutbox();
        assert.equal((await view(o.id)).status, 'pending');
        assert.equal(deletesOf(o).length, 0);
      });

      it('stale Completed button on a cancelled request is rejected and changes nothing', async () => {
        const before = await totals();
        const o = await delivered(kind);
        await admin.post(`/api/cashouts/${o.id}/cancel`);
        await press(o);
        await press(o);
        const v = await view(o.id);
        assert.equal(v.status, 'cancelled');
        const outcomes = srv.ledger.db.prepare('SELECT outcome FROM telegram_events WHERE ref_id = ? AND kind = ?').all(o.id, 'callback').map(r => r.outcome);
        assert.deepEqual(outcomes, ['rejected_cancelled', 'rejected_cancelled']);
        assert.deepEqual(await totals(), before);
        const answers = tg.callsOf('answerCallbackQuery').slice(-2).map(c => c.params.text);
        assert.deepEqual(answers, ['This request was cancelled.', 'This request was cancelled.']);
      });

      it('temporary deletion failure retries and is never reported as removed until confirmed', async () => {
        const o = await delivered(kind);
        await admin.post(`/api/cashouts/${o.id}/cancel`);
        tg.state.fail.deleteMessage = 2;
        tg.state.failWith.deleteMessage = { status: 502, description: 'Bad Gateway' };
        for (let i = 0; i < 2; i++) {
          await srv.telegram.processOutbox();
          assert.equal((await view(o.id)).telegramRemoval, 'pending');
          srv.ledger.db.prepare('UPDATE demo_cashouts SET telegram_delete_next_at = 0 WHERE id = ?').run(o.id);
        }
        delete tg.state.failWith.deleteMessage;
        await srv.telegram.processOutbox();
        assert.equal((await view(o.id)).telegramRemoval, 'removed');
        assert.equal(deletesOf(o).length, 3);
      });

      it('permanent deletion refusal: visible "failed", message neutralised, admin-only retry', async () => {
        const o = await delivered(kind);
        await admin.post(`/api/cashouts/${o.id}/cancel`);
        tg.state.fail.deleteMessage = 1;
        tg.state.failWith.deleteMessage = { status: 400, description: "Bad Request: message can't be deleted for everyone" };
        await srv.telegram.processOutbox();
        delete tg.state.failWith.deleteMessage;
        let v = await view(o.id);
        assert.deepEqual([v.status, v.telegramRemoval], ['cancelled', 'failed']);
        const edit = tg.callsOf('editMessageText').filter(c => c.params.message_id === o.telegramMessageId).at(-1).params;
        assert.match(edit.text, /Status: CANCELLED/);
        if (kind.isTest) assert.match(edit.text, /TEST REQUEST/);
        assert.deepEqual(edit.reply_markup, { inline_keyboard: [] });
        assert.equal((await staff.post(`/api/cashouts/${o.id}/retry-telegram-removal`)).status, 403);
        assert.equal((await admin.post(`/api/cashouts/${o.id}/retry-telegram-removal`)).status, 204);
        assert.equal((await admin.post(`/api/cashouts/${o.id}/retry-telegram-removal`)).status, 409, 'already queued');
        await srv.telegram.processOutbox();
        v = await view(o.id);
        assert.equal(v.telegramRemoval, 'removed');
        assert.equal(audits('cashout_telegram_removal_retry', o.id), 1);
      });

      it('a message already deleted by hand counts as removed only because Telegram says so', async () => {
        const o = await delivered(kind);
        tg.state.deleted ??= new Set();
        tg.state.deleted.add(`${o.telegramChatId}:${o.telegramMessageId}`);
        await admin.post(`/api/cashouts/${o.id}/cancel`);
        await srv.telegram.processOutbox();
        assert.equal(srv.ledger.db.prepare('SELECT telegram_delete_status s FROM demo_cashouts WHERE id = ?').get(o.id).s, 'already_absent');
        assert.equal((await view(o.id)).telegramRemoval, 'removed');
      });
    });
  }

  it('settlement: completed real requests are included, completed TEST requests never are', async () => {
    // A real accepted Chime payment to settle against.
    const pay = srv.ledger.createIncomingPayment({ method: 'Chime', name: 'Settlement Payer', amountCents: 500000, receivedAt: new Date().toISOString(), chatId: CHIME, messageId: 1, parserVersion: 'chime-v1' });
    assert.equal((await staff.post(`/api/payments/${pay.id}/accept`)).status, 204);
    const t = await delivered(KINDS[0]);
    const r = await delivered(KINDS[1]);
    await press(t);
    await press(r);
    const res = await admin.post('/api/settlements', { paymentId: pay.id });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const ids = res.json.settlement.cashouts.map(c => c.id);
    assert.ok(ids.includes(r.id), 'real completed request settled');
    assert.ok(!ids.includes(t.id), 'TEST request never in a settlement record');
    const history = (await admin.get('/api/settlements')).json.settlements;
    assert.ok(!JSON.stringify(history).includes(t.id));
    const list = (await admin.get('/api/cashouts')).json.cashouts;
    assert.deepEqual([list.find(o => o.id === t.id).settled, list.find(o => o.id === r.id).settled], [false, true]);
  });

  it('only admins may create TEST requests (staff real requests still work)', async () => {
    assert.equal((await staff.post('/api/cashouts', KINDS[0].body('Chime'))).status, 403);
    assert.equal((await staff.post('/api/cashouts', KINDS[1].body('Chime'))).status, 201);
  });
});
