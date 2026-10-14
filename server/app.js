'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openAuthDb, openLedgerDb } = require('./db');
const { Accounts, publicUser } = require('./accounts');
const { DemoLedger } = require('./demo-ledger');
const { LoginLimiter } = require('./rate-limit');
const { EventHub } = require('./events');
const { TelegramApi } = require('./telegram/api');
const { TelegramBot } = require('./telegram/bot');

const ADMIN = 'admin';
const STAFF = 'staff';
const ANY_USER = [ADMIN, STAFF];
const ADMIN_ONLY = [ADMIN];
const MAX_BODY = 16 * 1024;
const GENERIC_LOGIN_ERROR = 'Invalid username or password.';

// Only these files are ever served; everything else under the project (server
// code, databases, .env) is unreachable.
const STATIC_FILES = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/settlement-styles.css': ['settlement-styles.css', 'text/css; charset=utf-8'],
  '/login.css': ['login.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp(config) {
  const accounts = new Accounts(openAuthDb(config.dataDir), config);
  const ledger = new DemoLedger(openLedgerDb(config.dataDir, config.ledgerMode), { mode: config.ledgerMode, paymentStartMs: config.paymentStartMs, paymentStartRaw: config.paymentStartRaw });
  const limiter = new LoginLimiter(config.loginLimits);
  const events = new EventHub(accounts);
  const tg = config.telegram;
  // Built here, started by server/index.js (tests drive it directly).
  const telegram = tg.enabled ? new TelegramBot({ config: tg, ledger, events, api: new TelegramApi(tg) }) : null;
  accounts.purgeExpiredSessions();

  const isSecure = req => config.cookieSecure === 'true' || (config.cookieSecure === 'auto' &&
    (Boolean(req.socket.encrypted) || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')));
  // __Host- prefix (Secure, Path=/, no Domain) whenever the cookie can be Secure.
  const cookieName = req => isSecure(req) ? '__Host-picasso_sid' : 'picasso_sid';
  const clientIp = req => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  function readCookie(req) {
    const name = cookieName(req);
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function sessionCookie(req, token, maxAgeSec) {
    return [`${cookieName(req)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, ...(isSecure(req) ? ['Secure'] : [])].join('; ');
  }

  function startSession(req, user) {
    const { token, csrfToken } = accounts.createSession(user.id);
    return { csrfToken, cookie: sessionCookie(req, token, Math.floor(config.sessionAbsoluteMs / 1000)) };
  }

  const str = (v, name) => {
    if (typeof v !== 'string') throw new HttpError(400, `${name} is required.`);
    return v;
  };
  const staffTarget = id => {
    const u = accounts.findById(id);
    if (!u || u.role !== STAFF) throw new HttpError(404, 'Staff account not found.');
    return u;
  };

  // ---- route table ---------------------------------------------------------
  // Every route must declare `roles` or be explicitly `public`. Anything not
  // listed is a 404, so new endpoints are denied by default.
  const routes = [
    { method: 'POST', path: '/api/auth/login', public: true, handler: async ({ req, body }) => {
      const ip = clientIp(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (limiter.isBlocked(ip, username)) throw new HttpError(429, 'Too many login attempts. Please wait a few minutes and try again.');
      const user = await accounts.authenticate(username, body.password);
      if (!user) {
        limiter.recordFailure(ip, username);
        const known = accounts.findByUsername(username);
        accounts.audit(null, 'login_failed', known ? { id: known.id, username: known.username } : null);
        throw new HttpError(401, GENERIC_LOGIN_ERROR);
      }
      limiter.recordSuccess(ip, username);
      // Session fixation defence: whatever session the browser presented is
      // discarded and a brand-new identifier is issued.
      accounts.destroySession(readCookie(req));
      const { csrfToken, cookie } = startSession(req, user);
      accounts.audit(user, 'login', user);
      return { headers: { 'Set-Cookie': cookie }, body: { user: publicUser(user), csrfToken } };
    } },
    { method: 'POST', path: '/api/auth/logout', roles: ANY_USER, handler: ({ req, user }) => {
      accounts.destroySession(readCookie(req));
      accounts.audit(user, 'logout', user);
      return { status: 204, headers: { 'Set-Cookie': sessionCookie(req, '', 0) } };
    } },
    { method: 'GET', path: '/api/session', roles: ANY_USER, handler: ({ user, session }) =>
      ({ body: { user: publicUser(user), csrfToken: session.csrfToken, dataMode: config.ledgerMode, cashoutCompletion: tg.enabled || config.ledgerMode === 'production' ? 'telegram' : 'dashboard' } }) },
    // Live updates (SSE). Signals only; data is reloaded through role-checked APIs.
    { method: 'GET', path: '/api/events', roles: ANY_USER, stream: true, handler: ({ req, res }) => events.open(req, res, readCookie(req)) },
    { method: 'POST', path: '/api/account/password', roles: ADMIN_ONLY, handler: async ({ req, user, body }) => {
      const ip = clientIp(req);
      if (limiter.isBlocked(ip, user.username)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
      if (!(await accounts.authenticate(user.username, body.currentPassword))) {
        limiter.recordFailure(ip, user.username);
        throw new HttpError(400, 'Current password is incorrect.');
      }
      await accounts.setPassword(user.id, str(body.newPassword, 'New password'));
      accounts.audit(user, 'password_changed', user);
      const { csrfToken, cookie } = startSession(req, user);
      return { headers: { 'Set-Cookie': cookie }, body: { csrfToken } };
    } },

    // Payments (staff + admin)
    { method: 'GET', path: '/api/payments', roles: ANY_USER, handler: () => ({ body: { payments: ledger.listPayments() } }) },
    { method: 'POST', path: '/api/payments/:id/accept', roles: ANY_USER, publish: ['payments'], handler: ({ params, user }) => { ledger.acceptPayment(params.id, user); return { status: 204 }; } },
    // Payments (admin only)
    { method: 'POST', path: '/api/payments/:id/delete', roles: ADMIN_ONLY, publish: ['payments'], handler: ({ params, user }) => { ledger.deletePayment(params.id, user); return { status: 204 }; } },
    { method: 'POST', path: '/api/payments/:id/restore', roles: ADMIN_ONLY, publish: ['payments'], handler: ({ params, user }) => { ledger.restorePayment(params.id, user); return { status: 204 }; } },
    { method: 'GET', path: '/api/trash', roles: ADMIN_ONLY, handler: () => ({ body: { payments: ledger.listTrash() } }) },

    // Cash-outs
    { method: 'GET', path: '/api/cashouts', roles: ANY_USER, handler: () => ({ body: { cashouts: ledger.listCashouts() } }) },
    { method: 'POST', path: '/api/cashouts', roles: ANY_USER, publish: ['cashouts'], handler: ({ body, user }) => {
      // Saved first; Telegram delivery happens from the outbox, so a send
      // failure can never lose or duplicate the financial request.
      // TEST requests are admin-only and are never queued for real Telegram.
      if (body.test === true && user.role !== ADMIN) throw new HttpError(403, 'Only admins can create test cash-outs.');
      const id = ledger.createCashout(body, user, { deliver: tg.enabled && body.test !== true });
      telegram?.kick();
      return { status: 201, body: { id } };
    } },
    // Demo-only manual completion. With Telegram on, completion comes only from
    // an authorized Telegram user pressing "Completed".
    { method: 'POST', path: '/api/cashouts/:id/complete', roles: ANY_USER, publish: ['cashouts'], handler: ({ params, user }) => {
      // Production completions come only from an authorized Telegram user.
      if (tg.enabled || config.ledgerMode === 'production') throw new HttpError(409, 'Cash-outs are completed from Telegram.');
      ledger.completeCashout(params.id, user);
      return { status: 204 };
    } },
    { method: 'POST', path: '/api/cashouts/:id/cancel', roles: ADMIN_ONLY, publish: ['cashouts'], handler: ({ params, user }) => { ledger.cancelCashout(params.id, user); accounts.audit(user, 'cashout_cancelled', { id: params.id, username: null }); telegram?.kick(); return { status: 204 }; } },
    { method: 'POST', path: '/api/cashouts/:id/retry-telegram-removal', roles: ADMIN_ONLY, publish: ['cashouts'], handler: ({ params, user }) => {
      if (!tg.enabled) throw new HttpError(409, 'Telegram is not enabled.');
      ledger.retryTelegramDelete(params.id);
      accounts.audit(user, 'cashout_telegram_removal_retry', { id: params.id, username: null });
      telegram.kick();
      return { status: 204 };
    } },
    { method: 'POST', path: '/api/cashouts/:id/retry-delivery', roles: ADMIN_ONLY, publish: ['cashouts'], handler: ({ params }) => {
      if (!tg.enabled) throw new HttpError(409, 'Telegram delivery is not enabled.');
      ledger.retryDelivery(params.id);
      telegram.kick();
      return { status: 204 };
    } },
    { method: 'POST', path: '/api/cashouts/:id/queue-telegram-delivery', roles: ADMIN_ONLY, publish: ['cashouts'], handler: ({ params, user }) => {
      if (!tg.enabled) throw new HttpError(409, 'Telegram delivery is not enabled.');
      ledger.queueHistoricalDelivery(params.id);
      accounts.audit(user, 'cashout_historical_delivery_queued', { id: params.id, username: null });
      telegram.kick();
      return { status: 204 };
    } },

    // Admin Attention (admin only). Acknowledgement only: never alters totals.
    { method: 'GET', path: '/api/attention', roles: ADMIN_ONLY, handler: () => ({ body: ledger.listAttention() }) },
    { method: 'POST', path: '/api/attention/:id/ignore', roles: ADMIN_ONLY, publish: ['attention'], handler: ({ params, user }) => {
      const r = ledger.ignoreAttention(params.id, user);
      if (r.changed) accounts.audit(user, 'attention_ignored', { id: params.id, username: null });
      return { status: 204 };
    } },

    // Calculations and settlements (admin only)
    { method: 'GET', path: '/api/calculations', roles: ADMIN_ONLY, handler: () => ({ body: { totals: ledger.calculations() } }) },
    { method: 'GET', path: '/api/settlements', roles: ADMIN_ONLY, handler: () => ({ body: { settlements: ledger.listSettlements() } }) },
    { method: 'POST', path: '/api/settlements/preview', roles: ADMIN_ONLY, handler: ({ body }) => ({ body: ledger.previewSettlement(str(body.paymentId, 'Payment')) }) },
    { method: 'POST', path: '/api/settlements', roles: ADMIN_ONLY, publish: ['settlements'], handler: ({ body, user }) => ({ status: 201, body: { settlement: ledger.commitSettlement(str(body.paymentId, 'Payment'), user) } }) },
    { method: 'POST', path: '/api/demo/reset', roles: ADMIN_ONLY, publish: ['payments', 'cashouts', 'settlements'], handler: ({ user }) => { ledger.reset(); accounts.audit(user, 'demo_data_reset'); return { status: 204 }; } },

    // Staff management (admin only)
    { method: 'GET', path: '/api/staff', roles: ADMIN_ONLY, handler: () => ({ body: { staff: accounts.listStaff() } }) },
    { method: 'POST', path: '/api/staff', roles: ADMIN_ONLY, handler: async ({ body, user }) => {
      const created = await accounts.createUser({ username: str(body.username, 'Username').trim(), password: str(body.password, 'Password'), role: STAFF, createdById: user.id });
      accounts.audit(user, 'staff_created', created);
      return { status: 201, body: { staff: publicUser(created) } };
    } },
    { method: 'POST', path: '/api/staff/:id/disable', roles: ADMIN_ONLY, handler: ({ params, user }) => {
      const target = staffTarget(params.id);
      accounts.setDisabled(target.id, true);
      accounts.audit(user, 'staff_disabled', target);
      return { status: 204 };
    } },
    { method: 'POST', path: '/api/staff/:id/enable', roles: ADMIN_ONLY, handler: ({ params, user }) => {
      const target = staffTarget(params.id);
      accounts.setDisabled(target.id, false);
      accounts.audit(user, 'staff_enabled', target);
      return { status: 204 };
    } },
    { method: 'POST', path: '/api/staff/:id/password', roles: ADMIN_ONLY, handler: async ({ params, body, user }) => {
      const target = staffTarget(params.id);
      await accounts.setPassword(target.id, str(body.password, 'Password'));
      accounts.audit(user, 'staff_password_reset', target);
      return { status: 204 };
    } },
  ];

  // Telegram webhook (webhook mode only). Authenticated by the secret token
  // Telegram echoes in X-Telegram-Bot-Api-Secret-Token, not by cookie.
  if (tg.mode === 'webhook') {
    routes.push({ method: 'POST', path: '/api/telegram/webhook', public: true, webhook: true, handler: async ({ req, body }) => {
      const given = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
      const expected = Buffer.from(tg.webhookSecret);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, 'Unauthorized.');
      await telegram.handleUpdate(body);
      return { body: { ok: true } };
    } });
  }

  // ---- User-account listener input ------------------------------------------
  // A separate local process (Telethon user account; see listener/) posts raw
  // group messages here. Enabled by PICASSO_LISTENER_INGEST_SECRET and
  // independent of the StaffHelp bot (works with PICASSO_TELEGRAM_MODE=off).
  // Loopback only, never via a proxy, shared secret on every request; the
  // message then goes through the same decision path as every other source.
  const lis = config.listener;
  if (lis.enabled) {
    const ingestor = telegram ?? new TelegramBot({ config: { ...lis }, ledger, events, api: null });
    if (!telegram) ingestor.botId = lis.staffhelpBotId;
    const authorizeListener = req => {
      const ip = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) || req.headers['x-forwarded-for'] || req.headers['x-real-ip']) throw new HttpError(403, 'Forbidden.');
      const given = Buffer.from(String(req.headers['x-picasso-ingest-secret'] || ''));
      const expected = Buffer.from(lis.ingestSecret);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, 'Unauthorized.');
    };
    const validChat = v => /^-?\d{1,20}$/.test(String(v));

    routes.push({ method: 'POST', path: '/api/ingest/telegram-message', public: true, webhook: true, handler: ({ req, body }) => {
      authorizeListener(req);
      const { chatId, messageId, date, text, senderId, edited } = body;
      if (!validChat(chatId) || !Number.isInteger(messageId) || messageId <= 0 || !Number.isInteger(date) || (text != null && typeof text !== 'string')
          || (senderId != null && !/^-?\d{1,20}$/.test(String(senderId)))) {
        throw new HttpError(400, 'Invalid message.');
      }
      const base = { kind: 'listener_message', chatId: String(chatId), messageId };
      // Edits never create or change records, even for messages after the cutoff.
      if (edited) {
        ledger.logTelegramEvent({ ...base, outcome: 'ignored_edit' });
        return { body: { outcome: 'ignored_edit' } };
      }
      // Live input is bounded in age: older messages need an approved import.
      const ageMs = Date.now() - date * 1000;
      if (ageMs > lis.maxAgeMs) {
        ledger.logTelegramEvent({ ...base, outcome: 'ignored_too_old_for_live' });
        return { body: { outcome: 'ignored_too_old_for_live' } };
      }
      if (ageMs < -5 * 60_000) {
        ledger.logTelegramEvent({ ...base, outcome: 'rejected_future_date' });
        return { body: { outcome: 'rejected_future_date' } };
      }
      const r = ingestor.handleMessage(null, { message_id: messageId, date, text, chat: { id: Number(chatId) }, from: { id: senderId ?? null } }, { listener: true });
      return { body: { outcome: r?.outcome ?? 'logged' } };
    } });

    // Gap report: the listener could not safely catch up on some messages (for
    // example after long downtime). Recorded in Admin Attention so an admin can
    // run an approved import; nothing is imported automatically.
    routes.push({ method: 'POST', path: '/api/ingest/telegram-gap', public: true, webhook: true, handler: ({ req, body }) => {
      authorizeListener(req);
      const { chatId, fromMessageId, toMessageId, fromDate, toDate, count } = body;
      const method = lis.incomingMethodByChat.get(String(chatId));
      if (!method || !Number.isInteger(fromMessageId) || !Number.isInteger(toMessageId) || fromMessageId <= 0 || toMessageId < fromMessageId
          || !Number.isInteger(fromDate) || !Number.isInteger(toDate) || !Number.isInteger(count) || count < 0) {
        throw new HttpError(400, 'Invalid gap report.');
      }
      const text = `Telegram ingestion gap in the ${method} group: ${count} message(s), IDs ${fromMessageId}-${toMessageId}, `
        + `${new Date(fromDate * 1000).toISOString()} to ${new Date(toDate * 1000).toISOString()}, were NOT imported automatically. `
        + 'Review them with an approved historical import (preview first).';
      // A negative synthetic message ID can never collide with a real message,
      // so the missed messages themselves stay importable later.
      const r = ledger.createAttentionEvent({
        method, eventType: 'unrecognized_financial', amountCents: null, reason: 'ingestion_gap', text,
        messageAt: new Date(toDate * 1000).toISOString(), chatId: String(chatId), messageId: -fromMessageId, parserVersion: 'listener-gap-v1',
      });
      ledger.logTelegramEvent({ kind: 'listener_gap', outcome: r.outcome === 'created' ? 'gap_reported' : 'duplicate_gap', chatId: String(chatId), messageId: fromMessageId, refId: r.id ?? null, detail: `count=${count} to=${toMessageId}` });
      if (r.outcome === 'created') events.publish(['attention']);
      return { body: { outcome: r.outcome } };
    } });
  }

  for (const r of routes) {
    if (!r.public && !(Array.isArray(r.roles) && r.roles.length)) throw new Error(`Route ${r.method} ${r.path} declares no roles.`);
    r.regex = new RegExp('^' + r.path.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]{1,64})') + '$');
  }

  // ---- request pipeline ----------------------------------------------------
  function send(res, status, body, headers = {}) {
    const json = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(json);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch { reject(new HttpError(400, 'Malformed JSON.')); }
      });
      req.on('error', reject);
    });
  }

  // Rejects cross-site state-changing requests before any auth work happens.
  function checkOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request blocked.');
    const origin = req.headers.origin;
    if (origin) {
      const expected = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
      if (origin !== expected) throw new HttpError(403, 'Cross-origin request blocked.');
    }
    // A JSON content type cannot be sent cross-origin without a CORS preflight,
    // which this server never approves.
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json.');
    }
  }

  function csrfOk(req, session) {
    const given = Buffer.from(String(req.headers['x-csrf-token'] || ''));
    const expected = Buffer.from(session.csrfToken);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function handleApi(req, res, pathname) {
    const matches = routes.filter(r => r.regex.test(pathname));
    if (!matches.length) throw new HttpError(404, 'Not found.');
    const route = matches.find(r => r.method === req.method);
    if (!route) throw new HttpError(405, 'Method not allowed.');
    const mutating = req.method !== 'GET';
    if (mutating && !route.webhook) checkOrigin(req);

    const auth = accounts.resolveSession(readCookie(req));
    if (!route.public) {
      if (!auth) throw new HttpError(401, 'Authentication required.');
      if (!route.roles.includes(auth.user.role)) throw new HttpError(403, 'You do not have permission to do that.');
      if (mutating && !csrfOk(req, auth.session)) throw new HttpError(403, 'Invalid or missing CSRF token. Refresh the page and try again.');
    }
    const body = mutating ? await readJson(req) : {};
    const params = route.regex.exec(pathname).groups || {};
    if (route.stream) return route.handler({ req, res, params, user: auth.user });
    const out = await route.handler({ req, body, params, user: auth?.user, session: auth?.session });
    if (route.publish) events.publish(route.publish);
    send(res, out.status || 200, out.body, out.headers);
  }

  function serveFile(res, file, type) {
    fs.readFile(path.join(config.publicDir, file), (e, data) => {
      if (e) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  function redirect(res, location) {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  function handlePage(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    const signedIn = () => Boolean(accounts.resolveSession(readCookie(req)));
    if (pathname === '/' || pathname === '/index.html') return signedIn() ? serveFile(res, 'index.html', 'text/html; charset=utf-8') : redirect(res, '/login');
    if (pathname === '/login') return signedIn() ? redirect(res, '/') : serveFile(res, 'login.html', 'text/html; charset=utf-8');
    // Health check for systemd/nginx/monitoring: no data, no auth, just liveness
    // and a trivial read from both databases.
    if (pathname === '/healthz') {
      try {
        accounts.db.prepare('SELECT 1').get();
        ledger.db.prepare('SELECT 1').get();
        return send(res, 200, { ok: true });
      } catch {
        return send(res, 503, { ok: false });
      }
    }
    if (pathname === '/favicon.ico') { res.writeHead(204, SECURITY_HEADERS); return res.end(); }
    const file = STATIC_FILES[pathname];
    if (file) return serveFile(res, file[0], file[1]);
    send(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    // Method, path and status only: never bodies, cookies, query strings or headers.
    if (config.logRequests) res.on('finish', () => console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else handlePage(req, res, pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('Unhandled error on', req.method, pathname, e.stack);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal server error.' : e.message });
    }
  });

  const purge = setInterval(() => accounts.purgeExpiredSessions(), 15 * 60_000);
  purge.unref();
  server.on('close', () => clearInterval(purge));

  const close = () => new Promise(resolve => {
    telegram?.stop();
    events.close();
    server.close(() => { accounts.db.close(); ledger.db.close(); resolve(); });
    server.closeAllConnections();
  });

  return { server, accounts, ledger, limiter, events, telegram, close };
}

module.exports = { createApp };
