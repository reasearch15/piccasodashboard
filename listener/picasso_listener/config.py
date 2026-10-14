"""Listener configuration, read from the environment (systemd EnvironmentFile).

Secrets (API hash, ingest secret) are excluded from repr() so they can never
end up in a log line or traceback through the config object.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlparse


class ConfigError(Exception):
    pass


CHAT_ID_RE = re.compile(r"^-?\d{1,20}$")
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@dataclass(frozen=True)
class Config:
    api_id: int
    api_hash: str = field(repr=False)
    session_path: str
    chats: dict  # chat id (int) -> "Chime" | "Venmo"
    ingest_base_url: str
    ingest_secret: str = field(repr=False)
    state_path: str
    boundary: datetime
    catchup_max_hours: int
    catchup_max_messages: int
    flood_wait_max_seconds: int

    def summary(self) -> str:
        """Human-readable configuration without any secret."""
        chats = ", ".join(f"{m} {c}" for c, m in self.chats.items())
        return (
            f"chats: {chats}; ingest: {self.ingest_base_url}; session: {self.session_path}; "
            f"state: {self.state_path}; boundary: {self.boundary.isoformat()}; "
            f"catch-up window: {self.catchup_max_hours}h / {self.catchup_max_messages} messages"
        )


def _int(env, name, default, lo, hi):
    raw = env.get(name, "")
    if raw == "":
        return default
    if not raw.isdigit() or not lo <= int(raw) <= hi:
        raise ConfigError(f"{name} must be a whole number from {lo} to {hi}.")
    return int(raw)


def load_config(env=None) -> Config:
    env = os.environ if env is None else env
    errors = []

    api_id = env.get("PICASSO_TG_API_ID", "")
    if not api_id.isdigit():
        errors.append("PICASSO_TG_API_ID must be the numeric api_id from my.telegram.org.")
    api_hash = env.get("PICASSO_TG_API_HASH", "")
    if not re.fullmatch(r"[0-9a-f]{32}", api_hash):
        errors.append("PICASSO_TG_API_HASH must be the 32-character api_hash from my.telegram.org.")

    session = env.get("PICASSO_TG_SESSION", "")
    if not session or not os.path.isabs(session):
        errors.append("PICASSO_TG_SESSION must be an absolute path for Picasso's own session file.")
    elif re.search(r"teleledger|atlas|royal|appbeg", session, re.I):
        errors.append("PICASSO_TG_SESSION must be Picasso's own session, not another application's.")

    chats = {}
    for name, method in (("PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID", "Chime"), ("PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID", "Venmo")):
        v = env.get(name, "").strip()
        if not CHAT_ID_RE.fullmatch(v):
            errors.append(f"{name} must be a numeric Telegram chat ID.")
        else:
            chats[int(v)] = method
    chime_raw = env.get("PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID", "").strip()
    if chime_raw and chime_raw == env.get("PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID", "").strip():
        errors.append("Chime and Venmo incoming groups must be different chats.")

    base = env.get("PICASSO_LISTENER_INGEST_URL", "http://127.0.0.1:3300").rstrip("/")
    u = urlparse(base)
    if u.scheme != "http" or u.hostname not in LOOPBACK or u.path not in ("", "/"):
        errors.append("PICASSO_LISTENER_INGEST_URL must be http://127.0.0.1:<port> (the local dashboard only).")

    secret = env.get("PICASSO_LISTENER_INGEST_SECRET", "")
    if not SECRET_RE.fullmatch(secret):
        errors.append("PICASSO_LISTENER_INGEST_SECRET must be 32+ characters of A-Z a-z 0-9 _ -.")

    state = env.get("PICASSO_LISTENER_STATE", "")
    if not state or not os.path.isabs(state):
        errors.append("PICASSO_LISTENER_STATE must be an absolute path for the cursor file.")

    boundary = None
    raw = env.get("PICASSO_PAYMENT_START_AT", "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})", raw):
        errors.append("PICASSO_PAYMENT_START_AT must be an ISO timestamp with an explicit offset.")
    else:
        boundary = datetime.fromisoformat(raw.replace("Z", "+00:00"))

    try:
        hours = _int(env, "PICASSO_LISTENER_CATCHUP_MAX_HOURS", 6, 1, 72)
        max_messages = _int(env, "PICASSO_LISTENER_CATCHUP_MAX_MESSAGES", 500, 1, 10000)
        flood_max = _int(env, "PICASSO_LISTENER_FLOOD_WAIT_MAX_SECONDS", 900, 1, 86400)
    except ConfigError as e:
        errors.append(str(e))
        hours = max_messages = flood_max = 0

    if errors:
        raise ConfigError("Invalid listener configuration:\n - " + "\n - ".join(errors))
    return Config(
        api_id=int(api_id), api_hash=api_hash, session_path=session, chats=chats,
        ingest_base_url=base, ingest_secret=secret, state_path=state, boundary=boundary,
        catchup_max_hours=hours, catchup_max_messages=max_messages, flood_wait_max_seconds=flood_max,
    )
