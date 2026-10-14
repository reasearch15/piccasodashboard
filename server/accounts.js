'use strict';
const crypto = require('node:crypto');
const { transaction } = require('./db');
const { hashPassword, verifyPassword, validatePassword } = require('./passwords');

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 3–32 characters: letters, numbers, dot, underscore or hyphen, starting with a letter or number.';
  }
  return null;
}

// The only user shape that ever leaves the server. Password hashes never do.
const publicUser = u => u && {
  id: u.id,
  username: u.username,
  role: u.role,
  disabled: Boolean(u.disabled),
  createdAt: u.created_at,
  passwordChangedAt: u.password_changed_at,
};

class Accounts {
  constructor(db, { sessionIdleMs, sessionAbsoluteMs }) {
    this.db = db;
    this.sessionIdleMs = sessionIdleMs;
    this.sessionAbsoluteMs = sessionAbsoluteMs;
    // Verified against when a username does not exist, so unknown and known
    // usernames take the same time to reject.
    this.dummyHash = hashPassword(randomToken());
  }

  // ---- users -------------------------------------------------------------
  findById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  findByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  listStaff() {
    return this.db.prepare("SELECT * FROM users WHERE role = 'staff' ORDER BY created_at, username").all().map(publicUser);
  }

  async createUser({ username, password, role, createdById = null }) {
    const err = validateUsername(username) || validatePassword(password);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    if (this.findByUsername(username)) throw Object.assign(new Error('That username already exists.'), { status: 409 });
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      this.db.prepare(`INSERT INTO users (id, username, role, password_hash, disabled, created_at, created_by_id, updated_at, password_changed_at)
                       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(id, username, role, hash, now, createdById, now, now);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw Object.assign(new Error('That username already exists.'), { status: 409 });
      throw e;
    }
    return this.findById(id);
  }

  // Sets a new password and revokes every session the user has.
  async setPassword(userId, password) {
    const err = validatePassword(password);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?').run(hash, now, now, userId);
      this.revokeSessions(userId);
    });
  }

  setDisabled(userId, disabled) {
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, new Date().toISOString(), userId);
      if (disabled) this.revokeSessions(userId);
    });
  }

  // Returns the user only for a correct password on an enabled account. Every
  // failure path does the same Argon2 work so responses do not leak which part failed.
  async authenticate(username, password) {
    const user = typeof username === 'string' && username.length <= 64 ? this.findByUsername(username) : undefined;
    const ok = await verifyPassword(user ? user.password_hash : await this.dummyHash, typeof password === 'string' ? password : '');
    return ok && user && !user.disabled ? user : null;
  }

  // ---- sessions ----------------------------------------------------------
  createSession(userId) {
    const token = randomToken();
    const csrfToken = randomToken();
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, csrfToken, now, now, now + this.sessionAbsoluteMs);
    return { token, csrfToken };
  }

  // Resolves a cookie token to { session, user }, enforcing idle and absolute
  // expiry and the account's disabled flag on every request.
  resolveSession(token, { touch = true } = {}) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const tokenHash = sha256(token);
    const row = this.db.prepare(`SELECT s.token_hash, s.csrf_token, s.last_seen_at, s.expires_at, u.*
                                 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(tokenHash);
    if (!row) return null;
    const now = Date.now();
    if (row.disabled || now >= row.expires_at || now - row.last_seen_at >= this.sessionIdleMs) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    if (touch && now - row.last_seen_at > 30_000) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash);
    const { token_hash, csrf_token, last_seen_at, expires_at, ...user } = row;
    return { session: { tokenHash: token_hash, csrfToken: csrf_token, expiresAt: expires_at }, user };
  }

  destroySession(token) {
    if (typeof token === 'string' && token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  revokeSessions(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  countSessions(userId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;
  }

  purgeExpiredSessions() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - this.sessionIdleMs);
  }

  // ---- audit -------------------------------------------------------------
  audit(actor, action, target = null) {
    this.db.prepare('INSERT INTO audit_log (at, actor_id, actor_username, action, target_id, target_username) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), actor?.id ?? null, actor?.username ?? null, action, target?.id ?? null, target?.username ?? null);
  }
}

// One-time admin initialisation used by `npm run init-admin` (and tests).
async function initAdmin(accounts, username, password, { resetPassword = false } = {}) {
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const existing = accounts.findByUsername(username);
  const otherAdmin = accounts.db.prepare("SELECT username FROM users WHERE role = 'admin' AND username <> ?").get(username);
  if (otherAdmin) throw new Error(`A different admin account already exists (${otherAdmin.username}).`);
  if (existing) {
    if (existing.role !== 'admin') throw new Error(`"${username}" exists as a staff account; refusing to promote it.`);
    if (!resetPassword) throw new Error(`Admin "${existing.username}" already exists. Use --reset-password to replace its password.`);
    await accounts.setPassword(existing.id, password);
    accounts.audit(null, 'admin_password_reset_cli', existing);
    return { user: existing, created: false };
  }
  const user = await accounts.createUser({ username, password, role: 'admin' });
  accounts.audit(null, 'admin_initialised_cli', user);
  return { user, created: true };
}

module.exports = { Accounts, initAdmin, publicUser, validateUsername };
