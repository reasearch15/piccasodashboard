"""History export for the import preview (owner-approved runs only).

Reads the configured groups from the activation boundary to now and writes
JSON Lines for `server/backfill.js preview`. Read-only towards Telegram and
never sends anything to Picasso: importing is a separate, approved step.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import timedelta

from .core import epoch, is_flood_wait, message_payload

log = logging.getLogger("picasso_listener")


async def export_history(client, cfg, out_path, *, sleep=asyncio.sleep, now=time.time):
    if os.path.exists(out_path):
        raise FileExistsError(f"{out_path} already exists; choose a new file name")
    meta = {"exportedAt": int(now()), "boundary": cfg.boundary.isoformat(), "chats": {}}
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        for chat_id, method in cfg.chats.items():
            info = {"method": method, "messages": 0, "oldestDate": None, "newestDate": None, "reachedBoundary": False, "floodWaits": 0}
            # Is anything visible from before the boundary? If not, history may
            # start later (group created later, or hidden from new members).
            before = await client.get_messages(chat_id, limit=1, offset_date=cfg.boundary)
            info["reachedBoundary"] = bool(before)
            last_id = 0
            # One second earlier than the boundary so a message at exactly
            # 00:00 is never lost; Picasso applies the exact cutoff itself.
            start = cfg.boundary - timedelta(seconds=1)
            while True:
                try:
                    kwargs = {"reverse": True}
                    if last_id:
                        kwargs["min_id"] = last_id
                    else:
                        kwargs["offset_date"] = start
                    async for m in client.iter_messages(chat_id, **kwargs):
                        if not getattr(m, "message", None):
                            last_id = m.id
                            continue  # service messages (joins, pins) carry no text
                        out.write(json.dumps(message_payload(m, edited=bool(getattr(m, "edit_date", None)))) + "\n")
                        info["messages"] += 1
                        d = epoch(m.date)
                        info["oldestDate"] = info["oldestDate"] or d
                        info["newestDate"] = d
                        last_id = m.id
                    break
                except Exception as e:  # noqa: BLE001 - only flood waits are retried
                    if not is_flood_wait(e) or info["floodWaits"] >= 20:
                        raise
                    info["floodWaits"] += 1
                    wait = min(e.seconds, cfg.flood_wait_max_seconds)
                    log.warning("Flood control while exporting chat %s: waiting %ss, then resuming after message %s.", chat_id, wait, last_id)
                    await sleep(wait + 1)
            meta["chats"][str(chat_id)] = info
            log.info("%s chat %s: exported %s message(s).", method, chat_id, info["messages"])
        out.write(json.dumps({"_meta": meta}) + "\n")
    return meta
