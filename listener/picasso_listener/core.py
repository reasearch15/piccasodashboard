"""Relay logic: ordering, cursor, bounded catch-up and gap reporting.

Guarantees:
  * Messages are delivered to Picasso one at a time, in order. The per-chat
    cursor advances only after Picasso acknowledged a message, so a crash or a
    dashboard outage never skips anything: delivery is retried until it works.
  * Live messages that arrive while catching up are held back until catch-up
    has finished, so the cursor never jumps past an undelivered message.
  * Catch-up after downtime is bounded (PICASSO_LISTENER_CATCHUP_MAX_HOURS and
    _MAX_MESSAGES). Anything older or beyond that is NOT imported: it is
    reported to Picasso as an ingestion gap (Admin Attention) for an approved
    historical import. The very first start reads no history at all.
  * Picasso de-duplicates by (chat ID, message ID), so re-sending after a
    restart, or overlapping with an approved import, is harmless.
"""
from __future__ import annotations

import asyncio
import logging
import time

from .ingest import IngestRejected, IngestUnavailable

log = logging.getLogger("picasso_listener")


def is_flood_wait(exc) -> bool:
    return type(exc).__name__.startswith("FloodWait") and isinstance(getattr(exc, "seconds", None), int)


def epoch(dt) -> int:
    return int(dt.timestamp())


def message_payload(msg, *, edited=False) -> dict:
    """What Picasso receives. Picasso alone decides what the message means."""
    return {
        "chatId": int(msg.chat_id),
        "messageId": int(msg.id),
        "date": epoch(msg.date),
        "text": getattr(msg, "message", None) or "",
        "senderId": None if msg.sender_id is None else int(msg.sender_id),
        "edited": bool(edited),
    }


class Listener:
    def __init__(self, cfg, client, ingest, state, *, now=time.time, sleep=asyncio.sleep, retry_delay=5.0):
        self.cfg = cfg
        self.client = client
        self.ingest = ingest
        self.state = state
        self.now = now
        self.sleep = sleep
        self.retry_delay = retry_delay
        self.queue: asyncio.Queue = asyncio.Queue()
        self.ready = False
        self.held = []
        self.worker_task = None
        self.stats = {"delivered": 0, "edits": 0, "gaps": 0, "rejected": 0, "retries": 0}

    # ---- event entry points -------------------------------------------------
    async def on_new(self, msg):
        if msg.chat_id not in self.cfg.chats:
            return
        if not self.ready:
            self.held.append(msg)
        else:
            await self.queue.put(("message", msg))

    async def on_edit(self, msg):
        if msg.chat_id in self.cfg.chats:
            await self.queue.put(("edit", msg))

    # ---- lifecycle ------------------------------------------------------------
    async def start(self):
        self.worker_task = asyncio.create_task(self._worker())
        await self.catch_up()
        self.ready = True
        for msg in sorted(self.held, key=lambda m: m.id):
            await self.queue.put(("message", msg))
        self.held.clear()

    async def stop(self):
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass

    async def drain(self):
        await self.queue.join()

    # ---- delivery -------------------------------------------------------------
    async def _worker(self):
        while True:
            item = await self.queue.get()
            try:
                await self._deliver_with_retry(item)
            finally:
                self.queue.task_done()

    async def _deliver_with_retry(self, item):
        attempt = 0
        while True:
            try:
                await self._deliver(item)
                return
            except IngestUnavailable as e:
                attempt += 1
                self.stats["retries"] += 1
                delay = min(self.retry_delay * 2 ** min(attempt - 1, 6), 300)
                log.warning("Picasso unavailable (%s); retrying in %ss. Cursor not advanced.", e, delay)
                await self.sleep(delay)
            except IngestRejected as e:
                # A permanent refusal will never succeed: record and move on so
                # one bad message cannot block every later payment.
                self.stats["rejected"] += 1
                log.error("Picasso rejected %s: %s", item[0], e)
                self._advance_after(item)
                return

    def _advance_after(self, item):
        kind = item[0]
        if kind == "message":
            msg = item[1]
            self.state.advance(msg.chat_id, msg.id, epoch(msg.date))
        elif kind == "gap":
            gap = item[1]
            self.state.advance(gap["chatId"], gap["advanceTo"], gap["toDate"])
        elif kind == "advance":
            chat_id, message_id, date = item[1]
            self.state.advance(chat_id, message_id, date)

    async def _deliver(self, item):
        kind = item[0]
        if kind == "message":
            msg = item[1]
            if msg.date < self.cfg.boundary:
                self._advance_after(item)  # before the activation boundary: never sent
                return
            result = await asyncio.to_thread(self.ingest.post_message, message_payload(msg))
            self.stats["delivered"] += 1
            log.info("chat %s message %s -> %s", msg.chat_id, msg.id, result.get("outcome"))
            self._advance_after(item)
        elif kind == "edit":
            msg = item[1]
            await asyncio.to_thread(self.ingest.post_message, message_payload(msg, edited=True))
            self.stats["edits"] += 1  # edits never move the cursor
        elif kind == "gap":
            gap = {k: v for k, v in item[1].items() if k != "advanceTo"}
            result = await asyncio.to_thread(self.ingest.post_gap, gap)
            self.stats["gaps"] += 1
            log.warning("Ingestion gap reported for chat %s (messages %s-%s, %s message(s)) -> %s",
                        gap["chatId"], gap["fromMessageId"], gap["toMessageId"], gap["count"], result.get("outcome"))
            self._advance_after(item)
        elif kind == "advance":
            self._advance_after(item)

    # ---- catch-up after downtime ------------------------------------------------
    async def _read(self, coro_factory):
        for attempt in range(6):
            try:
                return await coro_factory()
            except Exception as e:  # noqa: BLE001 - only Telegram flood waits are retried
                if not is_flood_wait(e) or attempt == 5:
                    raise
                wait = min(e.seconds, self.cfg.flood_wait_max_seconds)
                log.warning("Telegram asked us to wait %ss (flood control); waiting.", wait)
                await self.sleep(wait + 1)

    async def _latest(self, chat_id):
        msgs = await self._read(lambda: self.client.get_messages(chat_id, limit=1))
        return msgs[0] if msgs else None

    async def catch_up(self):
        now = self.now()
        window_start = max(now - self.cfg.catchup_max_hours * 3600, self.cfg.boundary.timestamp())
        limit = self.cfg.catchup_max_messages
        for chat_id, method in self.cfg.chats.items():
            cur = self.state.get(chat_id)
            if cur is None:
                # First start: live only. History before now is never read here;
                # it needs the preview + approved import.
                latest = await self._latest(chat_id)
                last_id = latest.id if latest else 0
                self.state.advance(chat_id, last_id, epoch(latest.date) if latest else int(now))
                log.info("%s chat %s: first start, live from message %s on. Earlier history requires an approved import.", method, chat_id, last_id)
                continue

            async def fetch():
                return [m async for m in self.client.iter_messages(chat_id, min_id=cur["last_id"], reverse=True, limit=limit + 1)]
            missed = await self._read(fetch)
            if not missed:
                continue
            if len(missed) > limit:
                # Too much missed to replay automatically: report it all.
                latest = await self._latest(chat_id) or missed[-1]
                await self.queue.put(("gap", {
                    "chatId": chat_id, "fromMessageId": missed[0].id, "toMessageId": latest.id,
                    "fromDate": epoch(missed[0].date), "toDate": epoch(latest.date),
                    "count": max(latest.id - cur["last_id"], len(missed)), "advanceTo": latest.id,
                }))
                continue
            stale = [m for m in missed if self.cfg.boundary.timestamp() <= m.date.timestamp() < window_start]
            fresh = [m for m in missed if m.date.timestamp() >= window_start]
            if stale:
                await self.queue.put(("gap", {
                    "chatId": chat_id, "fromMessageId": stale[0].id, "toMessageId": stale[-1].id,
                    "fromDate": epoch(stale[0].date), "toDate": epoch(stale[-1].date), "count": len(stale),
                    "advanceTo": stale[-1].id,
                }))
            for m in fresh:
                await self.queue.put(("message", m))
            if not fresh:
                last = missed[-1]
                await self.queue.put(("advance", (chat_id, last.id, epoch(last.date))))
            log.info("%s chat %s: catching up %s message(s) since %s (%s outside the window reported as a gap).",
                     method, chat_id, len(fresh), cur["last_id"], len(stale))
