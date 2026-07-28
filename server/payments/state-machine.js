'use strict';

/*
 * The full set of statuses a payment_attempt can be in, and the only
 * transitions allowed between them. Nothing outside transitionPaymentStatus()
 * below is permitted to write `status` on a payment_attempt row — that
 * function is the single choke point every payment method funnels through.
 *
 * Terminal statuses (no outgoing entry here) can never transition again:
 * PAID, TEST_PAID, REJECTED, FAILED, CANCELLED. In particular REJECTED has no
 * path back to PAID — the spec requires an explicit admin recovery workflow
 * for that, which does not exist, so the only way forward from REJECTED is a
 * brand new payment attempt on the same order.
 */
const TRANSITIONS = {
  PENDING_PAYMENT: ['PENDING_VERIFICATION', 'PAID', 'TEST_PAID', 'FAILED', 'EXPIRED', 'CANCELLED'],
  PENDING_VERIFICATION: [
    'PAID', 'TEST_PAID', 'REJECTED', 'FAILED', 'LATE_PAYMENT_REVIEW',
    'UNDERPAYMENT_REVIEW', 'OVERPAYMENT_REVIEW', 'DUPLICATE_PAYMENT_REVIEW',
  ],
  EXPIRED: ['LATE_PAYMENT_REVIEW'],
  LATE_PAYMENT_REVIEW: ['PAID', 'REJECTED'],
  UNDERPAYMENT_REVIEW: ['PAID', 'REJECTED'],
  OVERPAYMENT_REVIEW: ['PAID', 'REJECTED'],
  DUPLICATE_PAYMENT_REVIEW: ['REJECTED'],
};

const ALL_STATUSES = [
  'PENDING_PAYMENT', 'PENDING_VERIFICATION', 'PAID', 'TEST_PAID', 'FAILED',
  'EXPIRED', 'LATE_PAYMENT_REVIEW', 'REJECTED', 'CANCELLED',
  'UNDERPAYMENT_REVIEW', 'OVERPAYMENT_REVIEW', 'DUPLICATE_PAYMENT_REVIEW',
];

// Statuses the admin Payments queue groups under "Needs Review".
const REVIEW_STATUSES = [
  'PENDING_VERIFICATION', 'LATE_PAYMENT_REVIEW', 'UNDERPAYMENT_REVIEW',
  'OVERPAYMENT_REVIEW', 'DUPLICATE_PAYMENT_REVIEW',
];

function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/**
 * The single place in the codebase allowed to change a payment_attempt's
 * status. `fromStatuses` must be the specific status(es) the caller expects
 * the row to currently be in — never "any status" — so a duplicate/stale
 * caller (double webhook delivery, double admin click, a retried request)
 * naturally finds the row has already moved on and gets `null` back instead
 * of corrupting state. Throws if the requested transition isn't in the
 * allow-list above, so a bug can't silently skip states.
 */
async function transitionPaymentStatus(store, id, fromStatuses, toStatus, patch = {}) {
  const froms = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
  for (const from of froms) {
    if (!canTransition(from, toStatus)) {
      throw new Error(`Invalid payment status transition: ${from} -> ${toStatus}`);
    }
  }
  return store.paymentAttempts.transitionStatus(id, froms, toStatus, patch);
}

module.exports = { TRANSITIONS, ALL_STATUSES, REVIEW_STATUSES, canTransition, transitionPaymentStatus };
