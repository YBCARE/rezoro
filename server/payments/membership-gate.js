'use strict';

const { fulfillFancardOrder } = require('../fancard-fulfillment');
const { sendBookingPaymentConfirmed } = require('../mailer');
const { transitionPaymentStatus } = require('./state-machine');
const { logEvent } = require('./audit');

/*
 * THE single authoritative place either product type gets marked active.
 * Every path that can conclude a payment was really received — the
 * Flutterwave webhook, the Flutterwave return-URL verify, an admin manual
 * approval, or a successful crypto auto-verification — calls this and
 * nothing else. No other function in this codebase is allowed to write
 * fancardOrders.status = 'paid' or bookings.status = 'confirmed'.
 *
 * Idempotent by construction: the PAID transition on the payment_attempt
 * uses the atomic conditional-UPDATE from the state machine, so a second
 * concurrent/duplicate call simply finds the row already moved and returns
 * without doing anything twice.
 */
async function activateMembershipAfterVerifiedPayment(store, {
  paymentAttemptId, fromStatuses, verificationResult, extraPatch,
}) {
  const attempt = await transitionPaymentStatus(
    store, paymentAttemptId, fromStatuses, 'PAID',
    { verifiedAt: new Date().toISOString(), verificationResult: verificationResult || null, ...(extraPatch || {}) }
  );

  if (!attempt) {
    // Someone else already resolved this attempt (double webhook, double
    // click, a race with another verification path) — no-op, not an error.
    return { activated: false, reason: 'already_resolved' };
  }

  await logEvent(store, {
    event: 'PAYMENT_VERIFIED', orderType: attempt.orderType, orderRef: attempt.orderRef,
    paymentAttemptId: attempt.id, actorType: 'system',
    metadata: { method: attempt.method, network: attempt.network },
  });

  if (attempt.orderType === 'fancard') {
    const order = await store.fancardOrders.getByRef(attempt.orderRef);
    if (!order) return { activated: false, reason: 'order_missing', attempt };
    if (order.status === 'paid') {
      await logEvent(store, {
        event: 'DUPLICATE_PAYMENT_DETECTED', orderType: 'fancard', orderRef: attempt.orderRef,
        paymentAttemptId: attempt.id, actorType: 'system',
      });
      return { activated: false, reason: 'already_fulfilled', attempt };
    }
    await fulfillFancardOrder(store, order);
    await logEvent(store, {
      event: 'MEMBERSHIP_ACTIVATED', orderType: 'fancard', orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'system',
    });
    await logEvent(store, {
      event: 'CARD_GENERATED', orderType: 'fancard', orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'system',
    });
    return { activated: true, attempt, orderType: 'fancard' };
  }

  if (attempt.orderType === 'booking') {
    const booking = await store.bookings.getByRef(attempt.orderRef);
    if (!booking) return { activated: false, reason: 'order_missing', attempt };
    if (booking.status === 'confirmed') {
      await logEvent(store, {
        event: 'DUPLICATE_PAYMENT_DETECTED', orderType: 'booking', orderRef: attempt.orderRef,
        paymentAttemptId: attempt.id, actorType: 'system',
      });
      return { activated: false, reason: 'already_fulfilled', attempt };
    }
    await store.bookings.updateByRef(attempt.orderRef, { status: 'confirmed' });
    sendBookingPaymentConfirmed({
      to: booking.email, name: booking.name, celebName: booking.celebName,
      ref: attempt.orderRef, tier: booking.tier,
    }).catch(e => console.error('[email] booking payment confirmed:', e.message));
    await logEvent(store, {
      event: 'MEMBERSHIP_ACTIVATED', orderType: 'booking', orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'system',
    });
    return { activated: true, attempt, orderType: 'booking' };
  }

  return { activated: false, reason: 'unknown_order_type', attempt };
}

module.exports = { activateMembershipAfterVerifiedPayment };
