'use strict';
// deploy.sh in a disposable "production": bare git origin, cloned app, real
// SQLite databases created by the app's own migrations, and mock systemctl /
// curl / journalctl / npm. Nothing touches a real service, network or VPS.
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BASH = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(p => fs.existsSync(p))
  : 'bash';
const fwd = p => p.split(path.sep).join('/');
const SECRET_TOKEN = `${100000 + crypto.randomInt(800000)}:${crypto.randomBytes(27).toString('base64url')}`;
const SECRET_INGEST = crypto.randomBytes(32).toString('base64url');

function sh(cwd, cmd, env = {}) {
  const r = spawnSync(BASH, ['-c', cmd], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Store with LF, as the repository does.
  fs.writeFileSync(to, fs.readFileSync(from, 'utf8').split('\r\n').join('\n'));
};
const copyDir = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else copy(a, b);
  }
};

const MOCKS = {
  systemctl: `#!/usr/bin/env bash
echo "systemctl $*" >> "$MOCK_LOG"
case "$1" in
  cat) exit 0 ;;
  restart) head="$(git -C "$DEPLOY_APP_DIR" rev-parse HEAD)"
           if [[ -n "\${MOCK_RESTART_FAIL_REV:-}" && "$head" == "$MOCK_RESTART_FAIL_REV" ]]; then exit 1; fi; exit 0 ;;
  is-active) exit 0 ;;
  *) exit 0 ;;
esac`,
  curl: `#!/usr/bin/env bash
out=""; while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
echo "curl health" >> "$MOCK_LOG"
head="$(git -C "$DEPLOY_APP_DIR" rev-parse HEAD)"
if [[ -n "\${MOCK_HEALTH_FAIL_REV:-}" && "$head" == "$MOCK_HEALTH_FAIL_REV" ]]; then printf '{"ok":false}' > "$out"; printf 503; exit 0; fi
printf '{"ok":true}' > "$out"; printf 200`,
  journalctl: `#!/usr/bin/env bash
echo "journalctl $*" >> "$MOCK_LOG"; echo "mock journal line"`,
  npm: `#!/usr/bin/env bash
echo "npm $*" >> "$MOCK_LOG"; exit "\${MOCK_NPM_EXIT:-0}"`,
};

// Builds a fresh disposable installation at revision v1 and pushes v2 to origin.
function makeInstall({ v2Change = 'touch' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picasso-deploy-'));
  const p = name => path.join(dir, name);
  const work = p('work');
  // Repository contents: the real deploy scripts and server code.
  copy(path.join(ROOT, 'deploy.sh'), path.join(work, 'deploy.sh'));
  copy(path.join(ROOT, 'deploy', 'backup.sh'), path.join(work, 'deploy', 'backup.sh'));
  copy(path.join(ROOT, 'package.json'), path.join(work, 'package.json'));
  copy(path.join(ROOT, 'settlement-core.js'), path.join(work, 'settlement-core.js'));
  copyDir(path.join(ROOT, 'server'), path.join(work, 'server'));
  fs.writeFileSync(path.join(work, '.gitattributes'), '* text=auto eol=lf\n');
  const git = 'git -c core.autocrlf=false -c user.name=Test -c user.email=test@example.invalid';
  sh(dir, `git init -q --bare -b main origin.git`);
  sh(work, `git init -q -b main && ${git} add -A && ${git} commit -qm v1 && git remote add origin "${fwd(p('origin.git'))}" && git push -q origin main`);
  const v1 = sh(work, 'git rev-parse HEAD');
  sh(dir, `git -c core.autocrlf=false clone -q "${fwd(p('origin.git'))}" app`);

  // Production data created by the real migrations, with a few records.
  const { openLedgerDb, openAuthDb } = require('../server/db');
  const { DemoLedger } = require('../server/demo-ledger');
  fs.mkdirSync(p('data'));
  const ledgerDb = openLedgerDb(p('data'), 'production');
  const ledger = new DemoLedger(ledgerDb, { mode: 'production', paymentStartMs: Date.parse('2026-10-13T00:00:00+05:45'), paymentStartRaw: '2026-10-13T00:00:00+05:45' });
  const u = { id: 'u1', username: 'CharsiNew' };
  ledger.createIncomingPayment({ method: 'Chime', name: 'Real Payer', amountCents: 1400, receivedAt: new Date().toISOString(), chatId: '-1', messageId: 1, parserVersion: 'chime-v1' });
  ledger.acceptPayment(ledger.listPayments()[0].id, u);
  ledger.createCashout({ method: 'Venmo', name: '@payee', amount: '5' }, u);
  ledgerDb.close();
  openAuthDb(p('data')).close();

  // v2 on origin.
  if (v2Change === 'touch') fs.appendFileSync(path.join(work, 'server', 'index.js'), '\n// v2\n');
  else {
    const dbjs = path.join(work, 'server', 'db.js');
    // End of LEDGER_MIGRATIONS (its last statement).
    const anchor = "ADD COLUMN resolved_payment_id TEXT;`,\n];";
    const src = fs.readFileSync(dbjs, 'utf8');
    assert.ok(src.split(anchor).length === 2, 'migration anchor present exactly once');
    const extra = v2Change === 'additive-migration'
      ? "ADD COLUMN resolved_payment_id TEXT;`,\n  `ALTER TABLE demo_payments ADD COLUMN test_note TEXT;`,\n];"
      : "ADD COLUMN resolved_payment_id TEXT;`,\n  `UPDATE demo_cashouts SET name = name;`,\n];";
    fs.writeFileSync(dbjs, src.replace(anchor, extra));
  }
  sh(work, `${git} commit -qam v2 && git push -q origin main`);
  const v2 = sh(work, 'git rev-parse HEAD');

  fs.mkdirSync(p('mocks'));
  for (const [name, body] of Object.entries(MOCKS)) {
    fs.writeFileSync(p(`mocks/${name}`), body.replace(/\r\n/g, '\n'));
    fs.chmodSync(p(`mocks/${name}`), 0o755);
  }
  fs.writeFileSync(p('picasso.env'), [
    'NODE_ENV=production', 'PICASSO_LEDGER_MODE=production', 'PICASSO_PAYMENT_START_AT=2026-10-13T00:00:00+05:45',
    'PICASSO_HOST=127.0.0.1', 'PICASSO_PORT=3300', `PICASSO_DATA_DIR=${fwd(p('data'))}`,
    'PICASSO_TELEGRAM_MODE=off', `PICASSO_TELEGRAM_BOT_TOKEN=${SECRET_TOKEN}`, `PICASSO_LISTENER_INGEST_SECRET=${SECRET_INGEST}`, 'PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID=-5000000501', 'PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID=-5000000502', 'PICASSO_PAYMENT_SOURCE_SENDER_IDS=777000111',
    'PICASSO_COOKIE_SECURE=auto', 'PICASSO_TRUST_PROXY=true', '',
  ].join('\n'));

  const env = {
    PICASSO_DEPLOY_TEST: '1',
    DEPLOY_APP_DIR: fwd(p('app')), DEPLOY_DATA_DIR: fwd(p('data')), DEPLOY_BACKUP_ROOT: fwd(p('backups')),
    DEPLOY_ENV_FILE: fwd(p('picasso.env')), DEPLOY_LOG_DIR: fwd(p('logs')), DEPLOY_STATE_DIR: fwd(p('state')),
    DEPLOY_LOCK_DIR: fwd(p('lock')), DEPLOY_NODE_BIN: fwd(process.execPath),
    DEPLOY_NPM_BIN: fwd(p('mocks/npm')), DEPLOY_SYSTEMCTL: fwd(p('mocks/systemctl')), DEPLOY_CURL: fwd(p('mocks/curl')),
    DEPLOY_JOURNALCTL: fwd(p('mocks/journalctl')), DEPLOY_REMOTE_RE: '.*', DEPLOY_HEALTH_TRIES: '2', DEPLOY_HEALTH_DELAY: '0',
    MOCK_LOG: fwd(p('mock.log')),
  };
  const run = (args = [], extra = {}) => {
    const r = spawnSync(BASH, ['deploy.sh', ...args], { cwd: p('app'), env: { ...process.env, PICASSO_DEPLOY_SELF: '', ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const head = () => sh(p('app'), 'git rev-parse HEAD');
  const branch = () => sh(p('app'), 'git symbolic-ref --short -q HEAD || echo DETACHED');
  const mockLog = () => (fs.existsSync(p('mock.log')) ? fs.readFileSync(p('mock.log'), 'utf8') : '');
  const backups = () => (fs.existsSync(p('backups')) ? fs.readdirSync(p('backups')) : []);
  const rows = () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(p('data/ledger.db'), { readOnly: true });
    const r = ['demo_payments', 'demo_cashouts'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    db.close();
    return JSON.stringify(r);
  };
  return { dir, p, env, run, head, branch, mockLog, backups, rows, v1, v2, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('deploy.sh', { skip: !BASH && 'bash not available' }, () => {
  before(() => assert.ok(BASH, 'bash found'));

  it('dry run: read-only checks and plan; nothing changes', () => {
    const t = makeInstall();
    try {
      const rowsBefore = t.rows();
      const r = t.run(['--dry-run']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /DRY RUN/);
      assert.ok(r.out.includes(t.v1) && r.out.includes(t.v2), 'shows current and target hashes');
      assert.match(r.out, /Automatic code rollback is safe/);
      assert.match(r.out, /Configuration accepted by the current code/);
      assert.equal(t.head(), t.v1);
      assert.deepEqual(t.backups(), []);
      assert.ok(!/restart/.test(t.mockLog()));
      assert.ok(!fs.existsSync(t.p('state/deployed-revision')));
      assert.equal(t.rows(), rowsBefore);
    } finally { t.cleanup(); }
  });

  it('clean deployment: backup validated, fast-forward, restart only picasso, healthy; secrets never printed', () => {
    const t = makeInstall();
    try {
      const rowsBefore = t.rows();
      const r = t.run();
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`DEPLOYED ${t.v2}`));
      assert.equal(t.head(), t.v2);
      assert.equal(t.branch(), 'main');
      const [b] = t.backups();
      const files = fs.readdirSync(t.p(`backups/${b}`)).sort();
      assert.deepEqual(files, ['DEPLOY_INFO', 'SHA256SUMS', 'auth.db', 'ledger.db'], 'no secrets in the service-owned backup directory');
      const envBackups = fs.readdirSync(t.p('state/env-backups'));
      assert.equal(envBackups.length, 1);
      assert.equal(fs.readFileSync(t.p(`state/env-backups/${envBackups[0]}`), 'utf8'), fs.readFileSync(t.p('picasso.env'), 'utf8'));
      if (process.platform !== 'win32') assert.equal(fs.statSync(t.p(`state/env-backups/${envBackups[0]}`)).mode & 0o777, 0o600);
      for (const f of files) {
        const content = fs.readFileSync(t.p(`backups/${b}/${f}`));
        assert.ok(!content.includes(SECRET_TOKEN) && !content.includes(SECRET_INGEST), `${f} contains a secret`);
      }
      assert.match(fs.readFileSync(t.p(`backups/${b}/DEPLOY_INFO`), 'utf8'), new RegExp(`previous_revision=${t.v1}`));
      const calls = t.mockLog().split('\n').filter(l => l.startsWith('systemctl restart'));
      assert.deepEqual(calls, ['systemctl restart picasso-dashboard']);
      assert.equal(fs.readFileSync(t.p('state/deployed-revision'), 'utf8').trim(), t.v2);
      assert.equal(t.rows(), rowsBefore, 'financial records untouched');
      for (const secret of [SECRET_TOKEN, SECRET_TOKEN.split(':')[1], SECRET_INGEST]) {
        assert.ok(!r.out.includes(secret), 'secret printed');
        for (const f of fs.readdirSync(t.p('logs'))) assert.ok(!fs.readFileSync(t.p(`logs/${f}`), 'utf8').includes(secret), 'secret in log');
      }
    } finally { t.cleanup(); }
  });

  it('already up to date: health only, no backup, no restart (safe to repeat)', () => {
    const t = makeInstall();
    try {
      assert.equal(t.run().code, 0);
      const backups = t.backups().length;
      fs.writeFileSync(t.p('mock.log'), '');
      const r = t.run();
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Already up to date/);
      assert.equal(t.backups().length, backups);
      assert.ok(!/restart/.test(t.mockLog()));
    } finally { t.cleanup(); }
  });

  it('first scripted deploy when the checkout was already pulled: backs up and restarts', () => {
    const t = makeInstall();
    try {
      sh(t.p('app'), 'git pull -q --ff-only');
      const r = t.run();
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /no record of the running service/);
      assert.equal(t.backups().length, 1);
      assert.match(t.mockLog(), /systemctl restart picasso-dashboard/);
    } finally { t.cleanup(); }
  });

  it('first-run bootstrap: works when run from a copy outside the checkout (deploy.sh not yet on the VPS)', () => {
    const t = makeInstall();
    try {
      // The VPS checkout predates deploy.sh: remove it from the app checkout's
      // working tree view by running the copy fetched from origin/main instead.
      const boot = t.p('bootstrap-deploy.sh');
      fs.writeFileSync(boot, sh(t.p('app'), 'git fetch -q origin main && git show origin/main:deploy.sh'));
      const r = spawnSync(BASH, [fwd(boot), '--dry-run'], { cwd: t.dir, env: { ...process.env, PICASSO_DEPLOY_SELF: '', ...t.env }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const r2 = spawnSync(BASH, [fwd(boot)], { cwd: t.dir, env: { ...process.env, PICASSO_DEPLOY_SELF: '', ...t.env }, encoding: 'utf8' });
      assert.equal(r2.status, 0, r2.stdout + r2.stderr);
      assert.equal(t.head(), t.v2);
      assert.match(t.mockLog(), /systemctl restart picasso-dashboard/);
    } finally { t.cleanup(); }
  });

  it('incomplete listener configuration is caught before restart (code restored, nothing restarted)', () => {
    const t = makeInstall();
    try {
      const env = fs.readFileSync(t.p('picasso.env'), 'utf8');
      fs.writeFileSync(t.p('picasso.env'), env.replace('PICASSO_PAYMENT_SOURCE_SENDER_IDS=777000111\n', ''));
      const r = t.run();
      assert.equal(r.code, 8, r.out);
      assert.match(r.out, /PICASSO_PAYMENT_SOURCE_SENDER_IDS is required/);
      assert.equal(t.head(), t.v1);
      assert.ok(!/systemctl restart/.test(t.mockLog()));
    } finally { t.cleanup(); }
  });

  it('dirty working tree: refused, nothing changed, nothing reset', () => {
    const t = makeInstall();
    try {
      fs.appendFileSync(t.p('app/server/index.js'), '\n// local hotfix\n');
      const r = t.run();
      assert.equal(r.code, 4, r.out);
      assert.match(r.out, /server\/index\.js/);
      assert.equal(t.head(), t.v1);
      assert.match(fs.readFileSync(t.p('app/server/index.js'), 'utf8'), /local hotfix/, 'local change preserved');
      assert.deepEqual(t.backups(), []);
      assert.ok(!/restart/.test(t.mockLog()));
    } finally { t.cleanup(); }
  });

  it('git fetch failure: exit 5, nothing changed', () => {
    const t = makeInstall();
    try {
      sh(t.p('app'), `git remote set-url origin "${fwd(t.p('does-not-exist.git'))}"`);
      const r = t.run();
      assert.equal(r.code, 5, r.out);
      assert.equal(t.head(), t.v1);
      assert.deepEqual(t.backups(), []);
    } finally { t.cleanup(); }
  });

  it('backup failure: exit 7 before any change', () => {
    const t = makeInstall();
    try {
      fs.writeFileSync(t.p('data/auth.db'), 'this is not a sqlite database');
      const r = t.run();
      assert.equal(r.code, 7, r.out);
      assert.equal(t.head(), t.v1);
      assert.ok(!/restart/.test(t.mockLog()));
    } finally { t.cleanup(); }
  });

  it('dependency installation failure: code restored, nothing restarted', () => {
    const t = makeInstall();
    try {
      // v3 introduces a lockfile; npm (mock) fails.
      const work = t.p('work');
      fs.writeFileSync(path.join(work, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
      sh(work, 'git -c user.name=T -c user.email=t@e.invalid add -A && git -c user.name=T -c user.email=t@e.invalid commit -qm v3 && git push -q origin main');
      const r = t.run([], { MOCK_NPM_EXIT: '1' });
      assert.equal(r.code, 8, r.out);
      assert.match(t.mockLog(), /npm ci --omit=dev --ignore-scripts/);
      assert.equal(t.head(), t.v1, 'back on the starting revision');
      assert.ok(!/systemctl restart/.test(t.mockLog()));
    } finally { t.cleanup(); }
  });

  it('restart failure: code rolled back, previous revision healthy, database not restored', () => {
    const t = makeInstall();
    try {
      const rowsBefore = t.rows();
      const r = t.run([], { MOCK_RESTART_FAIL_REV: '' }); // establish baseline? (no failure)
      assert.equal(r.code, 0, r.out);
      // Now deploy a v3 whose restart fails.
      const work = t.p('work');
      fs.appendFileSync(path.join(work, 'server', 'index.js'), '\n// v3\n');
      sh(work, 'git -c user.name=T -c user.email=t@e.invalid commit -qam v3 && git push -q origin main');
      const v3 = sh(work, 'git rev-parse HEAD');
      fs.writeFileSync(t.p('mock.log'), '');
      const r2 = t.run([], { MOCK_RESTART_FAIL_REV: v3 });
      assert.equal(r2.code, 9, r2.out);
      assert.match(r2.out, /ROLLED BACK/);
      assert.equal(t.head(), t.v2);
      assert.equal(t.branch(), 'DETACHED');
      assert.equal(t.mockLog().split('\n').filter(l => l.startsWith('systemctl restart')).length, 2);
      assert.ok(fs.readdirSync(t.p('logs')).some(f => f.startsWith('journal-')), 'service log preserved');
      assert.equal(t.rows(), rowsBefore, 'database not restored or modified');
      assert.equal(fs.readFileSync(t.p('state/deployed-revision'), 'utf8').trim(), t.v2, 'last good revision still recorded');
      // The next run refuses until a human returns to main.
      const r3 = t.run(['--dry-run']);
      assert.equal(r3.code, 3, r3.out);
      assert.match(r3.out, /detached HEAD/);
    } finally { t.cleanup(); }
  });

  it('health-check failure: rolled back automatically (additive migration => safe)', () => {
    const t = makeInstall({ v2Change: 'additive-migration' });
    try {
      const r = t.run([], { MOCK_HEALTH_FAIL_REV: t.v2 });
      assert.equal(r.code, 10, r.out);
      assert.match(r.out, /new upgrades 1 \(additive only\)/);
      assert.match(r.out, /ROLLED BACK/);
      assert.equal(t.head(), t.v1);
      assert.ok(!fs.existsSync(t.p('state/deployed-revision')), 'failed revision never recorded as deployed');
    } finally { t.cleanup(); }
  });

  it('rollback safety: a non-additive migration stops for manual intervention instead of rolling back', () => {
    const t = makeInstall({ v2Change: 'non-additive-migration' });
    try {
      const dry = t.run(['--dry-run']);
      assert.equal(dry.code, 0, dry.out);
      assert.match(dry.out, /NOT be safe/);
      const rowsBefore = t.rows();
      const r = t.run([], { MOCK_HEALTH_FAIL_REV: t.v2 });
      assert.equal(r.code, 20, r.out);
      assert.match(r.out, /MANUAL INTERVENTION REQUIRED/);
      assert.match(r.out, /not purely additive/);
      assert.match(r.out, /database was NOT restored/);
      assert.equal(t.head(), t.v2, 'code left for a human to decide');
      assert.equal(t.rows(), rowsBefore);
    } finally { t.cleanup(); }
  });

  it('concurrent deployment is refused; a stale lock is cleared', () => {
    const t = makeInstall();
    try {
      // A live process holds the lock while a second deployment starts.
      const env = Object.entries({ ...t.env, PICASSO_DEPLOY_SELF: '' }).map(([k, v]) => `${k}='${v}'`).join(' ');
      const out = sh(t.p('app'), `mkdir "${t.env.DEPLOY_LOCK_DIR}" && echo $$ > "${t.env.DEPLOY_LOCK_DIR}/pid" && (env ${env} bash deploy.sh --dry-run; echo "EXIT=$?"); rm -rf "${t.env.DEPLOY_LOCK_DIR}"`);
      assert.match(out, /another deployment is running/);
      assert.match(out, /EXIT=75/);
      fs.mkdirSync(t.p('lock'));
      fs.writeFileSync(t.p('lock/pid'), '999999\n');
      const r = t.run(['--dry-run']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /stale deployment lock/);
      assert.ok(!fs.existsSync(t.p('lock')), 'lock released');
    } finally { t.cleanup(); }
  });

  it('refuses when Telegram is not off (unless approved), or when the app would be exposed', () => {
    const t = makeInstall();
    try {
      const env = fs.readFileSync(t.p('picasso.env'), 'utf8');
      fs.writeFileSync(t.p('picasso.env'), env.replace('PICASSO_TELEGRAM_MODE=off', 'PICASSO_TELEGRAM_MODE=polling'));
      let r = t.run(['--dry-run']);
      assert.equal(r.code, 6, r.out);
      r = t.run(['--dry-run', '--allow-telegram']);
      assert.equal(r.code, 0, r.out);
      fs.writeFileSync(t.p('picasso.env'), env.replace('PICASSO_HOST=127.0.0.1', 'PICASSO_HOST=0.0.0.0'));
      r = t.run(['--dry-run']);
      assert.equal(r.code, 3, r.out);
      assert.match(r.out, /loopback/);
      fs.writeFileSync(t.p('picasso.env'), env.replace('PICASSO_LEDGER_MODE=production', 'PICASSO_LEDGER_MODE=demo'));
      assert.equal(t.run(['--dry-run']).code, 3);
      assert.equal(t.run(['--bogus']).code, 2);
    } finally { t.cleanup(); }
  });

  it('refuses when local main has diverged from origin (never forces)', () => {
    const t = makeInstall();
    try {
      sh(t.p('app'), 'git -c user.name=T -c user.email=t@e.invalid commit -q --allow-empty -m local-only');
      const local = t.head();
      const r = t.run();
      assert.equal(r.code, 5, r.out);
      assert.equal(t.head(), local);
    } finally { t.cleanup(); }
  });
});
