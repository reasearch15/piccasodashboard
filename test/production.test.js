'use strict';
// Clean production initialisation: empty ledger, zero balances, no demo data,
// no demo staff, data survives restarts and redeploys, modes never cross.
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, randomPassword } = require('./helpers');
const { loadConfig } = require('../server/config');
const { openLedgerDb } = require('../server/db');
const { DemoLedger } = require('../server/demo-ledger');

const PROD = { PICASSO_LEDGER_MODE: 'production', PICASSO_PAYMENT_START_AT: '2026-10-13T00:00:00+05:45' };
const DEMO_NAMES = /Larry Forkner|Kristen Huey|Michael Smith|David Wilson|Maya Chen|Noah Brooks|Olivia Carter|Ethan Reed|Sophia Patel|Marcus Lee|Ava Thompson|demo-vendor|alex45|northside-demo|sample-shop|demo-supplier|SET-DEMO-PRIOR/;
const ZERO = { acceptedIn: 0, completedOut: 0, settled: 0, totalSettlements: 0, runningIn: 0, runningOut: 0, running: 0 };

describe('Fresh production initialisation', () => {
  let srv, admin, reuse;
  const dump = async () => JSON.stringify(await Promise.all(['/api/payments', '/api/cashouts', '/api/calculations', '/api/settlements', '/api/trash', '/api/attention', '/api/staff'].map(async u => (await admin.get(u)).json)));

  before(async () => {
    srv = await startServer(PROD);
    reuse = { dataDir: srv.dataDir, adminPassword: srv.adminPassword };
    admin = srv.client();
    assert.equal((await admin.login(srv.adminUsername, srv.adminPassword)).status, 200);
  });
  after(() => srv.close());

  it('1/3/4/5. zero payments, cash-outs, settlements, trash and attention events', async () => {
    assert.deepEqual((await admin.get('/api/payments')).json.payments, []);
    assert.deepEqual((await admin.get('/api/cashouts')).json.cashouts, []);
    assert.deepEqual((await admin.get('/api/settlements')).json.settlements, []);
    assert.deepEqual((await admin.get('/api/trash')).json.payments, []);
    assert.deepEqual((await admin.get('/api/attention')).json, { pendingCount: 0, events: [] });
    for (const t of ['demo_payments', 'demo_cashouts', 'demo_settlements', 'attention_events']) {
      assert.equal(srv.ledger.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
    }
    assert.ok(!DEMO_NAMES.test(await dump()), 'no demo names anywhere');
  });

  it('2. every Venmo and Chime balance is exactly $0.00', async () => {
    const t = (await admin.get('/api/calculations')).json.totals;
    assert.deepEqual(t, { Venmo: ZERO, Chime: ZERO });
  });

  it('6/7. only the initialised admin exists: no demo staff; password stored as Argon2id only', async () => {
    assert.deepEqual((await admin.get('/api/staff')).json.staff, []);
    const users = srv.accounts.db.prepare('SELECT username, role, password_hash FROM users').all();
    assert.deepEqual(users.map(u => [u.username, u.role]), [['CharsiNew', 'admin']]);
    assert.match(users[0].password_hash, /^\$argon2id\$/);
    assert.ok(!JSON.stringify(users).includes(srv.adminPassword));
    for (const demo of ['John', 'Alex', 'Owner']) assert.equal((await srv.client().login(demo, 'anything-123')).status, 401);
  });

  it('demo reset is unavailable and the UI is labelled Live', async () => {
    assert.equal((await admin.post('/api/demo/reset')).status, 403);
    assert.equal((await admin.get('/api/session')).json.dataMode, 'production');
    assert.equal((await srv.client().get('/healthz')).status, 200);
  });

  it('8/9. real data persists across restarts and "redeploys" (re-running migrations) and is never re-seeded', async () => {
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'real.staff', password: pw });
    const cid = (await admin.post('/api/cashouts', { method: 'Chime', name: '@real', amount: '5.00' })).json.id;
    assert.equal((await admin.post(`/api/cashouts/${cid}/complete`)).status, 409, 'no manual completion in production');
    assert.ok(srv.ledger.completeCashoutFromTelegram(cid, { telegramUserId: 1, displayName: 'Authorized Completer' }));
    const before = await dump();
    for (let i = 0; i < 3; i++) {
      await srv.close({ keep: true });
      // A code update re-opens the same files and re-runs migrations.
      srv = await startServer(PROD, reuse);
      admin = srv.client();
      await admin.login(srv.adminUsername, srv.adminPassword);
      assert.equal(await dump(), before, `restart ${i + 1}`);
    }
    assert.ok(!DEMO_NAMES.test(before));
    assert.equal((await admin.get('/api/calculations')).json.totals.Chime.completedOut, 500, 'only the real completed cash-out counts');
    assert.equal(srv.ledger.db.prepare("SELECT value FROM demo_meta WHERE key = 'seeded'").get(), undefined, 'never seeded');
  });

  it('pending, cancelled and ignored items never count in totals', async () => {
    await admin.post('/api/cashouts', { method: 'Venmo', name: '@pending', amount: '7.00' });
    const c = (await admin.post('/api/cashouts', { method: 'Venmo', name: '@cancel', amount: '9.00' })).json.id;
    await admin.post(`/api/cashouts/${c}/cancel`);
    const t = (await admin.get('/api/calculations')).json.totals;
    assert.deepEqual(t.Venmo, ZERO);
    assert.equal(t.Chime.completedOut, 500);
  });
});

describe('Demo and production isolation', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picasso-iso-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('10/11. demo mode cannot open the production ledger and production cannot open the demo ledger', () => {
    const prodDb = openLedgerDb(dir, 'production');
    new DemoLedger(prodDb, { mode: 'production', paymentStartMs: Date.parse(PROD.PICASSO_PAYMENT_START_AT), paymentStartRaw: PROD.PICASSO_PAYMENT_START_AT });
    prodDb.close();
    const demoDb = openLedgerDb(dir, 'demo');
    const demo = new DemoLedger(demoDb, { mode: 'demo' });
    assert.ok(demo.state().payments.length > 0, 'demo fixtures still exist for tests');
    demoDb.close();
    // Files are distinct; each refuses the other mode.
    assert.notEqual(path.join(dir, 'ledger.db'), path.join(dir, 'demo-ledger.db'));
    for (const [file, mode] of [['ledger.db', 'demo'], ['demo-ledger.db', 'production']]) {
      const db = new DatabaseSync(path.join(dir, file));
      assert.throws(() => new DemoLedger(db, { mode }), /refusing to open it/);
      db.close();
    }
    const prod = new DatabaseSync(path.join(dir, 'ledger.db'));
    assert.equal(prod.prepare('SELECT COUNT(*) n FROM demo_payments').get().n, 0, 'demo writes never reached production');
    prod.close();
  });

  it('a production host can never fall back to demo', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /requires PICASSO_LEDGER_MODE=production/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', PICASSO_LEDGER_MODE: 'demo' }), /requires PICASSO_LEDGER_MODE=production/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', PICASSO_LEDGER_MODE: 'production' }), /PICASSO_PAYMENT_START_AT is required/);
    assert.equal(loadConfig({ NODE_ENV: 'production', ...PROD }).ledgerMode, 'production');
  });

  it('migrations insert no transactions', () => {
    const db = openLedgerDb(fs.mkdtempSync(path.join(dir, 'm-')), 'production');
    for (const t of ['demo_payments', 'demo_cashouts', 'demo_settlements', 'attention_events']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0);
    db.close();
  });
});

describe('GitHub readiness', () => {
  const root = path.join(__dirname, '..');
  let repo;
  const ignored = file => {
    try { execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: repo, stdio: 'ignore' }); return true; } catch { return false; }
  };
  it('.gitignore excludes secrets, databases, sessions, logs, backups and the legacy prototype', (t) => {
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const p of ['.env', 'data/', '*.db', '*.db-wal', '*.db-shm', '*.session', 'backups/', '*.log', 'node_modules/', 'legacy-static-demo/', '*.jsonl']) {
      assert.ok(gi.split(/\r?\n/).includes(p), p);
    }
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git not installed'); }
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.copyFileSync(path.join(root, '.gitignore'), path.join(repo, '.gitignore'));
    for (const f of ['.env', 'data/ledger.db', 'x/auth.db-wal', 'picasso.session', 'backups/a/ledger.db', 'legacy-static-demo/auth.js', 'export.jsonl', 'logs/app.log']) {
      assert.ok(ignored(f), `${f} should be ignored`);
    }
    for (const f of ['.env.example', 'server/app.js', 'deploy/picasso.env.example', 'deploy/picasso-dashboard.service']) {
      assert.ok(!ignored(f), `${f} should be committed`);
    }
  });
});
