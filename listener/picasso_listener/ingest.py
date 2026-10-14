"""HTTP client for Picasso's local ingestion endpoints (loopback only).

Temporary problems (dashboard restarting, 5xx, 429) are retried with backoff.
Permanent refusals (400/401/403/404) raise IngestRejected immediately. The
shared secret is sent only in a header and never appears in errors or logs.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request


class IngestRejected(Exception):
    """Picasso refused the request; retrying the same request will not help."""


class IngestUnavailable(Exception):
    """Picasso could not be reached after all retries."""


class IngestClient:
    def __init__(self, base_url: str, secret: str, *, timeout=10.0, retries=5, backoff=1.0, sleep=time.sleep):
        self._base = base_url.rstrip("/")
        self._secret = secret
        self._timeout = timeout
        self._retries = retries
        self._backoff = backoff
        self._sleep = sleep

    def __repr__(self):  # never show the secret
        return f"IngestClient({self._base!r})"

    def _post(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        last = "no attempt"
        for attempt in range(self._retries + 1):
            req = urllib.request.Request(
                self._base + path, data=body, method="POST",
                headers={"Content-Type": "application/json", "X-Picasso-Ingest-Secret": self._secret},
            )
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    return json.loads(resp.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as e:
                if e.code in (400, 401, 403, 404, 405, 413, 415):
                    raise IngestRejected(f"{path} refused with HTTP {e.code}") from None
                last = f"HTTP {e.code}"
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = type(e).__name__
            if attempt < self._retries:
                self._sleep(min(self._backoff * 2 ** attempt, 60))
        raise IngestUnavailable(f"{path} unavailable after {self._retries + 1} attempts ({last})")

    def post_message(self, payload: dict) -> dict:
        return self._post("/api/ingest/telegram-message", payload)

    def post_gap(self, payload: dict) -> dict:
        return self._post("/api/ingest/telegram-gap", payload)
