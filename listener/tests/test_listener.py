"""Listener tests: fake Telethon client, fake / local-HTTP ingestion. No network."""
import asyncio
import http.server
import json
import os
import re
import shutil
import tempfile
import threading
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

from picasso_listener.client import ReadOnlyClient
from picasso_listener.config import ConfigError, load_config
from picasso_listener.core import Listener, message_payload
from picasso_listener import evidence
from picasso_listener.evidence import EVIDENCE_IDS, LARRY_BOT_ID, VENMO_CHAT_ID, evidence_settings, export_venmo_evidence
from picasso_listener.history import export_history
from picasso_listener.ingest import IngestClient, IngestRejected, IngestUnavailable
from picasso_listener.state import CursorState

CHIME, VENMO = -5000000901, -5000000902
LARRY = 777000111
BOUNDARY = datetime.fromisoformat("2026-10-13T00:00:00+05:45")
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
SECRET = "s" * 40
API_HASH = "0123456789abcdef0123456789abcdef"


def env(tmp, **extra):
    base = {
        "PICASSO_TG_API_ID": "12345", "PICASSO_TG_API_HASH": API_HASH,
        "PICASSO_TG_SESSION": os.path.join(tmp, "picasso-listener"),
        "PICASSO_TELEGRAM_CHIME_INCOMING_CHAT_ID": str(CHIME), "PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID": str(VENMO),
        "PICASSO_LISTENER_INGEST_URL": "http://127.0.0.1:3300", "PICASSO_LISTENER_INGEST_SECRET": SECRET,
        "PICASSO_LISTENER_STATE": os.path.join(tmp, "state", "cursor.json"),
        "PICASSO_PAYMENT_START_AT": "2026-10-13T00:00:00+05:45",
        "PICASSO_LISTENER_CATCHUP_MAX_HOURS": "6", "PICASSO_LISTENER_CATCHUP_MAX_MESSAGES": "50",
    }
    base.update(extra)
    return base


class Msg:
    def __init__(self, chat_id, id, date, message="hello", sender_id=LARRY, edit_date=None):
        self.chat_id, self.id, self.date, self.message, self.sender_id, self.edit_date = chat_id, id, date, message, sender_id, edit_date


class FloodWaitError(Exception):
    def __init__(self, seconds):
        super().__init__(f"wait {seconds}")
        self.seconds = seconds


class FakeClient:
    """Enough of Telethon's read API for the listener. Records every call."""

    def __init__(self, messages, flood_on_iter=0):
        self.messages = {c: sorted(ms, key=lambda m: m.id) for c, ms in messages.items()}
        self.flood_on_iter = flood_on_iter
        self.calls = []

    async def get_messages(self, chat, limit=1, offset_date=None, ids=None):
        self.calls.append(("get_messages", chat, offset_date, ids))
        ms = self.messages.get(chat, [])
        if ids is not None:
            indexed = {m.id: m for m in ms}
            return [indexed.get(i) for i in ids]
        if offset_date is not None:
            ms = [m for m in ms if m.date < offset_date]
        return ms[-limit:][::-1]

    def iter_messages(self, chat, min_id=0, reverse=True, limit=None, offset_date=None):
        self.calls.append(("iter_messages", chat, min_id, offset_date))
        client = self

        async def gen():
            if client.flood_on_iter:
                client.flood_on_iter -= 1
                raise FloodWaitError(3)
            out = [m for m in client.messages.get(chat, []) if m.id > (min_id or 0) and (offset_date is None or m.date > offset_date)]
            for m in out[:limit] if limit else out:
                yield m
        return gen()


class FakeIngest:
    def __init__(self, unavailable=0, reject_ids=()):
        self.messages, self.gaps = [], []
        self.unavailable = unavailable
        self.reject_ids = set(reject_ids)

    def post_message(self, payload):
        if self.unavailable:
            self.unavailable -= 1
            raise IngestUnavailable("down")
        if payload["messageId"] in self.reject_ids:
            raise IngestRejected("bad")
        self.messages.append(payload)
        return {"outcome": "created"}

    def post_gap(self, payload):
        self.gaps.append(payload)
        return {"outcome": "created"}


def at(minutes_ago):
    return NOW - timedelta(minutes=minutes_ago)


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg = load_config(env(self.tmp))
        self.sleeps = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def fake_sleep(self, s):
        self.sleeps.append(s)

    def listener(self, client, ingest, state=None):
        return Listener(self.cfg, ReadOnlyClient(client), ingest, state or CursorState(self.cfg.state_path),
                        now=NOW.timestamp, sleep=self.fake_sleep, retry_delay=0.01)

    async def run_listener(self, lst):
        await lst.start()
        await lst.drain()
        await lst.stop()


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_valid_and_secrets_hidden(self):
        cfg = load_config(env(self.tmp))
        self.assertEqual(cfg.chats, {CHIME: "Chime", VENMO: "Venmo"})
        self.assertEqual(cfg.boundary, BOUNDARY)
        for text in (repr(cfg), cfg.summary()):
            self.assertNotIn(SECRET, text)
            self.assertNotIn(API_HASH, text)

    def test_refusals(self):
        for extra, needle in [
            ({"PICASSO_LISTENER_INGEST_URL": "http://203.0.113.5:3300"}, "local dashboard only"),
            ({"PICASSO_LISTENER_INGEST_URL": "https://payment.atlast.work"}, "local dashboard only"),
            ({"PICASSO_TG_SESSION": os.path.join(self.tmp, "teleledger", "teleledger")}, "not another application"),
            ({"PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID": str(CHIME)}, "different chats"),
            ({"PICASSO_PAYMENT_START_AT": "2026-10-13"}, "explicit offset"),
            ({"PICASSO_LISTENER_INGEST_SECRET": "short"}, "INGEST_SECRET"),
            ({"PICASSO_TG_API_HASH": "nothex"}, "api_hash"),
        ]:
            with self.assertRaises(ConfigError) as ctx:
                load_config(env(self.tmp, **extra))
            self.assertIn(needle, str(ctx.exception))
            self.assertNotIn(SECRET, str(ctx.exception))


class ReadOnlyTests(unittest.TestCase):
    def test_write_methods_are_unreachable(self):
        ro = ReadOnlyClient(FakeClient({}))
        for name in ("send_message", "delete_messages", "edit_message", "forward_messages", "send_file", "pin_message", "kick_participant"):
            with self.assertRaises(AttributeError):
                getattr(ro, name)
        with self.assertRaises(AttributeError):
            ro.x = 1

    def test_package_never_calls_telegram_write_apis(self):
        pkg = Path(__file__).resolve().parent.parent / "picasso_listener"
        for f in pkg.glob("*.py"):
            src = f.read_text(encoding="utf-8")
            if f.name == "client.py":
                continue
            self.assertIsNone(re.search(r"\.(send_message|send_file|delete_messages|edit_message|forward_messages|pin_message)\(", src), f.name)


class PayloadTests(unittest.TestCase):
    def test_payload_keeps_source_identity_and_original_time(self):
        m = Msg(CHIME, 42, datetime(2026, 10, 13, 0, 0, tzinfo=timezone(timedelta(hours=5, minutes=45))), "text", None)
        p = message_payload(m)
        self.assertEqual(p, {"chatId": CHIME, "messageId": 42, "date": int(BOUNDARY.timestamp()), "text": "text", "senderId": None, "edited": False})


class CatchUpTests(Base):
    async def test_first_start_reads_no_history(self):
        client = FakeClient({CHIME: [Msg(CHIME, i, at(30 - i)) for i in range(1, 6)], VENMO: []})
        ingest = FakeIngest()
        await self.run_listener(self.listener(client, ingest))
        self.assertEqual(ingest.messages, [])
        self.assertEqual(ingest.gaps, [])
        state = CursorState(self.cfg.state_path)
        self.assertEqual(state.get(CHIME)["last_id"], 5)
        self.assertEqual(state.get(VENMO)["last_id"], 0)
        if os.name == "posix":
            self.assertEqual(os.stat(self.cfg.state_path).st_mode & 0o777, 0o600)

    async def test_downtime_recovery_within_window_in_order(self):
        state = CursorState(self.cfg.state_path)
        state.advance(CHIME, 10, int(at(120).timestamp()))
        state.advance(VENMO, 0, int(at(120).timestamp()))
        client = FakeClient({CHIME: [Msg(CHIME, i, at(100 - i)) for i in range(5, 16)], VENMO: []})
        ingest = FakeIngest()
        await self.run_listener(self.listener(client, ingest, state))
        self.assertEqual([p["messageId"] for p in ingest.messages], [11, 12, 13, 14, 15])
        self.assertEqual(CursorState(self.cfg.state_path).get(CHIME)["last_id"], 15)

    async def test_messages_outside_window_become_a_gap_not_an_import(self):
        state = CursorState(self.cfg.state_path)
        state.advance(CHIME, 1, int(at(60 * 30).timestamp()))
        state.advance(VENMO, 0, 0)
        old = [Msg(CHIME, i, at(60 * 24 - i)) for i in range(2, 5)]   # ~1 day ago (> 6h window)
        new = [Msg(CHIME, i, at(30 - i)) for i in range(5, 7)]
        ingest = FakeIngest()
        await self.run_listener(self.listener(FakeClient({CHIME: old + new, VENMO: []}), ingest, state))
        self.assertEqual([p["messageId"] for p in ingest.messages], [5, 6])
        self.assertEqual(len(ingest.gaps), 1)
        g = ingest.gaps[0]
        self.assertEqual((g["chatId"], g["fromMessageId"], g["toMessageId"], g["count"]), (CHIME, 2, 4, 3))
        self.assertNotIn("advanceTo", g)

    async def test_too_many_missed_messages_reports_one_gap_and_imports_nothing(self):
        state = CursorState(self.cfg.state_path)
        state.advance(CHIME, 1, int(at(300).timestamp()))
        state.advance(VENMO, 0, 0)
        msgs = [Msg(CHIME, i, at(200 - i)) for i in range(2, 2 + 80)]  # 80 > limit 50
        ingest = FakeIngest()
        await self.run_listener(self.listener(FakeClient({CHIME: msgs, VENMO: []}), ingest, state))
        self.assertEqual(ingest.messages, [])
        self.assertEqual(len(ingest.gaps), 1)
        self.assertEqual(ingest.gaps[0]["toMessageId"], 81)
        self.assertEqual(CursorState(self.cfg.state_path).get(CHIME)["last_id"], 81)

    async def test_messages_before_the_boundary_are_never_sent(self):
        self.cfg = load_config(env(self.tmp, PICASSO_LISTENER_CATCHUP_MAX_HOURS="72"))
        state = CursorState(self.cfg.state_path)
        state.advance(CHIME, 1, 0)
        state.advance(VENMO, 0, 0)
        before = Msg(CHIME, 2, BOUNDARY - timedelta(seconds=1))
        exactly = Msg(CHIME, 3, BOUNDARY)
        nowish = NOW
        lst = Listener(self.cfg, ReadOnlyClient(FakeClient({CHIME: [before, exactly], VENMO: []})), FakeIngest(), state,
                       now=lambda: BOUNDARY.timestamp() + 3600, sleep=self.fake_sleep)
        await self.run_listener(lst)
        self.assertEqual([p["messageId"] for p in lst.ingest.messages], [3])
        self.assertEqual(lst.ingest.gaps, [])
        del nowish

    async def test_flood_wait_during_catch_up_is_waited_out(self):
        state = CursorState(self.cfg.state_path)
        state.advance(CHIME, 1, 0)
        state.advance(VENMO, 0, 0)
        client = FakeClient({CHIME: [Msg(CHIME, 2, at(5))], VENMO: []}, flood_on_iter=1)
        ingest = FakeIngest()
        await self.run_listener(self.listener(client, ingest, state))
        self.assertIn(4, self.sleeps)  # 3 seconds requested + 1
        self.assertEqual([p["messageId"] for p in ingest.messages], [2])


class DeliveryTests(Base):
    async def asyncSetUp(self):
        self.state = CursorState(self.cfg.state_path)
        self.state.advance(CHIME, 100, int(at(10).timestamp()))
        self.state.advance(VENMO, 200, int(at(10).timestamp()))

    async def test_live_messages_during_catch_up_are_held_and_ordered(self):
        client = FakeClient({CHIME: [Msg(CHIME, 101, at(5))], VENMO: []})
        ingest = FakeIngest()
        lst = self.listener(client, ingest, self.state)
        await lst.on_new(Msg(CHIME, 103, at(1)))  # arrives before start() finished
        await lst.on_new(Msg(CHIME, 102, at(2)))
        await self.run_listener(lst)
        self.assertEqual([p["messageId"] for p in ingest.messages], [101, 102, 103])

    async def test_dashboard_down_retries_and_cursor_waits(self):
        ingest = FakeIngest(unavailable=3)
        lst = self.listener(FakeClient({CHIME: [], VENMO: []}), ingest, self.state)
        await lst.start()
        await lst.on_new(Msg(CHIME, 101, at(1)))
        await lst.on_new(Msg(CHIME, 102, at(0)))
        await lst.drain()
        await lst.stop()
        self.assertEqual([p["messageId"] for p in ingest.messages], [101, 102])
        self.assertEqual(lst.stats["retries"], 3)
        self.assertEqual(CursorState(self.cfg.state_path).get(CHIME)["last_id"], 102)

    async def test_crash_before_ack_resends_after_restart(self):
        # Simulate: message delivered to the queue but the process died first.
        ingest = FakeIngest(unavailable=10 ** 6)
        lst = self.listener(FakeClient({CHIME: [], VENMO: []}), ingest, self.state)
        await lst.start()
        await lst.on_new(Msg(CHIME, 101, at(1)))
        await asyncio.sleep(0.05)
        await lst.stop()
        self.assertEqual(CursorState(self.cfg.state_path).get(CHIME)["last_id"], 100, "not acknowledged -> cursor unchanged")
        # Restart: catch-up finds 101 again and delivers it once.
        ingest2 = FakeIngest()
        lst2 = self.listener(FakeClient({CHIME: [Msg(CHIME, 101, at(1))], VENMO: []}), ingest2, CursorState(self.cfg.state_path))
        await self.run_listener(lst2)
        self.assertEqual([p["messageId"] for p in ingest2.messages], [101])

    async def test_restart_does_not_resend_acknowledged_messages(self):
        msgs = [Msg(CHIME, i, at(10 - i // 50)) for i in range(101, 104)]
        ingest = FakeIngest()
        await self.run_listener(self.listener(FakeClient({CHIME: msgs, VENMO: []}), ingest, self.state))
        ingest2 = FakeIngest()
        await self.run_listener(self.listener(FakeClient({CHIME: msgs, VENMO: []}), ingest2, CursorState(self.cfg.state_path)))
        self.assertEqual(len(ingest.messages), 3)
        self.assertEqual(ingest2.messages, [])

    async def test_permanently_rejected_message_does_not_block_later_ones(self):
        ingest = FakeIngest(reject_ids={101})
        lst = self.listener(FakeClient({CHIME: [], VENMO: []}), ingest, self.state)
        await lst.start()
        await lst.on_new(Msg(CHIME, 101, at(1)))
        await lst.on_new(Msg(CHIME, 102, at(0)))
        await lst.drain()
        await lst.stop()
        self.assertEqual([p["messageId"] for p in ingest.messages], [102])
        self.assertEqual(lst.stats["rejected"], 1)

    async def test_edits_are_forwarded_flagged_and_never_move_the_cursor(self):
        ingest = FakeIngest()
        lst = self.listener(FakeClient({CHIME: [], VENMO: []}), ingest, self.state)
        await lst.start()
        await lst.on_edit(Msg(CHIME, 150, at(1), edit_date=NOW))
        await lst.drain()
        await lst.stop()
        self.assertEqual(ingest.messages[0]["edited"], True)
        self.assertEqual(CursorState(self.cfg.state_path).get(CHIME)["last_id"], 100)

    async def test_unconfigured_chats_are_ignored(self):
        ingest = FakeIngest()
        lst = self.listener(FakeClient({CHIME: [], VENMO: []}), ingest, self.state)
        await lst.start()
        await lst.on_new(Msg(-1009999, 1, at(1)))
        await lst.drain()
        await lst.stop()
        self.assertEqual(ingest.messages, [])


class ExportTests(Base):
    async def test_export_from_boundary_inclusive_with_meta_and_flood_resume(self):
        msgs = [
            Msg(CHIME, 1, BOUNDARY - timedelta(minutes=1), "too early"),
            Msg(CHIME, 2, BOUNDARY, "exactly midnight"),
            Msg(CHIME, 3, BOUNDARY + timedelta(hours=1), None),  # service message
            Msg(CHIME, 4, BOUNDARY + timedelta(days=1), "later", edit_date=NOW),
        ]
        client = FakeClient({CHIME: msgs, VENMO: [Msg(VENMO, 9, BOUNDARY + timedelta(hours=2), "v")]}, flood_on_iter=1)
        out = os.path.join(self.tmp, "export.jsonl")
        meta = await export_history(ReadOnlyClient(client), self.cfg, out, sleep=self.fake_sleep, now=NOW.timestamp)
        lines = [json.loads(l) for l in Path(out).read_text(encoding="utf-8").splitlines()]
        rows = [l for l in lines if "_meta" not in l]
        self.assertEqual([(r["chatId"], r["messageId"]) for r in rows], [(CHIME, 2), (CHIME, 4), (VENMO, 9)])
        self.assertTrue(rows[1]["edited"])
        self.assertEqual(lines[-1]["_meta"]["chats"][str(CHIME)]["reachedBoundary"], True)
        self.assertEqual(meta["chats"][str(VENMO)]["reachedBoundary"], False, "nothing visible before the boundary")
        self.assertEqual(meta["chats"][str(CHIME)]["floodWaits"], 1)
        if os.name == "posix":
            self.assertEqual(os.stat(out).st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            await export_history(ReadOnlyClient(client), self.cfg, out, sleep=self.fake_sleep)


class EvidenceExportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        values = env(
            self.tmp,
            PICASSO_TELEGRAM_VENMO_INCOMING_CHAT_ID=str(VENMO_CHAT_ID),
            PICASSO_PAYMENT_SOURCE_SENDER_IDS=str(LARRY_BOT_ID),
            PICASSO_EVIDENCE_SESSION=os.path.join(self.tmp, "evidence", "venmo"),
        )
        self.values = values
        self.cfg = load_config(values)
        self.messages = [Msg(VENMO_CHAT_ID, i, NOW + timedelta(seconds=i), f"payment {i}", LARRY_BOT_ID) for i in EVIDENCE_IDS]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def out(self):
        return os.path.join(self.tmp, "venmo-evidence.jsonl")

    async def test_valid_fixed_evidence_and_checksum(self):
        out = self.out()
        result = await export_venmo_evidence(ReadOnlyClient(FakeClient({VENMO_CHAT_ID: self.messages})), out, now=NOW.timestamp)
        lines = [json.loads(line) for line in Path(out).read_text(encoding="utf-8").splitlines()]
        rows = [line for line in lines if "_meta" not in line]
        self.assertEqual([r["messageId"] for r in rows], list(EVIDENCE_IDS))
        self.assertTrue(all(r["chatId"] == VENMO_CHAT_ID and r["senderId"] == LARRY_BOT_ID and not r["edited"] for r in rows))
        self.assertEqual(lines[-1]["_meta"]["source"], "direct-telegram-api")
        self.assertIn(result["sha256"], Path(out + ".sha256").read_text(encoding="ascii"))
        if os.name == "posix":
            self.assertEqual(os.stat(out).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(out + ".sha256").st_mode & 0o777, 0o600)

    async def test_missing_message_is_rejected_without_output(self):
        with self.assertRaisesRegex(ValueError, "15190"):
            await export_venmo_evidence(ReadOnlyClient(FakeClient({VENMO_CHAT_ID: [m for m in self.messages if m.id != 15190]})), self.out())
        self.assertFalse(os.path.exists(self.out()))

    async def test_wrong_sender_group_and_edit_are_rejected(self):
        cases = [
            (Msg(VENMO_CHAT_ID, 15190, NOW, "x", 123), "unexpected sender"),
            (Msg(-999, 15190, NOW, "x", LARRY_BOT_ID), "unexpected chat"),
            (Msg(VENMO_CHAT_ID, 15190, NOW, "x", LARRY_BOT_ID, edit_date=NOW), "was edited"),
        ]
        for replacement, reason in cases:
            messages = [replacement if m.id == 15190 else m for m in self.messages]
            client = FakeClient({VENMO_CHAT_ID: messages})
            # Preserve a wrong-chat response under the requested chat in the fake.
            client.messages[VENMO_CHAT_ID] = sorted(messages, key=lambda m: m.id)
            with self.assertRaisesRegex(ValueError, reason):
                await export_venmo_evidence(ReadOnlyClient(client), self.out())

    async def test_duplicate_response_is_rejected(self):
        class DuplicateClient(FakeClient):
            async def get_messages(self, chat, **kwargs):
                result = await super().get_messages(chat, **kwargs)
                return result + [result[0]]
        with self.assertRaisesRegex(ValueError, "duplicate message"):
            await export_venmo_evidence(ReadOnlyClient(DuplicateClient({VENMO_CHAT_ID: self.messages})), self.out())

    def test_session_must_be_distinct_from_live_listener(self):
        self.assertEqual(evidence_settings(self.cfg, self.values), self.values["PICASSO_EVIDENCE_SESSION"])
        same = dict(self.values, PICASSO_EVIDENCE_SESSION=self.cfg.session_path)
        with self.assertRaisesRegex(ConfigError, "must not be the live"):
            evidence_settings(self.cfg, same)

        os.makedirs(os.path.dirname(self.cfg.session_path), exist_ok=True)
        live = self.cfg.session_path + ".session"
        alias = self.values["PICASSO_EVIDENCE_SESSION"] + ".session"
        os.makedirs(os.path.dirname(alias), exist_ok=True)
        Path(live).write_bytes(b"session")
        os.link(live, alias)
        with self.assertRaisesRegex(ConfigError, "aliases the live"):
            evidence_settings(self.cfg, self.values)

    async def test_export_failure_removes_partial_files_and_never_overwrites(self):
        out = self.out()
        original = evidence._exclusive_write
        calls = 0
        def fail_second(path, data):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("disk failure")
            return original(path, data)
        with mock.patch.object(evidence, "_exclusive_write", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "disk failure"):
                await export_venmo_evidence(ReadOnlyClient(FakeClient({VENMO_CHAT_ID: self.messages})), out)
        self.assertFalse(os.path.exists(out))
        self.assertFalse(os.path.exists(out + ".sha256"))

        Path(out).write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            await export_venmo_evidence(ReadOnlyClient(FakeClient({VENMO_CHAT_ID: self.messages})), out)
        self.assertEqual(Path(out).read_text(encoding="utf-8"), "keep")


class _Handler(http.server.BaseHTTPRequestHandler):
    responses = []
    seen = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Handler.seen.append((self.path, self.headers.get("X-Picasso-Ingest-Secret"), json.loads(body)))
        code, payload = _Handler.responses.pop(0) if _Handler.responses else (200, {"outcome": "created"})
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def log_message(self, *a):
        pass


class IngestClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _Handler.responses.clear()
        _Handler.seen.clear()

    def client(self, **kw):
        return IngestClient(self.base, SECRET, sleep=lambda s: None, retries=3, **kw)

    def test_sends_secret_header_and_payload(self):
        self.assertEqual(self.client().post_message({"a": 1}), {"outcome": "created"})
        path, secret, body = _Handler.seen[0]
        self.assertEqual((path, secret, body), ("/api/ingest/telegram-message", SECRET, {"a": 1}))
        self.assertNotIn(SECRET, repr(self.client()))

    def test_temporary_errors_are_retried(self):
        _Handler.responses.extend([(503, {}), (429, {}), (200, {"outcome": "duplicate"})])
        self.assertEqual(self.client().post_message({}), {"outcome": "duplicate"})
        self.assertEqual(len(_Handler.seen), 3)

    def test_auth_failure_is_permanent_and_secret_free(self):
        _Handler.responses.append((401, {"error": "Unauthorized."}))
        with self.assertRaises(IngestRejected) as ctx:
            self.client().post_message({})
        self.assertNotIn(SECRET, str(ctx.exception))
        self.assertEqual(len(_Handler.seen), 1)

    def test_unreachable_dashboard(self):
        with self.assertRaises(IngestUnavailable):
            IngestClient("http://127.0.0.1:9", SECRET, sleep=lambda s: None, retries=2, timeout=1).post_message({})


if __name__ == "__main__":
    unittest.main()
