"""Picasso Dashboard Telegram listener.

A small, read-only Telethon user-account process that relays new messages from
the configured Chime and Venmo groups to Picasso's local ingestion endpoint.
Picasso decides what every message is; this process never interprets money,
never writes to Telegram, and never imports history on its own.
"""

__version__ = "1.0.0"
