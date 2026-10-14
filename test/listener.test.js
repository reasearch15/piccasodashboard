'use strict';
// User-account listener input (with the StaffHelp bot OFF), sender
// verification, age limits, gap reports, and the preview -> approval -> apply
// historical import. Synthetic data only; no Telegram, no network.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { startServer, randomPassword } = require('./helpers');
const { parseExport, previewBackfill, applyBackfill, approvalToken } = require('../server/telegram/backfill');
const { TelegramBot } = require('../server/telegram/bot');

const ROOT = path.join(__dirname, '..');
const SECRET = crypto.randomBytes(32).toString('base64url');
const CHIME = '-5000000401', VENMO = '-5000000402';
const LARRY = 777000111, STAFF_USER = 555000222, STAFFHELP_BOT = 424242;
const BOUNDARY = '2026-10-13T00:00:00+05:45';
const B = Date.parse(BOUNDARY) / 1000;
const ENV = {
  PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: BOUNDARY,
  PICASSO_TELEGRAM_MODE: 'off', // the StaffHelp bot stays off
  PICASSO_LISTENER_INGEST_SECRET: SECRET,
  PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID: CHIME, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: VENMO,
  PICASSO_PAYMENT_SOURCE_SENDER_IDS: String(LARRY), PICASSO_TELEGRAM_STAFFHELP_BOT_ID: String(STAFFHELP_BOT),
};
const chime = (sender, amount, tag = 'Synthetic-Payee-4') =>
  ['\u{1F7E2} Hi $' + tag + ',', `You received $${amount} from ${sender}.`, '08:39 PM - 14 Oct 2026', '➕ Total In: 15.00$', '➖ Total Out: 0.00$'].join('\n');
const now = () => Math.floor(Date.now() / 1000);
let mid = 5000;

describe('Listener input with the StaffHelp bot off', () => {
  let srv, admin;
  const post = (p, body, headers = {}) => fetch(`${srv.base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET, ...headers }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  const msg = (extra = {}) => ({ chatId: CHIME, messageId: ++mid, date: now(), text: chime('Live Payer', '14.0'), senderId: LARRY, ...extra });
  const lastEvent = () => srv.ledger.db.prepare('SELECT outcome FROM telegram_events ORDER BY id DESC LIMIT 1').get().outcome;

  before(async () => {
    srv = await startServer(ENV);
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
  });
  after(() => srv.close());

  it('works with PICASSO_TELEGRAM_MODE=off and never contacts Telegram', async () => {
    assert.equal(srv.telegram, null, 'no StaffHelp bot');
    const r = await post('/api/ingest/telegram-message', msg());
    assert.deepEqual(r.json, { outcome: 'created' });
    const p = (await admin.get('/api/payments')).json.payments[0];
    assert.deepEqual([p.method, p.name, p.amountCents, p.status, p.acceptedBy ?? null], ['Chime', 'Live Payer', 1400, 'pending', null]);
  });

  it('authenticates every request; loopback only; no proxied requests', async () => {
    assert.equal((await post('/api/ingest/telegram-message', msg(), { 'X-Picasso-Ingest-Secret': 'x'.repeat(SECRET.length) })).status, 401);
    assert.equal((await post('/api/ingest/telegram-message', msg(), { 'X-Picasso-Ingest-Secret': '' })).status, 401);
    assert.equal((await post('/api/ingest/telegram-message', msg(), { 'X-Forwarded-For': '203.0.113.7' })).status, 403);
    assert.equal((await post('/api/ingest/telegram-message', msg(), { 'X-Real-IP': '203.0.113.7' })).status, 403);
    assert.equal((await post('/api/ingest/telegram-gap', {}, { 'X-Picasso-Ingest-Secret': 'nope' })).status, 401);
    for (const bad of [{ messageId: 0 }, { messageId: 'x' }, { chatId: 'abc' }, { senderId: 'larry' }, { text: 5 }]) {
      assert.equal((await post('/api/ingest/telegram-message', msg(bad))).status, 400, JSON.stringify(bad));
    }
  });

  it('only verified senders (Larry\'s bot) create payments; others are held for review with no amount', async () => {
    const before = srv.ledger.listPayments().length;
    await post('/api/ingest/telegram-message', msg({ senderId: STAFF_USER, text: chime('Forged Payer', '500') }));
    await post('/api/ingest/telegram-message', msg({ senderId: null, text: chime('Anonymous Payer', '500') }));
    assert.equal(srv.ledger.listPayments().length, before);
    const events = srv.ledger.listAttention().events.filter(e => e.reason === 'unverified_payment_source');
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.amountCents === null));
  });

  it('StaffHelp bot posts and cash-out messages never become payments', async () => {
    const before = srv.ledger.listPayments().length;
    await post('/api/ingest/telegram-message', msg({ senderId: STAFFHELP_BOT, text: 'PICASSO CASH OUT\nMethod: Chime\nAmount: $50.00' }));
    assert.equal(lastEvent(), 'ignored_own_message');
    for (const text of ['!! Cashout Request !!\nTag name : $abc\nAmoun : $40', 'PICASSO CASH OUT\nMethod: Venmo\nStatus: COMPLETED']) {
      await post('/api/ingest/telegram-message', msg({ senderId: LARRY, text }));
      assert.equal(lastEvent(), 'ignored_cashout_request');
    }
    assert.equal(srv.ledger.listPayments().length, before);
  });

  it('Venmo stays review-only; malformed and amount-less messages never become payments', async () => {
    const before = srv.ledger.listPayments().length;
    await post('/api/ingest/telegram-message', msg({ chatId: VENMO, text: 'Olivia Carter sent you $45.00' }));
    await post('/api/ingest/telegram-message', msg({ text: chime('No Amount', '') }));
    await post('/api/ingest/telegram-message', msg({ text: 'You received money from Someone.' }));
    await post('/api/ingest/telegram-message', msg({ text: '' }));
    assert.equal(srv.ledger.listPayments().length, before);
  });

  it('live input is bounded in age; history needs the approved import; edits never count', async () => {
    assert.deepEqual((await post('/api/ingest/telegram-message', msg({ date: now() - 13 * 3600 }))).json, { outcome: 'ignored_too_old_for_live' });
    assert.deepEqual((await post('/api/ingest/telegram-message', msg({ date: now() + 3600 }))).json, { outcome: 'rejected_future_date' });
    assert.deepEqual((await post('/api/ingest/telegram-message', msg({ edited: true }))).json, { outcome: 'ignored_edit' });
    assert.deepEqual((await post('/api/ingest/telegram-message', msg({ date: B - 60 }))).json, { outcome: 'ignored_too_old_for_live' });
  });

  it('duplicates and repeated deliveries are idempotent', async () => {
    const m = msg({ text: chime('Repeat Payer', '9') });
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push((await post('/api/ingest/telegram-message', m)).json.outcome);
    assert.deepEqual(outcomes, ['created', 'duplicate', 'duplicate']);
  });

  it('gap reports land in Admin Attention (idempotent) and never block the missed messages', async () => {
    const gap = { chatId: CHIME, fromMessageId: 900, toMessageId: 950, fromDate: now() - 86400, toDate: now() - 80000, count: 51 };
    assert.deepEqual((await post('/api/ingest/telegram-gap', gap)).json, { outcome: 'created' });
    assert.deepEqual((await post('/api/ingest/telegram-gap', gap)).json, { outcome: 'duplicate' });
    const e = srv.ledger.listAttention().events.find(x => x.reason === 'ingestion_gap');
    assert.match(e.originalText, /51 message\(s\), IDs 900-950/);
    assert.equal(e.amountCents, null);
    assert.equal(srv.ledger.sourceSeen(CHIME, 900), false, 'message 900 itself can still be imported later');
    assert.equal((await post('/api/ingest/telegram-gap', { ...gap, chatId: '-1' })).status, 400);
  });

  it('never accepts, settles or touches totals on its own', async () => {
    const t = (await admin.get('/api/calculations')).json.totals;
    assert.deepEqual([t.Chime.acceptedIn, t.Chime.running, t.Venmo.acceptedIn], [0, 0, 0]);
    assert.ok(srv.ledger.listPayments().every(p => p.status === 'pending'));
    assert.deepEqual((await admin.get('/api/settlements')).json.settlements, []);
  });

  it('configuration refuses unsafe listener setups', () => {
    const { loadConfig } = require('../server/config');
    assert.throws(() => loadConfig({ ...ENV, PICASSO_PAYMENT_SOURCE_SENDER_IDS: '' }), /PICASSO_PAYMENT_SOURCE_SENDER_IDS is required/);
    assert.throws(() => loadConfig({ ...ENV, PICASSO_LEDGER_MODE: 'demo', PICASSO_PAYMENT_START_AT: '' }), /requires PICASSO_LEDGER_MODE=production/);
    assert.throws(() => loadConfig({ ...ENV, PICASSO_VENMO_PARSER: 'provisional' }), /not allowed in production/);
    assert.throws(() => loadConfig({ ...ENV, PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID: CHIME }), /different chats/);
    assert.throws(() => loadConfig({ ...ENV, PICASSO_LISTENER_MAX_AGE_HOURS: '500' }), /MAX_AGE_HOURS/);
  });
});

describe('Historical import: preview, approval, apply', () => {
  let srv, dir, exportFile;
  const exportLines = () => {
    const rows = [
      { chatId: CHIME, messageId: 10, date: B - 1, text: chime('Before Boundary', '50'), senderId: LARRY },
      { chatId: CHIME, messageId: 11, date: B, text: chime('Exactly Midnight', '14.0'), senderId: LARRY },
      { chatId: CHIME, messageId: 12, date: B + 3600, text: chime('Second Payer', '20'), senderId: LARRY },
      { chatId: CHIME, messageId: 13, date: B + 7200, text: '!! Cashout Request !!\nTag name : $x\nAmoun : $5', senderId: STAFF_USER },
      { chatId: CHIME, messageId: 14, date: B + 7300, text: "Larry's BOT\nTotal In adjusted by -8.00$", senderId: LARRY },
      { chatId: CHIME, messageId: 15, date: B + 7400, text: chime('Forged', '999'), senderId: STAFF_USER },
      { chatId: CHIME, messageId: 16, date: B + 7500, text: 'good morning', senderId: STAFF_USER },
      { chatId: CHIME, messageId: 17, date: B + 7600, text: chime('Edited Later', '30'), senderId: LARRY, edited: true },
      { chatId: CHIME, messageId: 12, date: B + 3600, text: chime('Second Payer', '20'), senderId: LARRY },
      { chatId: VENMO, messageId: 20, date: B + 100, text: 'Olivia Carter sent you $45.00', senderId: LARRY },
      { chatId: VENMO, messageId: 21, date: B + 200, text: 'PICASSO CASH OUT\nMethod: Venmo', senderId: STAFFHELP_BOT },
      { chatId: CHIME, messageId: 18, date: B + 86400, text: chime('Third Payer', '1,000.5'), senderId: LARRY },
    ];
    return rows.map(r => JSON.stringify(r)).join('\n') + '\n' + JSON.stringify({ _meta: { boundary: BOUNDARY, chats: { [CHIME]: { reachedBoundary: true, floodWaits: 1 }, [VENMO]: { reachedBoundary: false, oldestDate: B + 100 } } } }) + '\n';
  };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'backfill.js'), ...args], {
      env: { ...process.env, ...ENV, PICASSO_DATA_DIR: srv.dataDir, NODE_ENV: 'production' }, encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };

  before(async () => {
    srv = await startServer(ENV);
    dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'picasso-export-'));
    exportFile = path.join(dir, 'export.jsonl');
    fs.writeFileSync(exportFile, exportLines());
  });
  after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('preview is read-only and reports everything the spec asks for', () => {
    const before = JSON.stringify([srv.ledger.listPayments(), srv.ledger.listAttention()]);
    const r = cli('preview', exportFile);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.stringify([srv.ledger.listPayments(), srv.ledger.listAttention()]), before, 'nothing written');
    assert.match(r.out, /Inspected: 12/);
    assert.match(r.out, /payment_candidate: 3/);
    assert.match(r.out, /Chime: 3 payment candidate\(s\), total \$1034\.50/);
    assert.match(r.out, /cashout_excluded: 1/);
    assert.match(r.out, /staffhelp_bot: 1/);
    assert.match(r.out, /duplicate_in_export: 1/);
    assert.match(r.out, /before_cutoff: 1/);
    assert.match(r.out, /edited: 1/);
    assert.match(r.out, /adjustment: 1/);
    assert.match(r.out, /unverified_source: 1/);
    assert.match(r.out, /venmo_review: 1/);
    assert.match(r.out, /LIMITATION: chat -5000000402: oldest reachable message/);
    assert.match(r.out, /rate-limited the export 1 time/);
    assert.match(r.out, /Effect on totals: None until staff\/admin accept/);
    assert.match(r.out, /APPROVAL TOKEN: [0-9a-f]{64}/);
    const audit = fs.readFileSync(`${exportFile}.preview.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(audit.length, 12);
    const midnight = audit.find(a => a.messageId === 11);
    assert.deepEqual([midnight.decision, midnight.amountCents, midnight.date, midnight.chatId], ['payment_candidate', 1400, '2026-10-12T18:15:00.000Z', CHIME]);
    assert.ok(audit.every(a => /^[0-9a-f]{64}$/.test(a.textSha256)));
    const raw = fs.readFileSync(`${exportFile}.preview.jsonl`, 'utf8');
    assert.ok(!/Exactly Midnight|Second Payer|Olivia|good morning/.test(raw), 'no names or message text in the audit file');
    const summary = JSON.parse(fs.readFileSync(`${exportFile}.preview-summary.json`, 'utf8'));
    assert.equal(summary.byMethod.Chime.earliest, '2026-10-12T18:15:00.000Z');
    assert.equal(summary.byMethod.Chime.latest, new Date((B + 86400) * 1000).toISOString());
  });

  it('apply refuses without the matching approval token or an approver', () => {
    assert.equal(cli('apply', exportFile).code, 3);
    assert.equal(cli('apply', exportFile, '--approval', 'f'.repeat(64), '--approved-by', 'Owner').code, 3);
    const token = cli('preview', exportFile).out.match(/APPROVAL TOKEN: ([0-9a-f]{64})/)[1];
    assert.equal(cli('apply', exportFile, '--approval', token).code, 3);
    // Any change to the export invalidates the approval.
    fs.appendFileSync(exportFile, JSON.stringify({ chatId: CHIME, messageId: 99, date: B + 9000, text: chime('Sneaked In', '5'), senderId: LARRY }) + '\n');
    const r = cli('apply', exportFile, '--approval', token, '--approved-by', 'Owner');
    assert.equal(r.code, 3, r.out);
    assert.equal(srv.ledger.listPayments().length, 0, 'nothing imported');
    fs.writeFileSync(exportFile, exportLines());
  });

  it('approved apply imports exactly the previewed candidates as PENDING; re-running is a no-op', () => {
    const token = cli('preview', exportFile).out.match(/APPROVAL TOKEN: ([0-9a-f]{64})/)[1];
    const r = cli('apply', exportFile, '--approval', token, '--approved-by', 'Owner (test)');
    assert.equal(r.code, 0, r.out);
    const payments = srv.ledger.listPayments();
    assert.deepEqual(payments.map(p => p.name).sort(), ['Exactly Midnight', 'Second Payer', 'Third Payer']);
    assert.ok(payments.every(p => p.status === 'pending' && !p.acceptedBy));
    assert.deepEqual(payments.map(p => p.receivedAt).sort()[0], '2026-10-12T18:15:00.000Z', 'original Telegram time kept');
    assert.equal(srv.ledger.calculations().Chime.acceptedIn, 0, 'totals unchanged until acceptance');
    const reasons = srv.ledger.listAttention().events.map(e => e.reason).sort();
    assert.deepEqual(reasons, ['recognized_adjustment', 'unverified_payment_source', 'venmo_format_unverified']);
    const again = cli('apply', exportFile, '--approval', token, '--approved-by', 'Owner (test)');
    assert.equal(again.code, 0);
    assert.equal(srv.ledger.listPayments().length, 3);
    assert.equal(srv.ledger.listAttention().events.length, 3);
    assert.match(cli('preview', exportFile).out, /duplicate: 6/);
  });
});

describe('Import resume and overlap with live ingestion (in-process)', () => {
  let srv;
  before(async () => { srv = await startServer(ENV); });
  after(() => srv.close());

  const cfg = () => ({ ...srv.config.listener, paymentStartMs: srv.config.paymentStartMs, ownBotId: String(STAFFHELP_BOT) });
  const bot = () => { const b = new TelegramBot({ config: cfg(), ledger: srv.ledger, events: { publish() {} }, api: null }); b.botId = String(STAFFHELP_BOT); return b; };
  const rows = Array.from({ length: 10 }, (_, i) => ({ chatId: CHIME, messageId: 700 + i, date: Math.floor(Date.now() / 1000) - 3600 + i, text: chime(`Payer ${'ABCDEFGHIJ'[i]}`, String(10 + i)), senderId: LARRY }));

  it('an interrupted import resumes without duplicates', () => {
    applyBackfill(bot(), rows.slice(0, 4), { approvedBy: 'Owner' }); // "crash" after 4
    assert.equal(srv.ledger.listPayments().length, 4);
    const outcomes = applyBackfill(bot(), rows, { approvedBy: 'Owner' });
    assert.deepEqual(outcomes, { duplicate: 4, created: 6 });
    assert.equal(srv.ledger.listPayments().length, 10);
  });

  it('live delivery of a message already imported (and vice versa) is a duplicate', async () => {
    const live = { chatId: CHIME, messageId: 705, date: rows[5].date, text: rows[5].text, senderId: LARRY };
    const r = await fetch(`${srv.base}/api/ingest/telegram-message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET }, body: JSON.stringify(live) });
    assert.deepEqual(await r.json(), { outcome: 'duplicate' });
    const fresh = { chatId: CHIME, messageId: 800, date: Math.floor(Date.now() / 1000), text: chime('Live First', '3'), senderId: LARRY };
    await fetch(`${srv.base}/api/ingest/telegram-message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Picasso-Ingest-Secret': SECRET }, body: JSON.stringify(fresh) });
    assert.deepEqual(applyBackfill(bot(), [fresh], { approvedBy: 'Owner' }), { duplicate: 1 });
    const preview = previewBackfill(srv.ledger, cfg(), [...rows, fresh]);
    assert.equal(preview.counts.duplicate, 11);
    assert.equal(preview.counts.payment_candidate, 0);
  });

  it('the approval token binds the export file and the decision configuration', () => {
    const text = rows.map(r => JSON.stringify(r)).join('\n');
    const t1 = approvalToken(text, cfg());
    assert.equal(approvalToken(text, cfg()), t1);
    assert.notEqual(approvalToken(text + '\n', cfg()), t1);
    assert.notEqual(approvalToken(text, { ...cfg(), sourceSenderIds: new Set(['1']) }), t1);
    assert.notEqual(approvalToken(text, { ...cfg(), paymentStartMs: 0 }), t1);
    assert.deepEqual(parseExport(text + '\n{"_meta":{"x":1}}\n').meta, { x: 1 });
  });
});

describe('Python listener -> Node ingestion contract', () => {
  const PY = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys'], { encoding: 'utf8' }).status === 0);
  let srv;
  before(async () => { if (PY) srv = await startServer(ENV); });
  after(() => srv?.close());

  it('payloads built by the real listener code are accepted, de-duplicated and verified', { skip: !PY && 'python not available' }, async () => {
    const script = `
import json, sys
from datetime import datetime, timezone
from picasso_listener.core import message_payload
from picasso_listener.ingest import IngestClient
class M:
    def __init__(s, **k): s.__dict__.update(k)
c = IngestClient(sys.argv[1], sys.argv[2], sleep=lambda s: None)
now = datetime.now(timezone.utc)
out = []
for sender, mid in ((${LARRY}, 1), (${LARRY}, 1), (${STAFF_USER}, 2)):
    m = M(chat_id=${CHIME}, id=mid, date=now, message=sys.argv[3], sender_id=sender)
    out.append(c.post_message(message_payload(m))["outcome"])
out.append(c.post_gap({"chatId": ${CHIME}, "fromMessageId": 50, "toMessageId": 60, "fromDate": int(now.timestamp()) - 99999, "toDate": int(now.timestamp()) - 90000, "count": 11})["outcome"])
print(json.dumps(out))
`;
    // Async spawn: the server under test runs in this process and must keep serving.
    const r = await new Promise((resolve, reject) => {
      const child = spawn(PY, ['-c', script, srv.base, SECRET, chime('Contract Payer', '12.5')], { env: { ...process.env, PYTHONPATH: path.join(ROOT, 'listener') } });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject);
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), ['created', 'duplicate', 'created', 'created']);
    const p = srv.ledger.listPayments();
    assert.deepEqual(p.map(x => [x.name, x.amountCents, x.status]), [['Contract Payer', 1250, 'pending']]);
    const reasons = srv.ledger.listAttention().events.map(e => e.reason).sort();
    assert.deepEqual(reasons, ['ingestion_gap', 'unverified_payment_source']);
  });
});
