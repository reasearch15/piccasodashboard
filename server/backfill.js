'use strict';
// node --env-file=.env server/backfill.js <export.jsonl>                    (preview, read-only)
// node --env-file=.env server/backfill.js <export.jsonl> --apply --approved-by "<owner>"
// Run with the dashboard server stopped. Apply is only for after the owner has
// reviewed the preview counts and approved in writing.
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openLedgerDb } = require('./db');
const { DemoLedger } = require('./demo-ledger');
const { TelegramBot } = require('./telegram/bot');
const { previewBackfill, applyBackfill } = require('./telegram/backfill');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
const approvedBy = args[args.indexOf('--approved-by') + 1];
if (!file) { console.error('Usage: backfill.js <export.jsonl> [--apply --approved-by "<owner>"]'); process.exit(2); }

const config = loadConfig();
if (!config.telegram.enabled) { console.error('Telegram configuration is required (group IDs, boundary).'); process.exit(2); }
const ledger = new DemoLedger(openLedgerDb(config.dataDir, config.ledgerMode), { mode: config.ledgerMode, paymentStartMs: config.paymentStartMs, paymentStartRaw: config.paymentStartRaw });
const messages = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

console.log(JSON.stringify(previewBackfill(ledger, config.telegram, messages), null, 2));
if (apply) {
  if (!approvedBy || approvedBy.startsWith('--')) { console.error('Refusing: --apply requires --approved-by "<owner>".'); process.exit(2); }
  const bot = new TelegramBot({ config: config.telegram, ledger, events: { publish() {} }, api: null });
  console.log('Applied:', JSON.stringify(applyBackfill(bot, messages, { approvedBy })));
} else {
  console.log('Preview only. Nothing was written.');
}
