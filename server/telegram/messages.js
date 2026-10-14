'use strict';
// Cash-out message text. Sent as plain text (no parse_mode), so recipient
// names typed by staff can never inject Telegram formatting or links.

const money = c => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const requestId = no => `CO-${String(no).padStart(6, '0')}`;
const STATUS = { pending: 'PENDING', done: 'COMPLETED', cancelled: 'CANCELLED' };

function cashoutText(o) {
  // The first line stays "PICASSO CASH OUT" so the shared-group classifier
  // keeps recognising (and ignoring) our own posts, test or not.
  const lines = [
    'PICASSO CASH OUT',
    ...(o.isTest ? ['TEST REQUEST: not a real payment, do not send money'] : []),
    `Method: ${o.method}`,
    `Recipient: ${o.name}`,
    `Amount: ${o.isTest ? 'TEST — $0.00' : money(o.amountCents)}`,
    `Requested by: ${o.createdBy}`,
    `Request ID: ${requestId(o.requestNo)}`,
    `Status: ${STATUS[o.status]}`,
  ];
  if (o.status === 'done' && o.completedBy) lines.push(`Completed by: ${o.completedBy}`);
  if (o.status === 'cancelled' && o.cancelledBy) lines.push(`Cancelled by: ${o.cancelledBy}`);
  return lines.join('\n');
}

// Inline callback button (not a URL). callback_data is an opaque random token
// that is resolved server-side; it carries no internal IDs or amounts.
const completedKeyboard = token => ({ inline_keyboard: [[{ text: 'Completed', callback_data: `c:${token}` }]] });
const NO_KEYBOARD = { inline_keyboard: [] };

module.exports = { cashoutText, completedKeyboard, NO_KEYBOARD, requestId };
