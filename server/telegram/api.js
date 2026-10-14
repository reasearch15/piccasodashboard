'use strict';
// Minimal official Bot API client. The token is part of the request URL, so
// URLs are never logged or included in error messages.

class TelegramApiError extends Error {
  constructor(method, status, description, retryAfter) {
    super(`Telegram ${method} failed${status ? ` (${status})` : ''}: ${description}`);
    this.method = method;
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

class TelegramApi {
  constructor({ apiBase, token, timeoutMs = 35_000 }) {
    this.url = method => `${apiBase}/bot${token}/${method}`;
    this.timeoutMs = timeoutMs;
  }

  async call(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    let res;
    try {
      res = await fetch(this.url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TelegramApiError(method, 0, e.name === 'TimeoutError' ? 'timed out' : 'network error');
    }
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      throw new TelegramApiError(method, res.status, String(data?.description || 'invalid response').slice(0, 200), data?.parameters?.retry_after);
    }
    return data.result;
  }
}

module.exports = { TelegramApi, TelegramApiError };
