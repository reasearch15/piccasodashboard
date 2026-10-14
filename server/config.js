'use strict';
const path = require('node:path');
const { loadTelegramConfig } = require('./telegram/config');

const ROOT = path.resolve(__dirname, '..');

function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`);
  return n;
}

function bool(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false".`);
}

function loadConfig(env = process.env) {
  // demo: data/demo-ledger.db, seeded with sample data, resettable.
  // production: data/ledger.db, never seeded, never reset. Separate files, so
  // demo and real transactions can never share tables.
  // On a production host (NODE_ENV=production) the mode must be stated and
  // must be "production": a missing variable can never fall back to demo data.
  const isProductionHost = env.NODE_ENV === 'production';
  if (isProductionHost && env.PICASSO_LEDGER_MODE !== 'production') {
    throw new Error('NODE_ENV=production requires PICASSO_LEDGER_MODE=production (demo data is never served in production).');
  }
  const ledgerMode = env.PICASSO_LEDGER_MODE || 'demo';
  if (!['demo', 'production'].includes(ledgerMode)) throw new Error('PICASSO_LEDGER_MODE must be "demo" or "production".');
  const cookieSecure = env.PICASSO_COOKIE_SECURE || 'auto';
  if (!['auto', 'true', 'false'].includes(cookieSecure)) throw new Error('PICASSO_COOKIE_SECURE must be auto, true or false.');

  // Financial activation boundary. Telegram messages dated before it are never
  // recorded. Must carry an explicit UTC offset so it is unambiguous.
  const startRaw = env.PICASSO_PAYMENT_START_AT || '';
  let paymentStartMs = null;
  if (startRaw) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(startRaw) || Number.isNaN(Date.parse(startRaw))) {
      throw new Error('PICASSO_PAYMENT_START_AT must be an ISO timestamp with an explicit offset, e.g. 2026-10-13T00:00:00+05:45.');
    }
    paymentStartMs = Date.parse(startRaw);
  } else if (ledgerMode === 'production') {
    throw new Error('PICASSO_PAYMENT_START_AT is required in production ledger mode.');
  }

  const telegram = loadTelegramConfig(env);
  if (telegram.enabled) {
    telegram.paymentStartMs = paymentStartMs;
    // Real Telegram data may only ever land in the production ledger.
    if (telegram.apiBase === 'https://api.telegram.org' && ledgerMode !== 'production') throw new Error('Live Telegram requires PICASSO_LEDGER_MODE=production.');
    if (telegram.ingestSecret && ledgerMode !== 'production') throw new Error('The user-account listener ingest requires PICASSO_LEDGER_MODE=production.');
    if (telegram.venmoParser === 'provisional' && ledgerMode === 'production') throw new Error('The provisional Venmo parser is not allowed in production; Venmo messages go to Admin Attention until a verified format exists.');
  }

  return {
    host: env.PICASSO_HOST || '127.0.0.1',
    port: env.PICASSO_PORT === '0' ? 0 : int(env.PICASSO_PORT, 3000, 'PICASSO_PORT'),
    dataDir: path.resolve(ROOT, env.PICASSO_DATA_DIR || 'data'),
    publicDir: path.join(ROOT, 'public'),
    ledgerMode,
    adminUsername: env.PICASSO_ADMIN_USERNAME || 'CharsiNew',
    sessionIdleMs: int(env.PICASSO_SESSION_IDLE_MINUTES, 120, 'PICASSO_SESSION_IDLE_MINUTES') * 60_000,
    sessionAbsoluteMs: int(env.PICASSO_SESSION_ABSOLUTE_HOURS, 12, 'PICASSO_SESSION_ABSOLUTE_HOURS') * 3_600_000,
    cookieSecure,
    trustProxy: bool(env.PICASSO_TRUST_PROXY, false, 'PICASSO_TRUST_PROXY'),
    loginLimits: {
      windowMs: 15 * 60_000,
      perUserIp: int(env.PICASSO_LOGIN_MAX_PER_USER_IP, 5, 'PICASSO_LOGIN_MAX_PER_USER_IP'),
      perIp: int(env.PICASSO_LOGIN_MAX_PER_IP, 20, 'PICASSO_LOGIN_MAX_PER_IP'),
      perUser: int(env.PICASSO_LOGIN_MAX_PER_USER, 20, 'PICASSO_LOGIN_MAX_PER_USER'),
    },
    logRequests: env.PICASSO_LOG_REQUESTS !== 'false',
    paymentStartMs,
    paymentStartRaw: startRaw || null,
    telegram,
  };
}

module.exports = { loadConfig, ROOT };
