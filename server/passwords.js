'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

if (typeof crypto.argon2 !== 'function') {
  throw new Error('Node.js 24.7 or newer is required (built-in Argon2id support).');
}
const argon2 = promisify(crypto.argon2);

// RFC 9106 second recommended option: 64 MiB, 3 passes, 4 lanes.
const PARAMS = { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 };
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

const b64 = buf => buf.toString('base64').replace(/=+$/, '');

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
  return null;
}

async function hashPassword(password) {
  const nonce = crypto.randomBytes(16);
  const tag = await argon2('argon2id', { message: password, nonce, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(nonce)}$${b64(tag)}`;
}

async function verifyPassword(encoded, password) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded || '');
  if (!m || typeof password !== 'string') return false;
  const expected = Buffer.from(m[5], 'base64');
  const actual = await argon2('argon2id', {
    message: password,
    nonce: Buffer.from(m[4], 'base64'),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword, validatePassword, MIN_LENGTH, MAX_LENGTH };
