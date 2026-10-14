"""Bounded, read-only Telegram evidence export for Venmo reconciliation.

This module deliberately has no dependency on the listener cursor or ingest
client.  It fetches one fixed, reviewed set of message IDs through a separate
Telethon session and validates the entire response before writing anything.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import time

from .config import ConfigError
from .core import message_payload

VENMO_CHAT_ID = -5306739731
LARRY_BOT_ID = 8614082158
EVIDENCE_IDS = tuple(range(15185, 15208))
EVIDENCE_RANGE = "15185-15207"


def _session_file(path: str) -> str:
    return path if path.endswith(".session") else path + ".session"


def evidence_settings(cfg, env=None) -> str:
    """Validate the fixed evidence target and return an isolated session path."""
    env = os.environ if env is None else env
    if cfg.chats.get(VENMO_CHAT_ID) != "Venmo":
        raise ConfigError(f"Venmo evidence requires configured group {VENMO_CHAT_ID}.")
    senders = [v.strip() for v in env.get("PICASSO_PAYMENT_SOURCE_SENDER_IDS", "").split(",") if v.strip()]
    if senders != [str(LARRY_BOT_ID)]:
        raise ConfigError(f"PICASSO_PAYMENT_SOURCE_SENDER_IDS must be exactly {LARRY_BOT_ID} for this export.")

    path = env.get("PICASSO_EVIDENCE_SESSION", "").strip()
    if not path or not os.path.isabs(path):
        raise ConfigError("PICASSO_EVIDENCE_SESSION must be an absolute path for a dedicated evidence session.")
    if re.search(r"teleledger|atlas|royal|appbeg", path, re.I):
        raise ConfigError("PICASSO_EVIDENCE_SESSION must be Picasso's own dedicated session.")

    live = os.path.realpath(_session_file(cfg.session_path))
    evidence = os.path.realpath(_session_file(path))
    if os.path.normcase(live) == os.path.normcase(evidence):
        raise ConfigError("PICASSO_EVIDENCE_SESSION must not be the live listener session.")
    if os.path.lexists(_session_file(path)) and os.path.islink(_session_file(path)):
        raise ConfigError("PICASSO_EVIDENCE_SESSION must not be a symbolic link.")
    if os.path.exists(live) and os.path.exists(evidence) and os.path.samefile(live, evidence):
        raise ConfigError("PICASSO_EVIDENCE_SESSION aliases the live listener session.")
    return path


def _exclusive_write(path: str, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
    finally:
        os.close(fd)


async def export_venmo_evidence(client, out_path: str, *, now=time.time) -> dict:
    """Fetch and export exactly EVIDENCE_IDS, or fail without an evidence file."""
    checksum_path = out_path + ".sha256"
    for path in (out_path, checksum_path):
        if os.path.lexists(path):
            raise FileExistsError(f"{path} already exists; choose a new file name")

    returned = await client.get_messages(VENMO_CHAT_ID, ids=list(EVIDENCE_IDS))
    messages = list(returned) if returned is not None else []
    by_id = {}
    for msg in messages:
        if msg is None:
            continue
        message_id = int(msg.id)
        if message_id not in EVIDENCE_IDS:
            raise ValueError(f"Telegram returned unexpected message {message_id}.")
        if message_id in by_id:
            raise ValueError(f"Telegram returned duplicate message {message_id}.")
        if int(msg.chat_id) != VENMO_CHAT_ID:
            raise ValueError(f"Message {message_id} belongs to unexpected chat {msg.chat_id}.")
        if msg.sender_id is None or int(msg.sender_id) != LARRY_BOT_ID:
            raise ValueError(f"Message {message_id} has unexpected sender {msg.sender_id}.")
        if getattr(msg, "edit_date", None) is not None:
            raise ValueError(f"Message {message_id} was edited; refusing it as evidence.")
        if not isinstance(getattr(msg, "message", None), str) or not msg.message:
            raise ValueError(f"Message {message_id} has no text.")
        by_id[message_id] = msg

    missing = [message_id for message_id in EVIDENCE_IDS if message_id not in by_id]
    if missing:
        raise ValueError("Telegram did not return required message(s): " + ", ".join(map(str, missing)))

    rows = [message_payload(by_id[message_id], edited=False) for message_id in EVIDENCE_IDS]
    meta = {
        "kind": "picasso-venmo-sender-evidence-v1",
        "source": "direct-telegram-api",
        "exportedAt": int(now()),
        "chatId": VENMO_CHAT_ID,
        "messageIds": EVIDENCE_RANGE,
        "senderId": LARRY_BOT_ID,
        "messageCount": len(rows),
        "editedMessagesAccepted": False,
    }
    payload = ("\n".join(json.dumps(row, separators=(",", ":")) for row in rows)
               + "\n" + json.dumps({"_meta": meta}, separators=(",", ":")) + "\n").encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    checksum = f"{digest}  {os.path.basename(out_path)}\n".encode("ascii")

    created = []
    try:
        _exclusive_write(out_path, payload)
        created.append(out_path)
        _exclusive_write(checksum_path, checksum)
        created.append(checksum_path)
    except Exception:
        for path in created:
            try:
                os.unlink(path)
            except OSError:
                pass
        raise
    return {"messages": len(rows), "sha256": digest, "checksumPath": checksum_path}
