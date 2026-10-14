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
  // v5: removal of a cancelled request's Telegram message, tracked separately
  // from the financial status so a Telegram failure can never change money.
  `ALTER TABLE demo_cashouts ADD COLUMN telegram_delete_status TEXT NOT NULL DEFAULT 'none'
     CHECK (telegram_delete_status IN ('none', 'pending', 'deleted', 'already_absent', 'failed'));
   ALTER TABLE demo_cashouts ADD COLUMN telegram_delete_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE demo_cashouts ADD COLUMN telegram_delete_next_at INTEGER;
   ALTER TABLE demo_cashouts ADD COLUMN telegram_deleted_at TEXT;
   ALTER TABLE demo_cashouts ADD COLUMN telegram_delete_error TEXT;`,
  // v6: explicitly marked $0.00 TEST cash-outs. SQLite cannot change a CHECK
  // constraint in place, so the table is rebuilt once: every row and column is
  // copied unchanged, and the indexes are recreated. Real cash-outs keep the
  // strict "amount > 0" rule; only is_test = 1 rows may (and must) be $0.00.
  `CREATE TABLE demo_cashouts_v6 (
     id TEXT PRIMARY KEY,
     method TEXT NOT NULL CHECK (method IN ('Venmo', 'Chime')),
     name TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
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
     settlement_id TEXT,
     request_no INTEGER,
     delivery_status TEXT NOT NULL DEFAULT 'not_required'
       CHECK (delivery_status IN ('not_required', 'queued', 'sending', 'retrying', 'sent', 'failed', 'skipped')),
     delivery_attempts INTEGER NOT NULL DEFAULT 0,
     delivery_next_at INTEGER,
     delivery_last_error TEXT,
     delivered_at TEXT,
     telegram_chat_id TEXT,
     telegram_message_id INTEGER,
     callback_token TEXT,
     message_sync_needed INTEGER NOT NULL DEFAULT 0,
     message_sync_attempts INTEGER NOT NULL DEFAULT 0,
     message_sync_next_at INTEGER,
     completed_via TEXT,
     completed_by_telegram_id TEXT,
     telegram_delete_status TEXT NOT NULL DEFAULT 'none'
       CHECK (telegram_delete_status IN ('none', 'pending', 'deleted', 'already_absent', 'failed')),
     telegram_delete_attempts INTEGER NOT NULL DEFAULT 0,
     telegram_delete_next_at INTEGER,
     telegram_deleted_at TEXT,
     telegram_delete_error TEXT,
     is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
     CHECK ((is_test = 0 AND amount_cents > 0) OR (is_test = 1 AND amount_cents = 0))
   );
   INSERT INTO demo_cashouts_v6 (id, method, name, amount_cents, status, created_at, created_by_id, created_by, completed_at,
     completed_by_id, completed_by, cancelled_at, cancelled_by_id, cancelled_by, settlement_id, request_no, delivery_status,
     delivery_attempts, delivery_next_at, delivery_last_error, delivered_at, telegram_chat_id, telegram_message_id, callback_token,
     message_sync_needed, message_sync_attempts, message_sync_next_at, completed_via, completed_by_telegram_id,
     telegram_delete_status, telegram_delete_attempts, telegram_delete_next_at, telegram_deleted_at, telegram_delete_error, is_test)
   SELECT id, method, name, amount_cents, status, created_at, created_by_id, created_by, completed_at,
     completed_by_id, completed_by, cancelled_at, cancelled_by_id, cancelled_by, settlement_id, request_no, delivery_status,
     delivery_attempts, delivery_next_at, delivery_last_error, delivered_at, telegram_chat_id, telegram_message_id, callback_token,
     message_sync_needed, message_sync_attempts, message_sync_next_at, completed_via, completed_by_telegram_id,
     telegram_delete_status, telegram_delete_attempts, telegram_delete_next_at, telegram_deleted_at, telegram_delete_error, 0
   FROM demo_cashouts ORDER BY rowid;
   DROP TABLE demo_cashouts;
   ALTER TABLE demo_cashouts_v6 RENAME TO demo_cashouts;
   CREATE UNIQUE INDEX demo_cashouts_callback ON demo_cashouts(callback_token) WHERE callback_token IS NOT NULL;
   CREATE UNIQUE INDEX demo_cashouts_request_no ON demo_cashouts(request_no) WHERE request_no IS NOT NULL;`,
  // v7: an Admin Attention event can be resolved by an approved reconciliation.
  // The event and its original text are kept; it links to the payment created.
  `ALTER TABLE attention_events ADD COLUMN resolution TEXT;
   ALTER TABLE attention_events ADD COLUMN resolved_payment_id TEXT;`,
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
