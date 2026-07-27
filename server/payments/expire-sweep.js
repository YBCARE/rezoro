'use strict';

const { logEvent } = require('./audit');

/*
 * Periodically moves PENDING_PAYMENT attempts whose expiresAt has passed
 * into EXPIRED. Never touches the underlying order — it stays exactly as it
 * was; only the payment attempt is marked expired. Safe to run repeatedly:
 * an already-EXPIRED row no longer matches the sweep's WHERE clause.
 */
function startExpirySweeper(store, intervalMs = 5 * 60 * 1000) {
  const sweep = async () => {
    try {
      const expired = await store.paymentAttempts.sweepExpired();
      for (const attempt of expired) {
        await logEvent(store, {
          event: 'PAYMENT_EXPIRED', orderType: attempt.orderType, orderRef: attempt.orderRef,
          paymentAttemptId: attempt.id, actorType: 'system',
          metadata: { method: attempt.method, network: attempt.network || null },
        });
      }
      if (expired.length) console.log(`[payments] expired ${expired.length} stale payment attempt(s)`);
    } catch (e) {
      console.error('[payments] expiry sweep failed:', e.message);
    }
  };
  sweep();
  return setInterval(sweep, intervalMs);
}

module.exports = { startExpirySweeper };
