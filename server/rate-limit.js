'use strict';

// In-memory sliding-window limiter for failed logins. Counts failures per
// (username, IP), per IP and per username. Unknown usernames are counted the
// same way as real ones, so a 429 reveals nothing about account existence.
class LoginLimiter {
  constructor({ windowMs, perUserIp, perIp, perUser }) {
    this.windowMs = windowMs;
    this.limits = { pair: perUserIp, ip: perIp, user: perUser };
    this.failures = new Map();
  }

  keys(ip, username) {
    const user = String(username ?? '').toLowerCase().slice(0, 64);
    return { pair: `pair:${user}\n${ip}`, ip: `ip:${ip}`, user: `user:${user}` };
  }

  recent(key, now) {
    const list = (this.failures.get(key) || []).filter(t => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list); else this.failures.delete(key);
    return list;
  }

  isBlocked(ip, username, now = Date.now()) {
    const keys = this.keys(ip, username);
    return Object.entries(keys).some(([kind, key]) => this.recent(key, now).length >= this.limits[kind]);
  }

  recordFailure(ip, username, now = Date.now()) {
    for (const key of Object.values(this.keys(ip, username))) {
      const list = this.recent(key, now);
      list.push(now);
      this.failures.set(key, list);
    }
    if (this.failures.size > 50_000) this.prune(now);
  }

  recordSuccess(ip, username) {
    this.failures.delete(this.keys(ip, username).pair);
  }

  prune(now = Date.now()) {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }
}

module.exports = { LoginLimiter };
