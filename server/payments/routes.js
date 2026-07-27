'use strict';

const express = require('express');
const settings = require('./settings');
const { getOrderInfo, createPaymentAttempt } = require('./attempts');
const { transitionPaymentStatus, REVIEW_STATUSES } = require('./state-machine');
const { activateMembershipAfterVerifiedPayment } = require('./membership-gate');
const { verifyCryptoPayment } = require('./verify');
const { logEvent } = require('./audit');
const { sniffReceiptFile } = require('./file-validate');
const qr = require('./qrcode');

const ORDER_TYPES = ['fancard', 'booking'];
const CRYPTO_METHODS = ['bitcoin', 'usdc'];

// Every route below is async — without this, a rejected promise (a DB error,
// a failed email send inside the membership gate, a network timeout) would
// become an unhandled rejection that leaves the client hanging with no
// response instead of a clean error, since Express 4 doesn't catch async
// handler rejections on its own.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('[payments]', err.stack || err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
    });
  };
}

/*
 * Mounts every new payment endpoint. `deps` carries things server.js already
 * owns (store accessor, auth middleware, rate limiter, multer instance,
 * FLW key resolution) so this module never re-implements them.
 */
function mountPaymentRoutes(app, deps) {
  const { getStore, adminAuthMiddleware, optionalAuthMiddleware, upload, rateLimit, SITE_URL } = deps;
  const router = express.Router();

  /* ── Sanitizers — never leak admin-only or secret fields to customers ── */
  function toPublicMethods(all) {
    const pub = (cfg) => ({ status: cfg.status, maintenanceMessage: cfg.maintenanceMessage });
    return {
      flutterwave: { ...pub(all.flutterwave), mode: all.flutterwave.mode },
      bank_transfer: pub(all.bank_transfer),
      bitcoin: pub(all.bitcoin),
      usdc: {
        ...pub(all.usdc),
        networks: Object.fromEntries(
          settings.USDC_NETWORKS.map(n => [n, pub(all.usdc.networks[n])])
        ),
      },
    };
  }

  function toCustomerAttempt(a) {
    return {
      id: a.id, method: a.method, network: a.network, asset: a.asset,
      environment: a.environment, destinationSnapshot: a.destinationSnapshot,
      expectedAmount: a.expectedAmount, expectedCurrency: a.expectedCurrency,
      expectedCryptoAmount: a.expectedCryptoAmount, status: a.status,
      failureReason: a.failureReason, rejectionReason: a.rejectionReason,
      txid: a.txid, senderName: a.senderName, bankReference: a.bankReference,
      hasReceipt: a.hasReceipt, expiresAt: a.expiresAt, createdAt: a.createdAt,
    };
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC — checkout
  ═══════════════════════════════════════════════════════════ */

  router.get('/api/payments/methods', asyncHandler(async (_req, res) => {
    const store = getStore();
    const all = await settings.getAllMethodSettings(store);
    res.json(toPublicMethods(all));
  }));

  router.get('/api/orders/:orderType/:orderRef', rateLimit('order-lookup', 60, 60 * 1000), asyncHandler(async (req, res) => {
    const store = getStore();
    const { orderType, orderRef } = req.params;
    if (!ORDER_TYPES.includes(orderType)) return res.status(400).json({ error: 'Unknown order type.' });
    const order = await getOrderInfo(store, orderType, orderRef);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const attempts = await store.paymentAttempts.getByOrder(orderType, orderRef);
    res.json({
      orderType, orderRef, label: order.label, price: order.price, currency: order.currency,
      fulfilled: order.alreadyFulfilled,
      attempts: attempts.map(toCustomerAttempt),
    });
  }));

  router.post('/api/orders/:orderType/:orderRef/attempts',
    rateLimit('attempt-create', 15, 60 * 60 * 1000), optionalAuthMiddleware,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const { orderType, orderRef } = req.params;
      const { method, network } = req.body || {};
      if (!ORDER_TYPES.includes(orderType)) return res.status(400).json({ error: 'Unknown order type.' });

      const result = await createPaymentAttempt(store, {
        orderType, orderRef, method, network,
        actorId: req.user ? req.user.id : null,
      });
      if (result.error) return res.status(result.code || 400).json({ error: result.error });

      const { attempt } = result;

      if (method === 'flutterwave') {
        const keys = settings.resolveFlutterwaveKeys(attempt.environment);
        if (!keys) {
          await transitionPaymentStatus(store, attempt.id, ['PENDING_PAYMENT'], 'FAILED', { failureReason: 'Flutterwave credentials not configured for this mode.' });
          return res.status(503).json({ error: 'Card payments are not fully configured yet. Please choose another method.' });
        }
        try {
          const fwRes = await fetch('https://api.flutterwave.com/v3/payments', {
            method: 'POST',
            headers: { Authorization: `Bearer ${keys.secretKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tx_ref: attempt.id, amount: result.order.price, currency: result.order.currency,
              redirect_url: `${SITE_URL}/order.html?type=${orderType}&ref=${orderRef}&attempt=${attempt.id}`,
              customer: { email: result.order.email, name: result.order.name },
              customizations: { title: 'Rezoro', description: result.order.label, logo: `${SITE_URL}/logo.png` },
            }),
            signal: AbortSignal.timeout(15000),
          });
          const fwData = await fwRes.json();
          if (fwData.status !== 'success' || !fwData.data?.link) throw new Error('Flutterwave did not return a payment link.');
          return res.json({ attempt: toCustomerAttempt(attempt), paymentLink: fwData.data.link });
        } catch (e) {
          await transitionPaymentStatus(store, attempt.id, ['PENDING_PAYMENT'], 'FAILED', { failureReason: `Could not start Flutterwave checkout: ${e.message}` });
          return res.status(502).json({ error: 'Could not start card payment right now. Please try again or choose another method.' });
        }
      }

      const qrPng = CRYPTO_METHODS.includes(method) ? await qr.qrForAttempt(attempt).catch(() => null) : null;
      res.json({ attempt: toCustomerAttempt(attempt), hasQr: !!qrPng });
    })
  );

  router.get('/api/payment-attempts/:id', asyncHandler(async (req, res) => {
    const store = getStore();
    const attempt = await store.paymentAttempts.getById(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Payment attempt not found.' });
    res.json(toCustomerAttempt(attempt));
  }));

  router.get('/api/payment-attempts/:id/qr.png', asyncHandler(async (req, res) => {
    const store = getStore();
    const attempt = await store.paymentAttempts.getById(req.params.id);
    if (!attempt) return res.status(404).end();
    const png = await qr.qrForAttempt(attempt).catch(() => null);
    if (!png) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(png);
  }));

  // Customer submits proof of payment: TXID for crypto, sender name + bank
  // reference (+ optional receipt) for bank transfer. This alone never
  // activates anything — it only moves PENDING_PAYMENT -> PENDING_VERIFICATION
  // and, for crypto, triggers an immediate best-effort auto-verify attempt if
  // a provider is configured. Manual admin review handles the rest.
  router.post('/api/payment-attempts/:id/submit',
    rateLimit('attempt-submit', 20, 60 * 60 * 1000), upload.single('receipt'),
    asyncHandler(async (req, res) => {
      const store = getStore();
      const attempt = await store.paymentAttempts.getById(req.params.id);
      if (!attempt) return res.status(404).json({ error: 'Payment attempt not found.' });
      if (attempt.status !== 'PENDING_PAYMENT') {
        return res.status(409).json({ error: `This payment attempt is no longer awaiting submission (status: ${attempt.status}).` });
      }

      const patch = {};

      if (CRYPTO_METHODS.includes(attempt.method)) {
        const txid = String(req.body?.txid || '').trim();
        if (!txid) return res.status(400).json({ error: 'A transaction ID is required.' });
        const existing = await store.paymentAttempts.getByTxid(txid);
        if (existing && existing.id !== attempt.id) {
          await logEvent(store, {
            event: 'TXID_SUBMITTED', orderType: attempt.orderType, orderRef: attempt.orderRef,
            paymentAttemptId: attempt.id, actorType: 'customer',
            metadata: { rejected: true, reason: 'duplicate_txid' },
          });
          return res.status(409).json({ error: 'This transaction ID has already been used for another payment.' });
        }
        patch.txid = txid;
      } else if (attempt.method === 'bank_transfer') {
        const senderName = String(req.body?.senderName || '').trim();
        const bankReference = String(req.body?.bankReference || '').trim();
        if (!senderName) return res.status(400).json({ error: 'Sender name is required.' });
        patch.senderName = senderName;
        patch.bankReference = bankReference;
        if (req.file) {
          const sniffed = sniffReceiptFile(req.file.buffer);
          if (!sniffed) return res.status(400).json({ error: 'Receipt must be a JPG, PNG, or PDF file.' });
          patch.receipt = { buffer: req.file.buffer, mime: sniffed.mime };
        }
      } else {
        return res.status(400).json({ error: 'This payment method does not accept a manual submission.' });
      }

      const updated = await transitionPaymentStatus(store, attempt.id, ['PENDING_PAYMENT'], 'PENDING_VERIFICATION', patch);
      if (!updated) return res.status(409).json({ error: 'This payment attempt was already updated.' });

      await logEvent(store, {
        event: patch.receipt || patch.senderName ? 'RECEIPT_SUBMITTED' : 'TXID_SUBMITTED',
        orderType: attempt.orderType, orderRef: attempt.orderRef, paymentAttemptId: attempt.id,
        actorType: 'customer', metadata: { method: attempt.method },
      });

      // Best-effort immediate auto-verification for crypto — never blocks the
      // customer response longer than needed, and never marks PAID here
      // directly; it goes through the same gate as everything else.
      if (CRYPTO_METHODS.includes(attempt.method)) {
        verifyAndMaybeActivate(store, updated).catch(e => console.error('[payments] auto-verify failed:', e.message));
      }

      res.json({ success: true, status: 'PENDING_VERIFICATION' });
    })
  );

  async function verifyAndMaybeActivate(store, attempt) {
    await logEvent(store, {
      event: 'PAYMENT_VERIFICATION_STARTED', orderType: attempt.orderType, orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'system',
    });
    const result = await verifyCryptoPayment(attempt);
    if (!result.available) return; // no provider configured — stays PENDING_VERIFICATION for manual review

    if (!result.verified) {
      const nextStatus = result.underpayment ? 'UNDERPAYMENT_REVIEW' : result.overpayment ? 'OVERPAYMENT_REVIEW' : null;
      if (nextStatus) {
        await transitionPaymentStatus(store, attempt.id, ['PENDING_VERIFICATION'], nextStatus, { verificationResult: result });
        await logEvent(store, {
          event: nextStatus === 'UNDERPAYMENT_REVIEW' ? 'UNDERPAYMENT_DETECTED' : 'OVERPAYMENT_DETECTED',
          orderType: attempt.orderType, orderRef: attempt.orderRef, paymentAttemptId: attempt.id, actorType: 'system',
        });
      } else {
        await store.paymentAttempts.update(attempt.id, { verificationResult: result, failureReason: result.failureReason });
        await logEvent(store, {
          event: 'PAYMENT_VERIFICATION_FAILED', orderType: attempt.orderType, orderRef: attempt.orderRef,
          paymentAttemptId: attempt.id, actorType: 'system', metadata: { reason: result.failureReason },
        });
      }
      return;
    }

    await activateMembershipAfterVerifiedPayment(store, {
      paymentAttemptId: attempt.id, fromStatuses: ['PENDING_VERIFICATION'], verificationResult: result,
    });
  }

  /* ══════════════════════════════════════════════════════════
     ADMIN — settings
  ═══════════════════════════════════════════════════════════ */

  router.get('/api/admin/payments/settings', adminAuthMiddleware, asyncHandler(async (_req, res) => {
    const store = getStore();
    const all = await settings.getAllMethodSettings(store);
    // Non-secret presence flags only — never the keys themselves — so the
    // admin UI can show "live credentials configured" without exposing them.
    all.flutterwave.keyStatus = {
      hasTestKeys: !settings.flutterwaveTestCanEnable(),
      hasLiveKeys: !settings.flutterwaveLiveCanEnable(),
    };
    res.json(all);
  }));

  router.put('/api/admin/payments/settings/:method', adminAuthMiddleware, asyncHandler(async (req, res) => {
    const store = getStore();
    const { method } = req.params;
    if (!['flutterwave', 'bank_transfer', 'bitcoin', 'usdc'].includes(method)) {
      return res.status(400).json({ error: 'Unknown payment method.' });
    }
    const current = await settings.getMethodSettings(store, method);
    const next = req.body?.settings;
    if (!next || typeof next !== 'object') return res.status(400).json({ error: 'settings object is required.' });

    const sensitiveChanged = isSensitiveChange(method, current, next);
    if (sensitiveChanged && req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'This change affects where money is sent or received and requires explicit confirmation.', requiresConfirmation: true });
    }

    const validationError = validateBeforeSave(method, next);
    if (validationError) return res.status(400).json({ error: validationError });

    await settings.setMethodSettings(store, method, next);
    await logEvent(store, {
      event: 'PAYMENT_SETTING_CHANGED', actorType: 'admin', actorId: 'admin',
      metadata: { method, changedFields: diffFields(current, next) },
    });
    res.json({ success: true, settings: next });
  }));

  function diffFields(oldCfg, newCfg) {
    const changed = [];
    const scan = (o, n, prefix = '') => {
      const keys = new Set([...Object.keys(o || {}), ...Object.keys(n || {})]);
      for (const k of keys) {
        const ov = o?.[k], nv = n?.[k];
        if (ov && typeof ov === 'object' && nv && typeof nv === 'object' && !Array.isArray(ov)) {
          scan(ov, nv, `${prefix}${k}.`);
        } else if (JSON.stringify(ov) !== JSON.stringify(nv)) {
          changed.push({ field: `${prefix}${k}`, old: ov, new: nv });
        }
      }
    };
    scan(oldCfg, newCfg);
    return changed;
  }

  function isSensitiveChange(method, current, next) {
    const sensitiveKeys = {
      flutterwave: ['mode'],
      bank_transfer: ['bankName', 'accountHolder', 'accountNumber', 'iban', 'swift'],
      bitcoin: ['address'],
      usdc: null, // handled per-network below
    };
    if (method === 'usdc') {
      for (const n of settings.USDC_NETWORKS) {
        const c = current.networks?.[n] || {}, x = next.networks?.[n] || {};
        if (c.wallet !== x.wallet || c.tokenContract !== x.tokenContract || c.tokenMint !== x.tokenMint) return true;
      }
      return false;
    }
    return (sensitiveKeys[method] || []).some(k => current[k] !== next[k]);
  }

  function validateBeforeSave(method, cfg) {
    if (method === 'flutterwave' && cfg.status === 'enabled') {
      const err = cfg.mode === 'live' ? settings.flutterwaveLiveCanEnable() : settings.flutterwaveTestCanEnable();
      if (err) return err;
    }
    if (method === 'bank_transfer' && cfg.status === 'enabled') {
      const err = settings.bankTransferCanEnable(cfg);
      if (err) return err;
    }
    if (method === 'bitcoin' && cfg.status === 'enabled') {
      const err = settings.bitcoinCanEnable(cfg);
      if (err) return err;
    }
    if (method === 'usdc') {
      for (const n of settings.USDC_NETWORKS) {
        const netCfg = cfg.networks?.[n];
        if (netCfg?.status === 'enabled') {
          const err = settings.usdcNetworkCanEnable(n, netCfg);
          if (err) return `USDC ${n}: ${err}`;
        }
      }
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════
     ADMIN — payments review queue
  ═══════════════════════════════════════════════════════════ */

  router.get('/api/admin/payments', adminAuthMiddleware, asyncHandler(async (req, res) => {
    const store = getStore();
    const { status, orderType } = req.query;
    const filterStatus = status === 'needs_review' ? REVIEW_STATUSES : status ? [status] : undefined;
    const attempts = await store.paymentAttempts.all({ status: filterStatus, orderType: orderType || undefined });
    const enriched = await Promise.all(attempts.map(async a => {
      const order = await getOrderInfo(store, a.orderType, a.orderRef).catch(() => null);
      return { ...a, orderLabel: order?.label || null, customerName: order?.name || null, customerEmail: order?.email || null };
    }));
    res.json(enriched);
  }));

  router.get('/api/admin/payments/:id', adminAuthMiddleware, asyncHandler(async (req, res) => {
    const store = getStore();
    const attempt = await store.paymentAttempts.getById(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Payment attempt not found.' });
    const order = await getOrderInfo(store, attempt.orderType, attempt.orderRef).catch(() => null);
    const audit = await store.paymentAuditLog.byPaymentAttempt(attempt.id);
    res.json({ ...attempt, order, audit });
  }));

  router.get('/api/admin/payments/:id/receipt', adminAuthMiddleware, asyncHandler(async (req, res) => {
    const store = getStore();
    const receipt = await store.paymentAttempts.getReceipt(req.params.id);
    if (!receipt) return res.status(404).end();
    res.set('Content-Type', receipt.mime || 'application/octet-stream');
    res.send(receipt.buffer);
  }));

  router.post('/api/admin/payments/:id/approve', adminAuthMiddleware, asyncHandler(async (req, res) => {
    const store = getStore();
    const attempt = await store.paymentAttempts.getById(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Payment attempt not found.' });
    if (!REVIEW_STATUSES.includes(attempt.status)) {
      if (attempt.status === 'PAID' || attempt.status === 'TEST_PAID') {
        return res.json({ success: true, alreadyPaid: true });
      }
      return res.status(409).json({ error: `Cannot approve a payment in status ${attempt.status}.` });
    }
    const result = await activateMembershipAfterVerifiedPayment(store, {
      paymentAttemptId: attempt.id, fromStatuses: [attempt.status],
    });
    if (!result.activated && result.reason !== 'already_fulfilled') {
      return res.status(409).json({ error: 'Could not approve — the payment attempt state changed. Please refresh.' });
    }
    await store.paymentAttempts.update(attempt.id, { approvedAt: new Date().toISOString(), approvedBy: 'admin' });
    await logEvent(store, {
      event: 'PAYMENT_APPROVED', orderType: attempt.orderType, orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'admin', actorId: 'admin',
      metadata: { note: (req.body?.note || '').slice(0, 500) },
    });
    res.json({ success: true });
  }));

  router.post('/api/admin/payments/:id/reject', adminAuthMiddleware, asyncHandler(async (req, res) => {
    const store = getStore();
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });
    const attempt = await store.paymentAttempts.getById(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Payment attempt not found.' });
    if (!REVIEW_STATUSES.includes(attempt.status)) {
      return res.status(409).json({ error: `Cannot reject a payment in status ${attempt.status}.` });
    }
    const updated = await transitionPaymentStatus(store, attempt.id, [attempt.status], 'REJECTED', {
      rejectedAt: new Date().toISOString(), rejectedBy: 'admin', rejectionReason: reason,
    });
    if (!updated) return res.status(409).json({ error: 'Payment attempt state changed. Please refresh.' });
    await logEvent(store, {
      event: 'PAYMENT_REJECTED', orderType: attempt.orderType, orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'admin', actorId: 'admin', metadata: { reason },
    });
    res.json({ success: true });
  }));

  app.use(router);
}

module.exports = { mountPaymentRoutes };
