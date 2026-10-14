'use strict';
// Server-Sent Events hub for live dashboard updates. Events carry only a
// "something changed" signal with topic names, never data: clients reload
// through the normal role-checked APIs, so the database stays authoritative
// and staff never receive admin-only figures over this channel.

const HEARTBEAT_MS = 25_000;

class EventHub {
  constructor(accounts) {
    this.accounts = accounts;
    this.clients = new Set();
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  // Session is re-checked without refreshing its idle timer, so an open
  // stream never keeps an otherwise idle session alive, and a disabled or
  // logged-out user's stream is closed at the next check.
  alive(client) {
    if (this.accounts.resolveSession(client.token, { touch: false })) return true;
    this.drop(client);
    return false;
  }

  drop(client) {
    this.clients.delete(client);
    client.res.end();
  }

  open(req, res, token) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 3000\n\nevent: ready\ndata: {}\n\n');
    const client = { res, token };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
  }

  publish(topics) {
    const msg = `event: change\ndata: ${JSON.stringify({ topics })}\n\n`;
    for (const c of [...this.clients]) if (this.alive(c)) c.res.write(msg);
  }

  heartbeat() {
    for (const c of [...this.clients]) if (this.alive(c)) c.res.write(': ping\n\n');
  }

  close() {
    clearInterval(this.timer);
    for (const c of [...this.clients]) this.drop(c);
  }
}

module.exports = { EventHub };
