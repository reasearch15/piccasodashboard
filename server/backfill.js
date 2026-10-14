'use strict';
// Historical payment import from a listener export. Two separate steps:
//
//   node --env-file=/etc/picasso-dashboard/picasso.env server/backfill.js preview <export.jsonl>
//       Read-only. Prints the summary and an APPROVAL TOKEN, and writes
//       <export>.preview.jsonl (one decision per message) and
//       <export>.preview-summary.json for review.
//
//   node --env-file=/etc/picasso-dashboard/picasso.env server/backfill.js apply <export.jsonl> \
//       --approval <token> --approved-by "<owner>"
//       Imports exactly what the reviewed preview described. Refuses if the
//       export file or the decision configuration changed since the preview.
//       Safe to re-run (resumes; duplicates are skipped) and safe while the
//       dashboard and live listener are running.
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openLedgerDb } = require('./db');
const { DemoLedger } = require('./demo-ledger');
const { TelegramBot } = require('./telegram/bot');
const { parseExport, previewBackfill, applyBackfill, approvalToken } = require('./telegram/backfill');

const usage = () => {
  console.error('Usage:\n  backfill.js preview <export.jsonl>\n  backfill.js apply <export.jsonl> --approval <token> --approved-by "<owner>"');
  process.exit(2);
};
const args = process.argv.slice(2);
const [command, file] = args;
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!['preview', 'apply'].includes(command) || !file) usage();

const config = loadConfig();
// Decision configuration: the listener's when enabled (production), else the bot's.
const base = config.listener.enabled ? config.listener : config.telegram.enabled ? config.telegram : null;
if (!base) { console.error('Incoming group configuration is required (PICASSO_LISTENER_INGEST_SECRET and the incoming chat IDs).'); process.exit(2); }
const cfg = { ...base, paymentStartMs: config.paymentStartMs, ownBotId: config.listener.staffhelpBotId ?? null };

const ledger = new DemoLedger(openLedgerDb(config.dataDir, config.ledgerMode), { mode: config.ledgerMode, paymentStartMs: config.paymentStartMs, paymentStartRaw: config.paymentStartRaw });
const exportText = fs.readFileSync(file, 'utf8');
const { meta, messages } = parseExport(exportText);
const token = approvalToken(exportText, cfg);
const preview = previewBackfill(ledger, cfg, messages, { meta });
const money = c => `$${(c / 100).toFixed(2)}`;

const { decisions, ...summary } = preview;
console.log(`Boundary: ${summary.boundary}`);
console.log(`Inspected: ${summary.counts.inspected}`);
for (const [k, v] of Object.entries(summary.counts)) if (k !== 'inspected' && v) console.log(`  ${k}: ${v}`);
for (const [m, s] of Object.entries(summary.byMethod)) {
  console.log(`${m}: ${s.payment_candidates} payment candidate(s), total ${money(s.totalCents)}, earliest ${s.earliest || '-'}, latest ${s.latest || '-'}; ${s.attention_events} Admin Attention event(s)`);
}
if (Object.keys(summary.rejectedReasons).length) console.log('No-record reasons:', JSON.stringify(summary.rejectedReasons));
for (const l of summary.limitations) console.log(`LIMITATION: ${l}`);
console.log(`Effect on totals: ${summary.effectOnTotals}`);

if (command === 'preview') {
  fs.writeFileSync(`${file}.preview.jsonl`, decisions.map(d => JSON.stringify(d)).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(`${file}.preview-summary.json`, JSON.stringify({ ...summary, approvalToken: token, exportFile: file }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Audit file: ${file}.preview.jsonl`);
  console.log(`APPROVAL TOKEN: ${token}`);
  console.log('Preview only. Nothing was written to the ledger.');
  process.exit(0);
}

const approval = flag('--approval');
const approvedBy = flag('--approved-by');
if (!approval || approval !== token) {
  console.error('Refusing: --approval does not match this export and configuration. Run preview again and review it.');
  process.exit(3);
}
if (!approvedBy || approvedBy.startsWith('--')) { console.error('Refusing: --approved-by "<owner>" is required.'); process.exit(3); }
const bot = new TelegramBot({ config: cfg, ledger, events: { publish() {} }, api: null });
bot.botId = cfg.ownBotId;
const outcomes = applyBackfill(bot, messages, { approvedBy, onProgress: (n, total) => console.log(`  ... ${n}/${total}`) });
console.log('Applied:', JSON.stringify(outcomes));
console.log('All imported payments are PENDING and need staff/admin acceptance. Re-running is safe (duplicates are skipped).');
