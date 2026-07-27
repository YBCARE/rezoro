'use strict';

/*
 * Thin wrapper around store.paymentAuditLog. Every payment-relevant action in
 * the codebase should call logEvent() — nothing writes to the audit log any
 * other way. Metadata must only ever contain safe, non-secret values (no API
 * keys, no full card/receipt bytes) — callers are responsible for that, this
 * module just caps the size so one bad payload can't balloon the table.
 */
const EVENTS = [
  'ORDER_CREATED', 'PAYMENT_ATTEMPT_CREATED', 'RECEIPT_SUBMITTED', 'TXID_SUBMITTED',
  'PAYMENT_VERIFICATION_STARTED', 'PAYMENT_VERIFICATION_FAILED', 'PAYMENT_VERIFIED',
  'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'LATE_PAYMENT_DETECTED',
  'DUPLICATE_PAYMENT_DETECTED', 'UNDERPAYMENT_DETECTED', 'OVERPAYMENT_DETECTED',
  'MEMBERSHIP_ACTIVATED', 'CARD_GENERATED', 'PAYMENT_SETTING_CHANGED',
  'WEBHOOK_REJECTED', 'PAYMENT_ATTEMPT_CANCELLED',
];

function safeMeta(meta) {
  if (!meta) return null;
  try {
    const json = JSON.stringify(meta);
    if (json.length > 4000) {
      console.warn('[payments/audit] metadata payload too large, dropping it');
      return null;
    }
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function logEvent(store, { event, orderType, orderRef, paymentAttemptId, actorType, actorId, metadata }) {
  if (!EVENTS.includes(event)) {
    console.error(`[payments/audit] unknown event type "${event}" — logging anyway`);
  }
  return store.paymentAuditLog.append({
    event, orderType: orderType || null, orderRef: orderRef || null,
    paymentAttemptId: paymentAttemptId || null, actorType, actorId: actorId || null,
    metadata: safeMeta(metadata),
  });
}

module.exports = { EVENTS, logEvent };
