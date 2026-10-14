'use strict';
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, randomPassword, Client } = require('./helpers');
const { loadConfig } = require('../server/config');

const GENERIC = 'Invalid username or password.';

describe('Admin & staff authentication (direct API)', () => {
  let srv, admin, staff, staffId, staffName, staffPassword, cashoutId;
  const passwords = [];

  before(async () => {
    srv = await startServer();
    admin = srv.client();
    passwords.push(srv.adminPassword);
  });
  after(() => srv.close());

  it('1. correct admin login succeeds with a hardened session cookie', async () => {
    const r = await admin.login(srv.adminUsername, srv.adminPassword);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, 'CharsiNew');
    assert.equal(r.json.user.role, 'admin');
    assert.match(r.json.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const [cookie] = r.setCookies;
    assert.match(cookie, /^picasso_sid=[A-Za-z0-9_-]{43}; /);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attr), attr);
    assert.ok(!/Secure/.test(cookie), 'plain-HTTP local dev cookie is not marked Secure');
    assert.equal((await admin.get('/api/session')).json.user.role, 'admin');
  });

  it('2. incorrect admin password fails with a generic error and no session', async () => {
    const c = srv.client();
    const r = await c.login(srv.adminUsername, srv.adminPassword + 'x');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: GENERIC });
    assert.equal(r.setCookies.length, 0);
    assert.equal((await c.get('/api/session')).status, 401);
  });

  it('3. unknown username fails with the identical generic error', async () => {
    const r = await srv.client().login('nobody-here', 'whatever-password');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: GENERIC });
    const r2 = await srv.client().login('charsinew', 'wrong-password-123');
    assert.deepEqual(r2.json, { error: GENERIC });
  });

  it('4. admin can create staff (validated, unique, password never returned)', async () => {
    staffName = 'riley.staff';
    staffPassword = randomPassword();
    passwords.push(staffPassword);
    const r = await admin.post('/api/staff', { username: staffName, password: staffPassword });
    assert.equal(r.status, 201);
    staffId = r.json.staff.id;
    assert.deepEqual(Object.keys(r.json.staff).sort(), ['createdAt', 'disabled', 'id', 'passwordChangedAt', 'role', 'username']);
    assert.equal(r.json.staff.role, 'staff');
    assert.equal((await admin.post('/api/staff', { username: 'RILEY.STAFF', password: randomPassword() })).status, 409, 'usernames are unique case-insensitively');
    assert.equal((await admin.post('/api/staff', { username: 'shortpw', password: '1234567' })).status, 400, 'min 8 characters');
    assert.equal((await admin.post('/api/staff', { username: 'bad name!', password: randomPassword() })).status, 400);
    const list = await admin.get('/api/staff');
    assert.deepEqual(list.json.staff.map(u => u.username), [staffName]);
  });

  it('5. new staff can log in', async () => {
    staff = srv.client();
    const r = await staff.login(staffName, staffPassword);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'staff');
    assert.equal(r.json.user.id, staffId);
  });

  it('6. staff are denied every admin route (403) and nothing changes', async () => {
    const before = await admin.get('/api/settlements');
    const denied = [
      ['GET', '/api/trash'], ['GET', '/api/staff'], ['GET', '/api/calculations'], ['GET', '/api/settlements'],
      ['POST', '/api/payments/p1/delete'], ['POST', '/api/payments/p1/restore'], ['POST', '/api/cashouts/o2/cancel'],
      ['POST', '/api/settlements/preview', { paymentId: 'p6' }], ['POST', '/api/settlements', { paymentId: 'p6' }],
      ['POST', '/api/demo/reset'], ['POST', '/api/staff', { username: 'x-staff', password: randomPassword() }],
      ['POST', `/api/staff/${staffId}/disable`], ['POST', `/api/staff/${staffId}/enable`],
      ['POST', `/api/staff/${staffId}/password`, { password: randomPassword() }],
      ['POST', '/api/account/password', { currentPassword: staffPassword, newPassword: randomPassword() }],
    ];
    for (const [method, url, body] of denied) {
      const r = await staff.request(method, url, body);
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.deepEqual(Object.keys(r.json), ['error'], `${method} ${url} leaks nothing`);
    }
    const payments = (await admin.get('/api/payments')).json.payments;
    assert.equal(payments.find(p => p.id === 'p1').status, 'pending');
    assert.equal((await admin.get('/api/cashouts')).json.cashouts.find(o => o.id === 'o2').status, 'pending');
    assert.deepEqual((await admin.get('/api/settlements')).json, before.json);
  });

  it('7. staff cannot obtain calculation data from any API response', async () => {
    const r = await staff.get('/api/calculations');
    assert.equal(r.status, 403);
    assert.ok(!('totals' in r.json));
    for (const url of ['/api/payments', '/api/cashouts', '/api/session']) {
      const body = (await staff.get(url)).text;
      for (const k of ['running', 'runningIn', 'acceptedIn', 'netCents', 'remainingCents', 'totalSettlements', 'incomingCents', 'settlements']) {
        assert.ok(!body.includes(`"${k}"`), `${url} must not contain ${k}`);
      }
    }
  });

  it('8. staff cannot access settlement history or settle', async () => {
    assert.equal((await staff.get('/api/settlements')).status, 403);
    assert.equal((await staff.post('/api/settlements/preview', { paymentId: 'p6' })).status, 403);
    assert.equal((await staff.post('/api/settlements', { paymentId: 'p6' })).status, 403);
    assert.equal((await admin.get('/api/settlements')).json.settlements.length, 1);
  });

  it('9. staff cannot create accounts', async () => {
    const pw = randomPassword();
    assert.equal((await staff.post('/api/staff', { username: 'sneaky', password: pw })).status, 403);
    assert.equal((await srv.client().login('sneaky', pw)).status, 401);
    assert.equal(srv.accounts.findByUsername('sneaky'), undefined);
  });

  it('10. staff can accept payments, recorded with their identity', async () => {
    const t0 = Date.now();
    assert.equal((await staff.post('/api/payments/p1/accept')).status, 204);
    const p1 = (await staff.get('/api/payments')).json.payments.find(p => p.id === 'p1');
    assert.equal(p1.status, 'accepted');
    assert.equal(p1.acceptedById, staffId);
    assert.equal(p1.acceptedBy, staffName);
    assert.ok(Date.parse(p1.acceptedAt) >= t0 - 1000);
    assert.equal((await staff.post('/api/payments/p1/accept')).status, 409, 'cannot accept twice');
  });

  it('11. staff can create cash-out requests, recorded with their identity', async () => {
    const r = await staff.post('/api/cashouts', { method: 'Venmo', name: '@riley-test', amount: '12.50' });
    assert.equal(r.status, 201);
    cashoutId = r.json.id;
    const o = (await staff.get('/api/cashouts')).json.cashouts.find(x => x.id === cashoutId);
    assert.deepEqual([o.status, o.amountCents, o.createdById, o.createdBy], ['pending', 1250, staffId, staffName]);
    assert.ok(o.createdAt);
    assert.equal((await staff.post('/api/cashouts', { method: 'Venmo', name: '@x', amount: '1.234' })).status, 400);
    assert.equal((await staff.post('/api/cashouts', { method: 'PayPal', name: '@x', amount: '5' })).status, 400);
    assert.equal((await staff.post('/api/cashouts', { method: 'Venmo', name: '@x', amount: '0' })).status, 400);
  });

  it('12. admin can cancel pending cash-outs (staff cannot)', async () => {
    assert.equal((await staff.post(`/api/cashouts/${cashoutId}/cancel`)).status, 403);
    const before = (await admin.get('/api/calculations')).json.totals;
    assert.equal((await admin.post(`/api/cashouts/${cashoutId}/cancel`)).status, 204);
    const o = (await admin.get('/api/cashouts')).json.cashouts.find(x => x.id === cashoutId);
    assert.equal(o.status, 'cancelled');
    assert.equal(o.cancelledBy, 'CharsiNew');
    assert.equal(o.createdBy, staffName, 'original creator preserved');
    assert.equal((await admin.post(`/api/cashouts/${cashoutId}/cancel`)).status, 409);
    assert.equal((await admin.post(`/api/cashouts/${cashoutId}/complete`)).status, 409, 'cancelled cash-out cannot complete');
    assert.deepEqual((await admin.get('/api/calculations')).json.totals, before, 'cancelled cash-out does not affect totals');
  });

  it('18a. settlement records snapshot staff + admin attribution', async () => {
    const r = await admin.post('/api/settlements', { paymentId: 'p1' });
    assert.equal(r.status, 201);
    const s = r.json.settlement;
    assert.equal(s.admin, 'CharsiNew');
    const adminId = srv.accounts.findByUsername('CharsiNew').id;
    assert.equal(s.adminId, adminId);
    const line = s.incoming.find(x => x.id === 'p1');
    assert.deepEqual([line.acceptedById, line.acceptedBy], [staffId, staffName]);
  });

  it('13. disabled staff cannot log in (generic error)', async () => {
    const extra = staff.clone();
    assert.equal((await admin.post(`/api/staff/${staffId}/disable`)).status, 204);
    const r = await srv.client().login(staffName, staffPassword);
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: GENERIC });
    assert.equal((await admin.get('/api/staff')).json.staff[0].disabled, true);
    // 14 is checked against this pre-disable session copy
    staff.preDisable = extra;
  });

  it('14. disabling staff revokes their active sessions', async () => {
    assert.equal((await staff.get('/api/session')).status, 401);
    assert.equal((await staff.preDisable.post('/api/payments/p3/accept')).status, 401);
    assert.equal(srv.accounts.countSessions(staffId), 0);
    assert.equal((await admin.post(`/api/staff/${staffId}/enable`)).status, 204);
    assert.equal((await staff.login(staffName, staffPassword)).status, 200, 're-enabled staff can log in again');
  });

  it('15. password reset invalidates every existing session', async () => {
    const tabB = srv.client();
    await tabB.login(staffName, staffPassword);
    assert.equal(srv.accounts.countSessions(staffId), 2);
    const newPassword = randomPassword();
    passwords.push(newPassword);
    assert.equal((await admin.post(`/api/staff/${staffId}/password`, { password: 'short' })).status, 400);
    assert.equal((await admin.post(`/api/staff/${staffId}/password`, { password: newPassword })).status, 204);
    assert.equal((await staff.get('/api/session')).status, 401);
    assert.equal((await tabB.get('/api/session')).status, 401);
    assert.equal(srv.accounts.countSessions(staffId), 0);
    assert.equal((await srv.client().login(staffName, staffPassword)).status, 401, 'old password rejected');
    assert.equal((await staff.login(staffName, newPassword)).status, 200);
    staffPassword = newPassword;
  });

  it('15b. admin can change their own password; other admin sessions end, current one is rotated', async () => {
    const otherTab = srv.client();
    await otherTab.login(srv.adminUsername, srv.adminPassword);
    const oldCookie = admin.cookieHeader();
    assert.equal((await admin.post('/api/account/password', { currentPassword: 'nope-nope', newPassword: randomPassword() })).status, 400);
    const newPassword = randomPassword();
    passwords.push(newPassword);
    const r = await admin.post('/api/account/password', { currentPassword: srv.adminPassword, newPassword });
    assert.equal(r.status, 200);
    admin.csrf = r.json.csrfToken;
    assert.notEqual(admin.cookieHeader(), oldCookie);
    assert.equal((await admin.get('/api/session')).status, 200);
    assert.equal((await otherTab.get('/api/session')).status, 401);
    assert.equal((await srv.client().login(srv.adminUsername, srv.adminPassword)).status, 401);
    srv.adminPassword = newPassword;
  });

  it('16. logout invalidates the session server-side', async () => {
    const c = srv.client();
    await c.login(srv.adminUsername, srv.adminPassword);
    const stolen = c.clone();
    const r = await c.post('/api/auth/logout');
    assert.equal(r.status, 204);
    assert.match(r.setCookies[0], /Max-Age=0/);
    assert.equal((await stolen.get('/api/session')).status, 401, 'replaying the old cookie fails');
    assert.equal((await stolen.post('/api/auth/logout')).status, 401);
  });

  it('17. login survives page refresh while the session is valid', async () => {
    const page = await staff.get('/', { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Picasso Dashboard<\/title>/);
    for (let i = 0; i < 3; i++) assert.equal((await staff.get('/api/session')).json.user.username, staffName);
    assert.equal((await staff.get('/login')).headers.get('location'), '/', 'signed-in users skip the login page');
    const anon = await srv.client().get('/');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/login');
  });

  it('17b. idle and absolute session expiry are enforced', async () => {
    const c = srv.client();
    await c.login(staffName, staffPassword);
    srv.accounts.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?').run(Date.now() - srv.config.sessionIdleMs - 1, staffId);
    assert.equal((await c.get('/api/session')).status, 401);
    await c.login(staffName, staffPassword);
    srv.accounts.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, staffId);
    assert.equal((await c.get('/api/session')).status, 401);
    await staff.login(staffName, staffPassword);
  });

  it('18. historical attribution survives disabling the staff account', async () => {
    assert.equal((await admin.post(`/api/staff/${staffId}/disable`)).status, 204);
    const p1 = (await admin.get('/api/payments')).json.payments.find(p => p.id === 'p1');
    assert.deepEqual([p1.acceptedById, p1.acceptedBy], [staffId, staffName]);
    const o = (await admin.get('/api/cashouts')).json.cashouts.find(x => x.id === cashoutId);
    assert.deepEqual([o.createdById, o.createdBy], [staffId, staffName]);
    const s = (await admin.get('/api/settlements')).json.settlements.at(-1);
    assert.equal(s.incoming.find(x => x.id === 'p1').acceptedBy, staffName);
    assert.equal(s.admin, 'CharsiNew');
  });

  it('19. no passwords or hashes in any API response; frontend uses no browser storage', async () => {
    const all = Client.transcript.join('\n');
    for (const pw of passwords) assert.ok(!all.includes(pw), 'a password appeared in a response');
    for (const marker of ['$argon2', 'password_hash', 'passwordHash', 'token_hash']) assert.ok(!all.includes(marker), marker);
    const dir = path.join(__dirname, '..', 'public');
    for (const f of fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), `${f} must not use browser storage`);
    }
    const dbHashes = srv.accounts.db.prepare('SELECT password_hash FROM users').all();
    assert.ok(dbHashes.every(r => r.password_hash.startsWith('$argon2id$v=19$m=65536,t=3,p=4$')));
    const dump = JSON.stringify(srv.accounts.db.prepare('SELECT * FROM users').all()) + JSON.stringify(srv.accounts.db.prepare('SELECT * FROM audit_log').all());
    for (const pw of passwords) assert.ok(!dump.includes(pw), 'plaintext password stored');
  });

  it('records admin actions in the audit log', () => {
    const actions = srv.accounts.db.prepare('SELECT action FROM audit_log').all().map(r => r.action);
    for (const a of ['admin_initialised_cli', 'login', 'login_failed', 'staff_created', 'staff_disabled', 'staff_enabled', 'staff_password_reset', 'password_changed', 'logout']) {
      assert.ok(actions.includes(a), a);
    }
  });
});

describe('Request-level protections', () => {
  let srv, admin;
  before(async () => {
    srv = await startServer();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
  });
  after(() => srv.close());

  it('CSRF: state-changing requests need the session CSRF token', async () => {
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { csrf: false })).status, 403);
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { headers: { 'X-CSRF-Token': 'x'.repeat(43) } })).status, 403);
    const other = srv.client();
    await other.login(srv.adminUsername, srv.adminPassword);
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { headers: { 'X-CSRF-Token': other.csrf } })).status, 403, 'token is bound to its session');
    assert.equal((await admin.get('/api/payments')).json.payments.find(p => p.id === 'p1').status, 'pending');
  });

  it('cross-site requests and non-JSON bodies are rejected (including login)', async () => {
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const c = srv.client();
    assert.equal((await c.post('/api/auth/login', { username: srv.adminUsername, password: srv.adminPassword }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await c.post('/api/auth/login', { username: srv.adminUsername, password: srv.adminPassword }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await admin.post('/api/payments/p1/accept', {}, { headers: { Origin: srv.base } })).status, 204, 'same-origin allowed');
  });

  it('session fixation: a planted cookie is never adopted, and login rotates the session', async () => {
    const victim = srv.client();
    victim.cookies.set('picasso_sid', 'attacker-chosen-session-id-value-123456');
    const r = await victim.login(srv.adminUsername, srv.adminPassword);
    assert.equal(r.status, 200);
    assert.notEqual(victim.cookies.get('picasso_sid'), 'attacker-chosen-session-id-value-123456');
    const before = victim.clone();
    await victim.login(srv.adminUsername, srv.adminPassword);
    assert.notEqual(victim.cookies.get('picasso_sid'), before.cookies.get('picasso_sid'));
    assert.equal((await before.get('/api/session')).status, 401, 'previous session destroyed on re-login');
    assert.equal((await victim.get('/api/session')).status, 200);
  });

  it('unauthenticated API calls get 401; unknown routes are denied by default', async () => {
    const anon = srv.client();
    for (const url of ['/api/payments', '/api/cashouts', '/api/calculations', '/api/settlements', '/api/staff', '/api/trash', '/api/session']) {
      assert.equal((await anon.get(url)).status, 401, url);
    }
    assert.equal((await anon.post('/api/payments/p1/accept')).status, 401);
    assert.equal((await admin.get('/api/users')).status, 404);
    assert.equal((await admin.get('/api/audit')).status, 404);
    assert.equal((await admin.request('DELETE', '/api/staff')).status, 405);
  });

  it('only whitelisted static files are served (no source, DB or env files)', async () => {
    const anon = srv.client();
    for (const url of ['/server/app.js', '/settlement-core.js', '/data/auth.db', '/.env', '/package.json', '/public/app.js', '/../server/config.js', '/legacy-static-demo/index.html']) {
      assert.equal((await anon.get(url)).status, 404, url);
    }
    for (const url of ['/login', '/app.js', '/login.js', '/styles.css']) assert.equal((await anon.get(url)).status, 200, url);
    const r = await anon.get('/login');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  it('every user-facing API response is marked no-store', async () => {
    assert.equal((await admin.get('/api/payments')).headers.get('cache-control'), 'no-store');
  });
});

describe('Login rate limiting', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.close());

  it('locks a username after 5 failures, even for the correct password, without revealing existence', async () => {
    const c = srv.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.login(srv.adminUsername, 'wrong-' + i)).status, 401);
    const blocked = await c.login(srv.adminUsername, srv.adminPassword);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.setCookies.length, 0);
    for (let i = 0; i < 5; i++) assert.equal((await c.login('ghost-user', 'wrong-' + i)).status, 401);
    assert.equal((await c.login('ghost-user', 'wrong')).status, 429, 'unknown usernames are limited identically');
  });

  it('limits total failures per IP across usernames', async () => {
    const c = srv.client();
    // 10 failures already recorded above; per-IP limit is 20.
    for (let i = 0; i < 10; i++) await c.login(`spray-${i}`, 'wrong-password');
    assert.equal((await c.login('another-name', 'wrong-password')).status, 429);
  });
});

describe('Configuration safety', () => {
  it('Secure + __Host- cookie when configured for HTTPS', async () => {
    const srv = await startServer({ PICASSO_COOKIE_SECURE: 'true' });
    try {
      const r = await srv.client().post('/api/auth/login', { username: srv.adminUsername, password: srv.adminPassword }, { headers: { Origin: srv.base.replace('http:', 'https:') } });
      assert.equal(r.status, 200);
      assert.match(r.setCookies[0], /^__Host-picasso_sid=.*; Secure$/);
    } finally { await srv.close(); }
  });

  it('refuses to run with anything but the demo ledger', () => {
    assert.throws(() => loadConfig({ PICASSO_LEDGER_MODE: 'staging' }), /must be "demo" or "production"/);
    assert.throws(() => loadConfig({ PICASSO_LEDGER_MODE: 'production' }), /PICASSO_PAYMENT_START_AT is required/);
  });

  it('admin initialisation refuses to overwrite an existing admin without --reset-password', async () => {
    const srv = await startServer();
    try {
      const { initAdmin } = require('../server/accounts');
      await assert.rejects(initAdmin(srv.accounts, srv.adminUsername, randomPassword()), /already exists/);
      await assert.rejects(initAdmin(srv.accounts, 'SecondAdmin', randomPassword()), /different admin/);
      await assert.rejects(initAdmin(srv.accounts, srv.adminUsername, 'short', { resetPassword: true }), /at least 8/);
    } finally { await srv.close(); }
  });
});

describe('20. Existing dashboard behaviour is unchanged (via API, seed demo data)', () => {
  let srv, admin, staff;
  const totals = async m => { const t = (await admin.get('/api/calculations')).json.totals[m]; return [t.acceptedIn, t.completedOut, t.totalSettlements, t.runningIn, t.runningOut, t.running]; };
  before(async () => {
    srv = await startServer();
    admin = srv.client();
    await admin.login(srv.adminUsername, srv.adminPassword);
    const pw = randomPassword();
    await admin.post('/api/staff', { username: 'casey', password: pw });
    staff = srv.client();
    await staff.login('casey', pw);
  });
  after(() => srv.close());

  it('seed totals match the original demo, Venmo and Chime independent', async () => {
    assert.deepEqual(await totals('Venmo'), [97000, 30000, 12000, 85000, 30000, 55000]);
    assert.deepEqual(await totals('Chime'), [52500, 8000, 0, 52500, 8000, 44500]);
  });

  it('payments list: red pending first, green accepted next, gray settled last', async () => {
    const list = (await staff.get('/api/payments')).json.payments;
    const rank = p => p.status === 'pending' ? 0 : p.settled ? 2 : 1;
    assert.deepEqual(list.map(rank), list.map(rank).slice().sort());
    assert.deepEqual(list.filter(p => p.settled).map(p => p.id), ['p4']);
    assert.equal(list.filter(p => p.status === 'pending').length, 4);
  });

  it('$800 + $50 − $300 example: settle Maya Chen through the API', async () => {
    const p = (await admin.post('/api/settlements/preview', { paymentId: 'p5' })).json;
    assert.deepEqual([p.ok, p.incomingCents, p.outgoingCents, p.netCents, p.remainingCents], [true, 80000, 30000, 50000, 5000]);
    const chimeBefore = await totals('Chime');
    const r = await admin.post('/api/settlements', { paymentId: 'p5' });
    assert.equal(r.status, 201);
    assert.equal(r.json.settlement.id, 'SET-21');
    assert.deepEqual(await totals('Venmo'), [97000, 30000, 62000, 5000, 0, 5000]);
    assert.deepEqual(await totals('Chime'), chimeBefore);
    const history = (await admin.get('/api/settlements')).json.settlements;
    assert.deepEqual(history.map(s => [s.method, s.number, s.color]), [['Venmo', 1, '#3B82F6'], ['Venmo', 2, '#22C55E']]);
    assert.equal((await admin.post('/api/settlements', { paymentId: 'p5' })).status, 409, 'cannot settle twice');
    const o1 = (await staff.get('/api/cashouts')).json.cashouts.find(o => o.id === 'o1');
    assert.equal(o1.settled, true, 'settled cash-outs turn gray');
  });

  it('negative settlement is blocked; zero allowed by the same core rules', async () => {
    const id = (await staff.post('/api/cashouts', { method: 'Venmo', name: '@big', amount: '100' })).json.id;
    assert.equal((await staff.post(`/api/cashouts/${id}/complete`)).status, 204);
    const r = await admin.post('/api/settlements', { paymentId: 'p6' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Cannot Settle/);
    assert.equal((await admin.get('/api/settlements')).json.settlements.length, 2);
  });

  it('admin trash: delete pending → trash (with admin attribution) → restore', async () => {
    assert.equal((await staff.post('/api/payments/p3/delete')).status, 403);
    assert.equal((await admin.post('/api/payments/p3/delete')).status, 204);
    assert.ok(!(await staff.get('/api/payments')).json.payments.some(p => p.id === 'p3'));
    const trash = (await admin.get('/api/trash')).json.payments;
    assert.deepEqual(trash.map(p => [p.id, p.deletedBy]), [['p3', 'CharsiNew']]);
    assert.equal((await admin.post('/api/payments/p6/delete')).status, 409, 'only pending payments can be deleted');
    assert.equal((await admin.post('/api/payments/p3/restore')).status, 204);
    assert.equal((await admin.get('/api/payments')).json.payments.find(p => p.id === 'p3').status, 'pending');
    assert.equal((await admin.get('/api/trash')).json.payments.length, 0);
  });

  it('admin demo reset restores seed data and leaves accounts alone', async () => {
    assert.equal((await staff.post('/api/demo/reset')).status, 403);
    assert.equal((await admin.post('/api/demo/reset')).status, 204);
    assert.deepEqual(await totals('Venmo'), [97000, 30000, 12000, 85000, 30000, 55000]);
    assert.equal((await staff.get('/api/session')).status, 200);
  });
});
