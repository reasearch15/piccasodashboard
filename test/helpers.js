'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const { initAdmin } = require('../server/accounts');

// Passwords are generated per run; none are hardcoded in the repository.
const randomPassword = () => crypto.randomBytes(18).toString('base64url');

// Pass { dataDir, adminPassword } to restart on an existing data directory.
async function startServer(env = {}, reuse = null) {
  const dataDir = reuse?.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'picasso-test-'));
  const config = loadConfig({ PICASSO_DATA_DIR: dataDir, PICASSO_PORT: '0', PICASSO_LOG_REQUESTS: 'false', ...env });
  const app = createApp(config);
  const adminPassword = reuse?.adminPassword ?? randomPassword();
  if (!reuse) await initAdmin(app.accounts, config.adminUsername, adminPassword);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app, config, base, dataDir, adminUsername: config.adminUsername, adminPassword,
    client: () => new Client(base),
    async close({ keep = false } = {}) {
      await app.close();
      if (keep) return;
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// A minimal browser-like client: one cookie jar, CSRF token kept in memory.
class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.csrf = null; }

  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }

  async request(method, url, body, { headers = {}, csrf = true, redirect = 'manual' } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (this.cookies.size) h.Cookie = this.cookieHeader();
    if (method !== 'GET') {
      h['Content-Type'] ??= 'application/json';
      if (csrf && this.csrf) h['X-CSRF-Token'] ??= this.csrf;
    }
    const res = await fetch(this.base + url, { method, headers: h, redirect, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (!value || /Max-Age=0/i.test(sc)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await res.text();
    Client.transcript.push(text);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, headers: res.headers, text, json, setCookies: res.headers.getSetCookie() };
  }

  get(url, opts) { return this.request('GET', url, undefined, opts); }
  post(url, body, opts) { return this.request('POST', url, body, opts); }

  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    if (r.status === 200) this.csrf = r.json.csrfToken;
    return r;
  }

  // Copy of the current cookie/CSRF state, i.e. "another tab" or a stolen session.
  clone() {
    const c = new Client(this.base);
    c.cookies = new Map(this.cookies);
    c.csrf = this.csrf;
    return c;
  }
}

// Every response body seen by any client, for the "no secrets in responses" test.
Client.transcript = [];

module.exports = { startServer, randomPassword, Client };
