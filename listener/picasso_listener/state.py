"""Per-chat cursor: the newest message ID Picasso has acknowledged.

Written atomically (temp file + rename) with mode 600, so a crash can never
leave a half-written cursor. The cursor only ever moves forward.
"""
from __future__ import annotations

import json
import os
import tempfile


class CursorState:
    def __init__(self, path: str):
        self.path = path
        self.data = {"chats": {}}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)
            self.data.setdefault("chats", {})

    def get(self, chat_id: int):
        return self.data["chats"].get(str(chat_id))

    def advance(self, chat_id: int, message_id: int, date: int) -> bool:
        cur = self.get(chat_id)
        if cur is not None and message_id <= cur["last_id"]:
            return False
        self.data["chats"][str(chat_id)] = {"last_id": int(message_id), "last_date": int(date)}
        self.save()
        return True

    def save(self) -> None:
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".cursor-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
