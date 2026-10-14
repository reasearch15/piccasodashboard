'use strict';
// Reconcile existing Admin Attention events into PENDING payments.
//
// Dry run (default, read-only):
//   node --env-file=/etc/picasso-dashboard/picasso.env server/reconcile-attention.js \
//     --export <listener-export.jsonl> --chat <venmo group id> --ids 15185-15207 [--parser venmo-v1]
//   Prints one line per event and an APPROVAL TOKEN; writes <export>.reconcile-plan.jsonl.
//
// Apply (only after the dry run has been reviewed and approved):
//   ... same arguments ... --apply --approval <token> --approved-by <admin username>
//
// Never deletes anything. Converted events stay in Admin Attention (gray,
// "Reconciled to pending payment") with their original text, linked to the
// new payment. Payments are created PENDING and need staff/admin acceptance.
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openLedgerDb, openAuthDb } = require('./db');
const { DemoLedger } = require('./demo-ledger');
const { parseExport } = require('./telegram/backfill');
const { planReconciliation, applyReconciliation, parseRange } = require('./telegram/reconcile');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

const exportFile = flag('--export');
const chatId = flag('--chat');
const ids = flag('--ids');
const parser = flag('--parser') || 'venmo-v1';
if (!exportFile || !chatId || !ids) fail('Usage: reconcile-attention.js --export FILE --chat CHAT_ID --ids N-M [--parser venmo-v1] [--apply --approval TOKEN --approved-by ADMIN]');
if (!['venmo-v1'].includes(parser)) fail('--parser must be venmo-v1');

const config = loadConfig();
const base = config.listener.enabled ? config.listener : config.telegram.enabled ? config.telegram : null;
if (!base) fail('Incoming group configuration is required (listener or Telegram settings).');
if (!base.sourceSenderIds?.size) fail('PICASSO_PAYMENT_SOURCE_SENDER_IDS (Larry\'s bot) must be configured: no sender, no conversion.');
const cfg = { ...base, paymentStartMs: config.paymentStartMs, ownBotId: config.listener.staffhelpBotId ?? null };

const ledger = new DemoLedger(openLedgerDb(config.dataDir, config.ledgerMode), { mode: config.ledgerMode, paymentStartMs: config.paymentStartMs, paymentStartRaw: config.paymentStartRaw });
const { messages } = parseExport(fs.readFileSync(exportFile, 'utf8'));
const plan = planReconciliation(ledger, cfg, { chatId, range: parseRange(ids), exportMessages: messages, parser });
const money = c => (c == null ? '-' : `$${(c / 100).toFixed(2)}`);

console.log(`Chat ${chatId}, message IDs ${ids}, parser ${parser}`);
console.log('message_id  sender_verified  text_match  amount      action');
for (const r of plan.rows) {
  console.log(`${String(r.messageId).padEnd(11)} ${String(r.senderVerified).padEnd(16)} ${String(r.exportTextMatches).padEnd(11)} ${money(r.amountCents).padEnd(11)} ${r.action}`);
}
if (plan.exportOnly.length) console.log(`Export messages in range with no attention event (not touched): ${plan.exportOnly.join(', ')}`);
console.log(`Events: ${plan.summary.events}; convert: ${plan.summary.convert} (total ${money(plan.summary.convertTotalCents)}); keep: ${JSON.stringify(plan.summary.keep)}`);
console.log('Effect on totals: none until staff/admin accept the new PENDING payments.');

if (!args.includes('--apply')) {
  const out = `${exportFile}.reconcile-plan.jsonl`;
  fs.writeFileSync(out, plan.rows.map(({ parsed, ...r }) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  console.log(`Plan written to ${out} (no names or message text).`);
  console.log(`APPROVAL TOKEN: ${plan.token}`);
  console.log('Dry run only. Nothing was written to the ledger.');
  process.exit(0);
}

const approval = flag('--approval');
const approvedBy = flag('--approved-by');
if (!approval || approval !== plan.token) fail('Refusing: --approval does not match this dry run. Run the dry run again and review it.', 3);
const auth = openAuthDb(config.dataDir);
const admin = approvedBy && auth.prepare("SELECT id, username FROM users WHERE username = ? AND role = 'admin' AND disabled = 0").get(approvedBy);
if (!admin) fail('Refusing: --approved-by must be an enabled admin username.', 3);
const outcomes = applyReconciliation(ledger, plan, { approval, admin: { id: admin.id, username: admin.username } });
auth.prepare('INSERT INTO audit_log (at, actor_id, actor_username, action, target_id, target_username) VALUES (?, ?, ?, ?, ?, ?)')
  .run(new Date().toISOString(), admin.id, admin.username, 'attention_reconciliation_applied', `${chatId}:${ids}`, null);
console.log('Applied:', JSON.stringify(outcomes));
console.log('Re-running is safe: already reconciled events are skipped.');
