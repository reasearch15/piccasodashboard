"""Read-only facade over a Telethon client.

The listener code only ever receives this wrapper, which exposes the handful
of read operations it needs. Sending, editing, deleting or forwarding
messages is impossible through it, by construction.
"""
from __future__ import annotations

READ_ONLY_METHODS = frozenset({
    "connect", "disconnect", "is_user_authorized", "get_me",
    "get_messages", "iter_messages", "add_event_handler", "run_until_disconnected",
})


class ReadOnlyClient:
    __slots__ = ("_client",)

    def __init__(self, client):
        object.__setattr__(self, "_client", client)

    def __getattr__(self, name):
        if name not in READ_ONLY_METHODS:
            raise AttributeError(f"'{name}' is not available: the Picasso listener is read-only")
        return getattr(object.__getattribute__(self, "_client"), name)

    def __setattr__(self, name, value):
        raise AttributeError("ReadOnlyClient is immutable")
