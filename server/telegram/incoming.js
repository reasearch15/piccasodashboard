'use strict';
// One decision function for every incoming group message, whether it arrives
// live (Bot API or the user-account listener) or from an approved historical
// import. Pure: no database writes, so the backfill preview uses exactly the
// same rules as live ingestion.
//
// Order matters and is deliberately conservative:
//   1. only configured incoming groups; method comes from the group, never the text
//   2. the StaffHelp bot's own posts are ignored
//   3. malformed updates are rejected
//   4. edits never create or change records
//   5. the activation boundary (PICASSO_PAYMENT_START_AT), on the ORIGINAL date
//   6. classification: cash-out request / payment / attention / nothing
//   7. a payment is accepted only from a verified sender (Larry's bot); the same
//      text from anyone else is held in Admin Attention with no amount
const { classifyMessage } = require('./parser');

function decideMessage(cfg, msg) {
  const chatId = String(msg.chat?.id ?? '');
  const method = cfg.incomingMethodByChat.get(chatId);
  if (!method) return { decision: 'ignore', outcome: cfg.configuredChats?.has(chatId) ? 'ignored_not_incoming_group' : 'ignored_unconfigured_chat', chatId };
  const senderId = msg.from?.id == null ? null : String(msg.from.id);
  if (cfg.ownBotId && senderId === String(cfg.ownBotId)) return { decision: 'ignore', outcome: 'ignored_own_message', chatId, method };
  if (!Number.isInteger(msg.message_id) || !Number.isInteger(msg.date)) return { decision: 'ignore', outcome: 'rejected_malformed_update', chatId, method };
  if (msg.edited) return { decision: 'ignore', outcome: 'ignored_edit', chatId, method };
  if (cfg.paymentStartMs != null && msg.date * 1000 < cfg.paymentStartMs) return { decision: 'ignore', outcome: 'ignored_before_cutoff', chatId, method };

  const parsed = classifyMessage(msg.text, method, { venmoParser: cfg.venmoParser });
  if (parsed.kind === 'cashout_request') return { decision: 'cashout_request', chatId, method, parsed };
  if (parsed.kind === 'payment' && cfg.sourceSenderIds?.size && !cfg.sourceSenderIds.has(senderId)) {
    return {
      decision: 'attention', chatId, method,
      parsed: { kind: 'attention', eventType: 'unrecognized_financial', amountCents: null, reason: 'unverified_payment_source', parserVersion: parsed.parserVersion },
    };
  }
  if (parsed.kind === 'payment') return { decision: 'payment', chatId, method, parsed };
  if (parsed.kind === 'attention') return { decision: 'attention', chatId, method, parsed };
  return { decision: 'none', chatId, method, parsed };
}

module.exports = { decideMessage };
