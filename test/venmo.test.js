'use strict';
// venmo-v1 parser (explicit opt-in) and the auditable reconciliation of Venmo
// notifications that previously landed in Admin Attention. Synthetic data and
// synthetic message IDs only.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, randomPassword } = require('./helpers');
const { parseVenmoMessage, parseChimeMessage, classifyMessage } = require('../server/telegram/parser');
const { loadConfig } = require('../server/config');
const { planReconciliation, applyReconciliation, parseRange } = require('../server/telegram/reconcile');
const { previewBackfill } = require('../server/telegram/backfill');

const ROOT = path.join(__dirname, '..');
const venmo = ({ greet = 'Hi @Test-Handle,', amount = '20.0', sender = 'Test Payer.', time = '09:15 AM - 15 Oct 2026', totalIn = 'Total In: 35.00$', totalOut = 'Total Out: 0.00$', extra = [] } = {}) =>
  ['\u{1F7E2} ' + greet, `You received $${amount} from ${sender}`, time, '➕ ' + totalIn, '➖ ' + totalOut, ...extra].filter(Boolean).join('\n');
const chime = (o = {}) => venmo({ greet: 'Hi $Test-Tag-1,', ...o });

describe('venmo-v1 parser', () => {
  it('parses Larry\'s multiline Venmo notification: amount only from the "You received" line', () => {
    assert.deepEqual(parseVenmoMessage(venmo()), { ok: true, name: 'Test Payer', amountCents: 2000, recipient: '@Test-Handle', parserVersion: 'venmo-v1' });
    assert.equal(parseVenmoMessage(venmo({ greet: 'Hi $Test-Tag-2,' })).recipient, '$Test-Tag-2');
    for (const [amount, cents] of [['20', 2000], ['20.0', 2000], ['20.00', 2000], ['1,250.5', 125050], ['0.99', 99]]) {
      assert.equal(parseVenmoMessage(venmo({ amount })).amountCents, cents, amount);
    }
    assert.equal(parseVenmoMessage(venmo({ totalIn: 'Total In : 9,999.00$', totalOut: 'Total Out : 123.45$' })).amountCents, 2000, 'running totals never used');
  });

  it('rejects anything ambiguous, malformed or unknown (never guesses)', () => {
    for (const [text, reason] of [
      [venmo({ extra: ['You received $5.00 from Someone Else.'] }), 'ambiguous_amount'],
      [venmo({ amount: '20.000' }), 'malformed'],
      [venmo({ amount: '-20' }), 'malformed'],
      [venmo({ amount: '0' }), 'invalid_amount'],
      [venmo({ sender: '12345' }), 'malformed'],
      [venmo({ greet: 'Hi Test Handle,' }), 'unexpected_line'],
      [venmo({ greet: 'Hello @Test-Handle,' }), 'unexpected_line'],
      [venmo({ extra: ['Payment pending review'] }), 'unexpected_line'],
      [venmo().replace(/^.*Hi.*\n/u, ''), 'missing_recipient'],
      [venmo({ amount: '999,999,999' }), 'amount_out_of_range'],
    ]) assert.equal(parseVenmoMessage(text).reason, reason, text);
  });

  it('classification: opt-in only; summaries, adjustments and cash-outs behave as before', () => {
    // Default "review": exactly what production did with these messages.
    assert.deepEqual(classifyMessage(venmo(), 'Venmo', { venmoParser: 'review' }), {
      kind: 'attention', eventType: 'unrecognized_financial', amountCents: null, reason: 'unparsed_adjustment', parserVersion: 'provisional-v1',
    });
    assert.equal(classifyMessage(venmo(), 'Venmo', { venmoParser: 'venmo-v1' }).kind, 'payment');
    const summary = ['\u{1F7E2} Hi @Test-Handle,', '09:15 AM - 15 Oct 2026', '➕ Total In: 35.00$', '➖ Total Out: 0.00$'].join('\n');
    assert.deepEqual(classifyMessage(summary, 'Venmo', { venmoParser: 'venmo-v1' }), { kind: 'none', reason: 'summary_only' });
    const adj = classifyMessage("Larry's BOT\nTotal In adjusted by -8.00$", 'Venmo', { venmoParser: 'venmo-v1' });
    assert.deepEqual([adj.kind, adj.eventType, adj.amountCents], ['attention', 'total_in_adjustment', -800]);
    assert.equal(classifyMessage('!! Cashout Request !!\nTag name : $x\nAmoun : $5', 'Venmo', { venmoParser: 'venmo-v1' }).kind, 'cashout_request');
    assert.equal(classifyMessage('PICASSO CASH OUT\nTEST REQUEST: not a real payment, do not send money\nMethod: Venmo', 'Venmo', { venmoParser: 'venmo-v1' }).kind, 'cashout_request');
    const garbled = classifyMessage(venmo({ amount: '20.000' }), 'Venmo', { venmoParser: 'venmo-v1' });
    assert.deepEqual([garbled.kind, garbled.amountCents], ['attention', null]);
    // The old single-line provisional format is NOT accepted by venmo-v1.
    assert.notEqual(classifyMessage('Olivia Carter sent you $45.00', 'Venmo', { venmoParser: 'venmo-v1' }).kind, 'payment');
  });

  it('Chime is unchanged: still $tag only, same results', () => {
    assert.deepEqual(parseChimeMessage(chime()), { ok: true, name: 'Test Payer', amountCents: 2000, recipient: '$Test-Tag-1', parserVersion: 'chime-v1' });
    assert.equal(parseChimeMessage(venmo()).reason, 'unexpected_line', 'Chime never accepts an @handle greeting');
    assert.equal(classifyMessage(chime(), 'Chime', { venmoParser: 'venmo-v1' }).kind, 'payment');
    assert.equal(classifyMessage(chime(), 'Chime', { venmoParser: 'review' }).parserVersion, 'chime-v1');
  });

  it('configuration: default stays "review"; venmo-v1 is an explicit opt-in allowed in production', () => {
    const env = {
      PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00+05:45',
      PICASSO_LISTENER_INGEST_SECRET: 'x'.repeat(40), PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: '-5000000801',
      PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: '-5000000802', PICASSO_PAYMENT_SOURCE_SENDER_IDS: '777000111',
    };
    assert.equal(loadConfig(env).listener.venmoParser, 'review');
    assert.equal(loadConfig({ ...env, PICASSO_VENMO_PARSER: 'venmo-v1' }).listener.venmoParser, 'venmo-v1');
    assert.throws(() => loadConfig({ ...env, PICASSO_VENMO_PARSER: 'provisional' }), /not allowed in production/);
    assert.throws(() => loadConfig({ ...env, PICASSO_VENMO_PARSER: 'auto' }), /review, venmo-v1 or provisional/);
  });
});

describe('Venmo reconciliation of existing Admin Attention events', () => {
  const SECRET = crypto.randomBytes(32).toString('base64url');
  const CHIME = '-5000000901', VENMO = '-5000000902';
  const LARRY = 777000111, STRANGER = 555000999;
  const FIRST = 61001, LAST = 61023; // synthetic stand-ins for the 23 real IDs
  const ENV = {
    PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00+05:45', PICASSO_TELEGRAM_MODE: 'off',
    PICASSO_LISTENER_INGEST_SECRET: SECRET, PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHIME, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: VENMO,
    PICASSO_PAYMENT_SOURCE_SENDER_IDS: String(LARRY), // PICASSO_VENMO_PARSER left at its default: review
  };
  let srv, admin, staff, dir, exportFile, base, exportRows;
  const now = Math.floor(Date.now() / 1000) - 600;
  const textFor = i => venmo({ amount: `${10 + i}.0`, sender: `Payer ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i]}.` });
  const ingest = body => fetch(`${srv.base}/api/ingest/telegram-message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET }, body: JSON.stringify(body) }).then(r => r.json());
  const cfg = () => ({ ...srv.config.listener, paymentStartMs: srv.config.paymentStartMs, ownBotId: null });
  const plan = () => planReconciliation(srv.ledger, cfg(), { chatId: VENMO, range: { from: FIRST, to: LAST }, exportMessages: exportRows, parser: 'venmo-v1' });

  before(async () => {
    srv = await startServer(ENV);
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'recon.staff', password: pw });
    staff = srv.client();
    await staff.login('recon.staff', pw);
    // Reproduce the incident: 23 Venmo notifications arrive in "review" mode.
    for (let i = 0; i < 23; i++) {
      const r = await ingest({ chatId: VENMO, messageId: FIRST + i, date: now + i, text: textFor(i), senderId: LARRY });
      assert.deepEqual(r, { outcome: 'created' });
    }
    // An admin already ignored one of them by hand.
    const ignoredId = srv.ledger.listAttention().events.find(e => e.originalText === textFor(5)).id;
    await admin.post(`/api/attention/${ignoredId}/ignore`);
    // Trusted export of the same messages, with deliberately bad evidence for some.
    exportRows = Array.from({ length: 23 }, (_, i) => ({ chatId: VENMO, messageId: FIRST + i, date: now + i, text: textFor(i), senderId: LARRY, edited: false }))
      .map((m, i) => i === 1 ? { ...m, senderId: STRANGER }                       // not Larry
        : i === 2 ? { ...m, text: m.text.replace('$12.0', '$99.0') }             // text differs from what was stored
        : i === 3 ? null                                                         // missing from export
        : i === 4 ? { ...m, edited: true }                                       // edited
        : i === 6 ? { ...m, senderId: null }                                     // anonymous
        : i === 7 ? { ...m, date: m.date + 3600 }                                // date disagrees
        : m).filter(Boolean);
    exportRows.push({ chatId: CHIME, messageId: FIRST + 8, date: now, text: textFor(8), senderId: LARRY }); // other group: ignored
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picasso-recon-'));
    exportFile = path.join(dir, 'venmo-export.jsonl');
    fs.writeFileSync(exportFile, exportRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    base = srv.ledger.listAttention().events.filter(e => e.method === 'Venmo').map(e => ({ id: e.id, text: e.originalText }));
  });
  after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reproduces the incident: all 23 are unrecognized_financial / unparsed_adjustment, no payments', () => {
    const ev = srv.ledger.listAttention().events.filter(e => e.method === 'Venmo');
    assert.equal(ev.length, 23);
    assert.ok(ev.every(e => e.eventType === 'unrecognized_financial' && e.reason === 'unparsed_adjustment' && e.amountCents === null));
    assert.equal(srv.ledger.listPayments().length, 0);
  });

  it('dry run: one decision per message, exact reasons, nothing written', () => {
    const before = JSON.stringify([srv.ledger.listPayments(), srv.ledger.listAttention()]);
    const p = plan();
    assert.equal(JSON.stringify([srv.ledger.listPayments(), srv.ledger.listAttention()]), before, 'read-only');
    const action = i => p.rows.find(r => r.messageId === FIRST + i).action;
    assert.equal(p.rows.length, 23);
    assert.equal(action(1), 'keep:sender_not_verified');
    assert.equal(action(2), 'keep:text_mismatch');
    assert.equal(action(3), 'keep:no_sender_evidence');
    assert.equal(action(4), 'keep:edited');
    assert.equal(action(5), 'keep:not_pending');
    assert.equal(action(6), 'keep:sender_not_verified');
    assert.equal(action(7), 'keep:date_mismatch');
    const converts = p.rows.filter(r => r.action === 'convert');
    assert.equal(converts.length, 16);
    assert.deepEqual(p.summary, { events: 23, convert: 16, convertTotalCents: converts.reduce((n, r) => n + r.amountCents, 0), keep: {
      'keep:sender_not_verified': 2, 'keep:text_mismatch': 1, 'keep:no_sender_evidence': 1, 'keep:edited': 1, 'keep:not_pending': 1, 'keep:date_mismatch': 1,
    } });
    const r0 = p.rows.find(r => r.messageId === FIRST);
    assert.deepEqual([r0.senderVerified, r0.exportTextMatches, r0.amountCents, r0.parserVersion], [true, true, 1000, 'venmo-v1']);
    assert.match(p.token, /^[0-9a-f]{64}$/);
  });

  it('apply requires the exact approval token and an admin', () => {
    const p = plan();
    assert.throws(() => applyReconciliation(srv.ledger, p, { approval: 'f'.repeat(64), admin: { id: 'a', username: 'CharsiNew' } }), /does not match/);
    assert.throws(() => applyReconciliation(srv.ledger, p, { approval: p.token, admin: null }), /admin account/);
    assert.equal(srv.ledger.listPayments().length, 0);
  });

  it('apply converts only verified messages into PENDING payments; evidence is kept and linked', async () => {
    const p = plan();
    const adminRow = srv.accounts.findByUsername('CharsiNew');
    const outcomes = applyReconciliation(srv.ledger, p, { approval: p.token, admin: { id: adminRow.id, username: adminRow.username } });
    assert.deepEqual(outcomes, { converted: 16 });
    const payments = srv.ledger.listPayments();
    assert.equal(payments.length, 16);
    assert.ok(payments.every(x => x.method === 'Venmo' && x.status === 'pending' && !x.acceptedBy), 'never accepted automatically');
    const row = srv.ledger.db.prepare('SELECT * FROM demo_payments WHERE source_message_id = ?').get(FIRST);
    assert.deepEqual([row.amount_cents, row.parser_version, row.source_chat_id, row.recipient_tag], [1000, 'venmo-v1', VENMO, '@Test-Handle']);
    const ev = srv.ledger.listAttention().events.find(e => e.originalText === textFor(0));
    assert.equal(row.received_at, ev.messageAt, 'original Telegram time kept');
    // Evidence: every original event still exists with unchanged text.
    const now23 = srv.ledger.listAttention().events.filter(e => e.method === 'Venmo');
    assert.equal(now23.length, 23);
    for (const b of base) assert.equal(now23.find(e => e.id === b.id).originalText, b.text);
    assert.deepEqual([ev.status, ev.resolution, ev.ignoredBy, ev.resolvedPaymentId], ['ignored', 'reconciled_to_payment', 'CharsiNew', row.id]);
    const kept = now23.filter(e => !e.resolution);
    assert.equal(kept.length, 7);
    assert.equal(kept.filter(e => e.status === 'pending').length, 6, 'unconverted ones stay pending for review');
    // Totals do not change until staff accept.
    const t = (await admin.get('/api/calculations')).json.totals;
    assert.equal(t.Venmo.acceptedIn, 0);
    assert.equal(srv.ledger.db.prepare("SELECT COUNT(*) n FROM telegram_events WHERE outcome = 'attention_reconciled'").get().n, 16);
  });

  it('no double counting: re-running, live re-delivery and later imports are all no-ops', async () => {
    const p2 = plan();
    assert.equal(p2.summary.convert, 0);
    assert.equal(p2.summary.keep['keep:already_resolved'], 16);
    assert.deepEqual(applyReconciliation(srv.ledger, p2, { approval: p2.token, admin: { id: 'x', username: 'CharsiNew' } }), {});
    assert.deepEqual(await ingest({ chatId: VENMO, messageId: FIRST, date: now, text: textFor(0), senderId: LARRY }), { outcome: 'duplicate' });
    const preview = previewBackfill(srv.ledger, { ...cfg(), venmoParser: 'venmo-v1' }, exportRows.filter(r => r.chatId === VENMO));
    assert.equal(preview.counts.payment_candidate, 0, 'an approved import can never add them again');
    // Even a direct ledger call on an already-reconciled event is refused.
    const ev = srv.ledger.listAttention().events.find(e => e.originalText === textFor(0));
    const res = srv.ledger.reconcileAttentionToPayment({ eventId: ev.id, chatId: VENMO, messageId: FIRST, parsed: { name: 'X', amountCents: 1, parserVersion: 'venmo-v1' }, admin: { id: 'x', username: 'x' } });
    assert.equal(res.outcome, 'skipped_not_pending');
    assert.equal(srv.ledger.listPayments().length, 16);
  });

  it('staff can accept a reconciled payment through the normal workflow', async () => {
    const p = srv.ledger.listPayments()[0];
    assert.equal((await staff.post(`/api/payments/${p.id}/accept`)).status, 204);
    const t = (await admin.get('/api/calculations')).json.totals;
    assert.equal(t.Venmo.acceptedIn, p.amountCents);
  });

  it('CLI: dry run prints every message and a token; apply refuses a wrong token or a non-admin', () => {
    const run = (...a) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'reconcile-attention.js'), '--export', exportFile, '--chat', VENMO, '--ids', `${FIRST}-${LAST}`, ...a],
        { env: { ...process.env, ...ENV, PICASSO_DATA_DIR: srv.dataDir }, encoding: 'utf8' });
      return { code: r.status, out: r.stdout + r.stderr };
    };
    const dry = run();
    assert.equal(dry.code, 0, dry.out);
    for (let i = 0; i < 23; i++) assert.ok(dry.out.includes(String(FIRST + i)), `row ${FIRST + i}`);
    assert.match(dry.out, /keep:already_resolved/);
    assert.match(dry.out, /APPROVAL TOKEN: [0-9a-f]{64}/);
    assert.match(dry.out, /Nothing was written/);
    const planFile = fs.readFileSync(`${exportFile}.reconcile-plan.jsonl`, 'utf8');
    assert.ok(!/Payer [A-Z]|Test-Handle/.test(planFile), 'no names or message text in the plan file');
    const token = dry.out.match(/APPROVAL TOKEN: ([0-9a-f]{64})/)[1];
    assert.equal(run('--apply', '--approval', 'f'.repeat(64), '--approved-by', 'CharsiNew').code, 3);
    assert.equal(run('--apply', '--approval', token, '--approved-by', 'recon.staff').code, 3, 'staff cannot approve');
    assert.equal(run('--apply', '--approval', token, '--approved-by', 'CharsiNew').code, 0);
    assert.equal(srv.ledger.listPayments().length, 16, 'nothing new: everything verified was already reconciled');
    assert.throws(() => parseRange('15207-15185'), /invalid/);
  });
});
