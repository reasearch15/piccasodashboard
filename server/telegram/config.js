'use strict';
// Telegram configuration. Everything comes from environment variables; no
// token or group ID is ever hardcoded. Invalid configuration stops startup.

const CHAT_ID_RE = /^-?\d{1,20}$/;
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const LIVE_API = 'https://api.telegram.org';

function loadTelegramConfig(env = process.env) {
  const mode = env.PICASSO_TELEGRAM_MODE || 'off';
  if (!['off', 'polling', 'webhook'].includes(mode)) throw new Error('PICASSO_TELEGRAM_MODE must be off, polling or webhook.');
  if (mode === 'off') return { mode, enabled: false };

  const errors = [];
  const token = env.PICASSO_TELEGRAM_BOT_TOKEN || '';
  if (!TOKEN_RE.test(token)) errors.push('PICASSO_TELEGRAM_BOT_TOKEN is missing or malformed.');

  const apiBase = (env.PICASSO_TELEGRAM_API_BASE || LIVE_API).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(apiBase)) errors.push('PICASSO_TELEGRAM_API_BASE must be an origin such as https://api.telegram.org.');
  // Safety interlock: talking to the real Telegram requires an explicit opt-in.
  if (apiBase === LIVE_API && env.PICASSO_TELEGRAM_ALLOW_LIVE !== 'true') {
    errors.push('Refusing to contact the real Telegram API without PICASSO_TELEGRAM_ALLOW_LIVE=true.');
  }

  const groups = {};
  for (const [key, name] of [
    ['chimeIncoming', 'PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID'],
    ['venmoIncoming', 'PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID'],
    ['chimeCashout', 'PICASSO_TELEGRAM_CHIME_CASHOUT_CHAT_ID'],
    ['venmoCashout', 'PICASSO_TELEGRAM_VENMO_CASHOUT_CHAT_ID'],
  ]) {
    const v = (env[name] || '').trim();
    if (!CHAT_ID_RE.test(v)) errors.push(`${name} must be a numeric Telegram chat ID.`);
    groups[key] = v;
  }

  // The method of an incoming payment is derived from its group, so the two
  // incoming groups can never be shared.
  if (groups.chimeIncoming && groups.chimeIncoming === groups.venmoIncoming) {
    errors.push('Chime and Venmo incoming payment groups must be different chats.');
  }
  const ids = Object.values(groups).filter(Boolean);
  if (new Set(ids).size !== ids.length && env.PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS !== 'true') {
    errors.push('A chat is configured for more than one role. Set PICASSO_TELEGRAM_ALLOW_SHARED_GROUPS=true if that is intentional.');
  }

  const completerIds = (env.PICASSO_TELEGRAM_COMPLETER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!completerIds.length || completerIds.some(id => !/^\d{1,20}$/.test(id))) {
    errors.push('PICASSO_TELEGRAM_COMPLETER_IDS must list the numeric Telegram user IDs allowed to complete cash-outs.');
  }

  const webhookSecret = env.PICASSO_TELEGRAM_WEBHOOK_SECRET || '';
  if (mode === 'webhook' && !SECRET_RE.test(webhookSecret)) {
    errors.push('PICASSO_TELEGRAM_WEBHOOK_SECRET (32+ characters of A-Z a-z 0-9 _ -) is required in webhook mode.');
  }

  // Optional: lets a separate local user-account listener (Telethon) hand in
  // messages the Bot API cannot see (other bots' posts).
  const ingestSecret = env.PICASSO_LISTENER_INGEST_SECRET || '';
  if (ingestSecret && !SECRET_RE.test(ingestSecret)) errors.push('PICASSO_LISTENER_INGEST_SECRET must be 32+ characters of A-Z a-z 0-9 _ -.');

  // Venmo has no verified real format yet. "review" (default) sends every
  // money-like Venmo message to Admin Attention; "provisional" is for local tests only.
  const venmoParser = env.PICASSO_VENMO_PARSER || 'review';
  if (!['review', 'provisional'].includes(venmoParser)) errors.push('PICASSO_VENMO_PARSER must be review or provisional.');

  if (errors.length) throw new Error(`Invalid Telegram configuration:\n - ${errors.join('\n - ')}`);

  return {
    mode,
    enabled: true,
    token,
    apiBase,
    webhookSecret,
    ingestSecret,
    venmoParser,
    completerIds: new Set(completerIds),
    incomingMethodByChat: new Map([[groups.chimeIncoming, 'Chime'], [groups.venmoIncoming, 'Venmo']]),
    cashoutChatByMethod: { Chime: groups.chimeCashout, Venmo: groups.venmoCashout },
    configuredChats: new Set(ids),
    maxDeliveryAttempts: 10,
    maxSyncAttempts: 20,
  };
}

module.exports = { loadTelegramConfig };
