"""Command line.

  python -m picasso_listener check            validate configuration (no network)
  python -m picasso_listener login            one-time interactive login (owner only)
  python -m picasso_listener run              the service (systemd)
  python -m picasso_listener export-history --out FILE
                                              owner-approved history export for the preview
  python -m picasso_listener evidence-login   login a dedicated evidence session
  python -m picasso_listener export-venmo-evidence --ids RANGE --out FILE
                                              approved Venmo evidence ranges only
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import stat
import sys

from .client import ReadOnlyClient
from .config import ConfigError, load_config
from .core import Listener
from .evidence import APPROVED_EVIDENCE_RANGES, evidence_settings, export_venmo_evidence
from .history import export_history
from .ingest import IngestClient
from .state import CursorState

log = logging.getLogger("picasso_listener")


def secure_session_file(path: str) -> None:
    """The session file is a full login: owner-only, in an owner-only directory."""
    directory = os.path.dirname(path)
    st = os.stat(directory)
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH | stat.S_IRWXO):
        raise ConfigError(f"{directory} must not be accessible to other users (chmod 700).")
    for candidate in (path, path + ".session"):
        if os.path.exists(candidate):
            os.chmod(candidate, 0o600)


def telethon_client(cfg, *, session_path=None, receive_updates=True):
    from telethon import TelegramClient  # imported lazily so tests need no network
    return TelegramClient(
        session_path or cfg.session_path, cfg.api_id, cfg.api_hash,
        auto_reconnect=True, connection_retries=10, retry_delay=5,
        flood_sleep_threshold=60, receive_updates=receive_updates,
    )


async def run(cfg) -> int:
    from telethon import events
    secure_session_file(cfg.session_path)
    raw = telethon_client(cfg)
    client = ReadOnlyClient(raw)
    await client.connect()
    if not await client.is_user_authorized():
        log.error("Session is not logged in. Run `python -m picasso_listener login` as the listener user first.")
        return 3
    listener = Listener(cfg, client, IngestClient(cfg.ingest_base_url, cfg.ingest_secret), CursorState(cfg.state_path))
    chats = list(cfg.chats)

    async def on_new(event):
        await listener.on_new(event.message)

    async def on_edit(event):
        await listener.on_edit(event.message)

    client.add_event_handler(on_new, events.NewMessage(chats=chats))
    client.add_event_handler(on_edit, events.MessageEdited(chats=chats))
    await listener.start()
    log.info("Listening (read-only). %s", cfg.summary())
    try:
        await client.run_until_disconnected()
    finally:
        await listener.stop()
    log.error("Disconnected from Telegram; exiting so systemd restarts the listener.")
    return 1


async def login(cfg) -> int:
    raw = telethon_client(cfg)
    await raw.start()  # interactive: phone number, code, 2FA password
    me = await raw.get_me()
    await raw.disconnect()
    secure_session_file(cfg.session_path)
    print(f"Logged in as user id {me.id}. Session stored at {cfg.session_path} (mode 600).")
    return 0


async def export(cfg, out) -> int:
    secure_session_file(cfg.session_path)
    client = ReadOnlyClient(telethon_client(cfg))
    await client.connect()
    if not await client.is_user_authorized():
        log.error("Session is not logged in.")
        return 3
    meta = await export_history(client, cfg, out)
    await client.disconnect()
    for chat, info in meta["chats"].items():
        print(f"{info['method']} {chat}: {info['messages']} message(s); reached boundary: {info['reachedBoundary']}; flood waits: {info['floodWaits']}")
    print(f"Export written to {out}. Next: node server/backfill.js preview {out}  (nothing has been imported)")
    return 0


async def evidence_login(cfg) -> int:
    path = evidence_settings(cfg)
    secure_session_file(path)
    raw = telethon_client(cfg, session_path=path, receive_updates=False)
    await raw.start()  # interactive: creates a distinct Telegram authorization
    me = await raw.get_me()
    await raw.disconnect()
    secure_session_file(path)
    print(f"Dedicated evidence session logged in as user id {me.id}; stored at {path} (mode 600).")
    return 0


async def export_evidence(cfg, out, range_spec) -> int:
    path = evidence_settings(cfg)
    secure_session_file(path)
    client = ReadOnlyClient(telethon_client(cfg, session_path=path, receive_updates=False))
    await client.connect()
    try:
        if not await client.is_user_authorized():
            log.error("Dedicated evidence session is not logged in. Run `python -m picasso_listener evidence-login` first.")
            return 3
        result = await export_venmo_evidence(client, out, range_spec=range_spec)
    finally:
        await client.disconnect()
    print(f"Exported {result['messages']} Venmo messages ({range_spec}) to {out}.")
    print(f"SHA-256: {result['sha256']} (also written to {result['checksumPath']})")
    print("Nothing was sent to Picasso and no listener cursor was read or changed.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="picasso_listener")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sub.add_parser("login")
    sub.add_parser("run")
    sub.add_parser("evidence-login")
    exp = sub.add_parser("export-history")
    exp.add_argument("--out", required=True)
    evidence = sub.add_parser("export-venmo-evidence")
    evidence.add_argument("--ids", required=True, choices=APPROVED_EVIDENCE_RANGES)
    evidence.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("telethon").setLevel(logging.WARNING)
    try:
        cfg = load_config()
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        return 2
    if args.command == "check":
        print("Configuration OK. " + cfg.summary())
        return 0
    if args.command == "login":
        return asyncio.run(login(cfg))
    if args.command == "evidence-login":
        return asyncio.run(evidence_login(cfg))
    if args.command == "export-history":
        return asyncio.run(export(cfg, args.out))
    if args.command == "export-venmo-evidence":
        return asyncio.run(export_evidence(cfg, args.out, args.ids))
    return asyncio.run(run(cfg))


if __name__ == "__main__":
    sys.exit(main())
