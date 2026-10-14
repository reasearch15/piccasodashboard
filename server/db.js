'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Real accounts and sessions. Kept in its own file so it can later sit beside a
// production ledger without ever sharing tables with demo transactions.
const AUTH_MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
     password_hash TEXT NOT NULL,
     disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
     created_at TEXT NOT NULL,
     created_by_id TEXT,
     updated_at TEXT NOT NULL,
     password_changed_at TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     csrf_token TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user_id ON sessions(user_id);
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor_id TEXT,
     actor_username TEXT,
     action TEXT NOT NULL,
     target_id TEXT,
     target_username TEXT
   );`,
];

// Simulated transactions only. Every table is prefixed demo_ and the file is
// named demo-ledger.db so nothing here can be mistaken for real records.
const LEDGER_MIGRATIONS = [
  `CREATE TABLE demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE demo_payments (
     id TEXT PRIMARY KEY,
     method TEXT NOT NULL CHECK (method IN ('Venmo', 'Chime')),
     name TEXT NOT NULL,
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
     status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'deleted')),
     received_at TEXT NOT NULL,
     accepted_at TEXT,
     accepted_by_id TEXT,
     accepted_by TEXT,
     accept_order INTEGER,
     deleted_at TEXT,
     deleted_by_id TEXT,
     deleted_by TEXT,
     restored_at TEXT,
     restored_by_id TEXT,
     restored_by TEXT
   );
   CREATE TABLE demo_cashouts (
     id TEXT PRIMARY KEY,
     method TEXT NOT NULL CHECK (method IN ('Venmo', 'Chime')),
     name TEXT NOT NULL,
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
     status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'cancelled')),
     created_at TEXT NOT NULL,
     created_by_id TEXT,
     created_by TEXT,
     completed_at TEXT,
     completed_by_id TEXT,
     completed_by TEXT,
     cancelled_at TEXT,
     cancelled_by_id TEXT,
     cancelled_by TEXT,
     settlement_id TEXT
   );
   CREATE TABLE demo_settlements (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     method TEXT NOT NULL,
     created_at TEXT NOT NULL,
     admin_id TEXT,
     admin TEXT NOT NULL,
     record_json TEXT NOT NULL
   );`,
  // v2: Telegram source tracking, cash-out delivery outbox, Telegram audit.
  // Existing rows keep their values; new columns default to "not Telegram".
  `ALTER TABLE demo_payments ADD COLUMN source TEXT NOT NULL DEFAULT 'demo';
   ALTER TABLE demo_payments ADD COLUMN source_chat_id TEXT;
   ALTER TABLE demo_payments ADD COLUMN source_message_id INTEGER;
   ALTER TABLE demo_payments ADD COLUMN parser_version TEXT;
   ALTER TABLE demo_payments ADD COLUMN created_at TEXT;
   CREATE UNIQUE INDEX demo_payments_source ON demo_payments(source_chat_id, source_message_id) WHERE source_chat_id IS NOT NULL;
   ALTER TABLE demo_cashouts ADD COLUMN request_no INTEGER;
   ALTER TABLE demo_cashouts ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'not_required'
     CHECK (delivery_status IN ('not_required', 'queued', 'sending', 'retrying', 'sent', 'failed', 'skipped'));
   ALTER TABLE demo_cashouts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE demo_cashouts ADD COLUMN delivery_next_at INTEGER;
   ALTER TABLE demo_cashouts ADD COLUMN delivery_last_error TEXT;
   ALTER TABLE demo_cashouts ADD COLUMN delivered_at TEXT;
   ALTER TABLE demo_cashouts ADD COLUMN telegram_chat_id TEXT;
   ALTER TABLE demo_cashouts ADD COLUMN telegram_message_id INTEGER;
   ALTER TABLE demo_cashouts ADD COLUMN callback_token TEXT;
   ALTER TABLE demo_cashouts ADD COLUMN message_sync_needed INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE demo_cashouts ADD COLUMN message_sync_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE demo_cashouts ADD COLUMN message_sync_next_at INTEGER;
   ALTER TABLE demo_cashouts ADD COLUMN completed_via TEXT;
   ALTER TABLE demo_cashouts ADD COLUMN completed_by_telegram_id TEXT;
   CREATE UNIQUE INDEX demo_cashouts_callback ON demo_cashouts(callback_token) WHERE callback_token IS NOT NULL;
   CREATE UNIQUE INDEX demo_cashouts_request_no ON demo_cashouts(request_no) WHERE request_no IS NOT NULL;
   CREATE TABLE telegram_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     update_id INTEGER,
     kind TEXT NOT NULL,
     outcome TEXT NOT NULL,
     chat_id TEXT,
     message_id INTEGER,
     telegram_user_id TEXT,
     ref_id TEXT,
     detail TEXT
   );
   CREATE TABLE telegram_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v3: Admin Attention events. Review items only; never part of any total.
  `CREATE TABLE attention_events (
     id TEXT PRIMARY KEY,
     method TEXT NOT NULL CHECK (method IN ('Venmo', 'Chime')),
     event_type TEXT NOT NULL CHECK (event_type IN ('total_in_adjustment', 'total_out_adjustment', 'unrecognized_financial')),
     amount_cents INTEGER,
     reason TEXT,
     original_text TEXT NOT NULL,
     message_at TEXT NOT NULL,
     source_chat_id TEXT NOT NULL,
     source_message_id INTEGER NOT NULL,
     parser_version TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ignored')),
     created_at TEXT NOT NULL,
     ignored_at TEXT,
     ignored_by_id TEXT,
     ignored_by TEXT,
     UNIQUE (source_chat_id, source_message_id)
   );`,
  // v4: recipient identifier from real Chime messages (e.g. Kristen-Huey-1).
  `ALTER TABLE demo_payments ADD COLUMN recipient_tag TEXT;`,
];

function migrate(db, migrations) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;
  migrations.slice(current).forEach((sql, i) => {
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(current + i + 1, new Date().toISOString());
    });
  });
}

function open(file, migrations) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, migrations);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const openAuthDb = dataDir => open(path.join(dataDir, 'auth.db'), AUTH_MIGRATIONS);
// Demo and production ledgers are separate files and never open each other.
const LEDGER_FILES = { demo: 'demo-ledger.db', production: 'ledger.db' };
const openLedgerDb = (dataDir, mode = 'demo') => open(path.join(dataDir, LEDGER_FILES[mode]), LEDGER_MIGRATIONS);

module.exports = { LEDGER_FILES, openAuthDb, openLedgerDb, transaction, AUTH_MIGRATIONS, LEDGER_MIGRATIONS };
