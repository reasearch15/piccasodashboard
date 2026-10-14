'use strict';
// Local stand-in for the Telegram Bot API. Records every call and can be told
// to fail specific methods. No request ever leaves the machine.
const http = require('node:http');

async function startMockTelegram(token) {
  const state = {
    calls: [],
    fail: {},          // method -> number of upcoming failures (Infinity = always)
    failWith: {},      // method -> { status, description, retry_after }
    webhookUrl: '',
    nextMessageId: 5000,
    updates: [],
    botId: 424242,
    delayMs: {},       // method -> milliseconds before answering (simulates an in-flight request)
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
      const delay = m ? state.delayMs[m[2]] || 0 : 0;
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const reply = (status, payload) => (delay ? setTimeout(() => send(status, payload), delay) : send(status, payload));
      if (!m || m[1] !== token) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2];
      const params = body ? JSON.parse(body) : {};
      state.calls.push({ method, params });
      if (state.fail[method] > 0) {
        state.fail[method]--;
        const f = state.failWith[method] || { status: 502, description: 'Bad Gateway' };
        return reply(f.status, { ok: false, error_code: f.status, description: f.description, ...(f.retry_after ? { parameters: { retry_after: f.retry_after } } : {}) });
      }
      switch (method) {
        case 'getMe': return reply(200, { ok: true, result: { id: state.botId, is_bot: true, first_name: 'Picasso Test Bot', username: 'picasso_test_bot' } });
        case 'getWebhookInfo': return reply(200, { ok: true, result: { url: state.webhookUrl, pending_update_count: 0 } });
        case 'getUpdates': {
          const offset = params.offset || 0;
          const result = state.updates.filter(u => u.update_id >= offset);
          if (!result.length) return setTimeout(() => reply(200, { ok: true, result: [] }), 50);
          return reply(200, { ok: true, result });
        }
        case 'sendMessage': return reply(200, { ok: true, result: { message_id: ++state.nextMessageId, chat: { id: Number(params.chat_id) }, from: { id: state.botId, is_bot: true }, date: Math.floor(Date.now() / 1000), text: params.text } });
        case 'editMessageText': return reply(200, { ok: true, result: { message_id: params.message_id } });
        case 'answerCallbackQuery': return reply(200, { ok: true, result: true });
        case 'deleteMessage': {
          // Real Telegram answers "message to delete not found" for a second delete.
          state.deleted ??= new Set();
          const key = `${params.chat_id}:${params.message_id}`;
          if (state.deleted.has(key)) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' });
          state.deleted.add(key);
          return reply(200, { ok: true, result: true });
        }
        default: return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    state,
    base: `http://127.0.0.1:${server.address().port}`,
    callsOf: method => state.calls.filter(c => c.method === method),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}

module.exports = { startMockTelegram };
