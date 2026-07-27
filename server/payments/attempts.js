'use strict';

const settings = require('./settings');
const { logEvent } = require('./audit');

/*
 * Looks up the product-specific order (a fancard order or a booking) that a
 * payment attempt is being created for. This is the ONLY place price is
 * read for attempt creation — always from the stored order row, never from
 * anything the client sends.
 */
async function getOrderInfo(store, orderType, orderRef) {
  if (orderType === 'fancard') {
    const order = await store.fancardOrders.getByRef(orderRef);
    if (!order) return null;
    return {
      exists: true, price: Number(order.price), currency: 'USD', email: order.email,
      name: order.fanName, alreadyFulfilled: order.status === 'paid', label: `${order.celebName} — ${order.tier} Fan Card`,
    };
  }
  if (orderType === 'booking') {
    const booking = await store.bookings.getByRef(orderRef);
    if (!booking) return null;
    return {
      exists: true, price: Number(booking.price), currency: 'USD', email: booking.email,
      name: booking.name, alreadyFulfilled: booking.status === 'confirmed', label: `${booking.celebName} — ${booking.tier} Booking`,
    };
  }
  return null;
}

// CoinGecko's public simple-price endpoint needs no API key. If it fails we
// refuse to create the attempt rather than guess a rate — a wrong BTC amount
// is a customer-money-safety issue, not something to silently approximate.
async function getBtcUsdRate() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('Rate lookup failed');
  const data = await res.json();
  const rate = data?.bitcoin?.usd;
  if (!rate || !Number.isFinite(rate)) throw new Error('Rate lookup returned no usable price');
  return rate;
}

function methodStatusError(cfg, label) {
  if (cfg.status === 'disabled') return `${label} is not available.`;
  if (cfg.status === 'maintenance') return cfg.maintenanceMessage || `${label} is temporarily unavailable. Please choose another payment method.`;
  return null;
}

/**
 * Creates a new payment attempt for an existing order. Every payment-critical
 * field (destination, expected amount, rate, expiry) is computed here, once,
 * and frozen into the attempt row — later settings changes never touch an
 * attempt that already exists (spec: snapshot immutability).
 */
async function createPaymentAttempt(store, { orderType, orderRef, method, network, actorId }) {
  const order = await getOrderInfo(store, orderType, orderRef);
  if (!order) return { error: 'Order not found.', code: 404 };
  if (order.alreadyFulfilled) return { error: 'This order has already been paid.', code: 409 };

  const now = new Date();
  let attemptData;

  if (method === 'flutterwave') {
    const cfg = await settings.getMethodSettings(store, 'flutterwave');
    const err = methodStatusError(cfg, 'Card payment');
    if (err) return { error: err, code: 409 };
    attemptData = {
      orderType, orderRef, method, asset: order.currency, network: null, tokenIdentifier: null,
      environment: cfg.mode, destinationSnapshot: {}, expectedAmount: order.price,
      expectedCurrency: order.currency, expectedCryptoAmount: null,
    };
  } else if (method === 'bank_transfer') {
    const cfg = await settings.getMethodSettings(store, 'bank_transfer');
    const err = methodStatusError(cfg, 'Bank transfer');
    if (err) return { error: err, code: 409 };
    attemptData = {
      orderType, orderRef, method, asset: cfg.currency, network: null, tokenIdentifier: null,
      environment: 'live',
      destinationSnapshot: {
        bankName: cfg.bankName, accountHolder: cfg.accountHolder, accountNumber: cfg.accountNumber,
        iban: cfg.iban || null, swift: cfg.swift || null, currency: cfg.currency, instructions: cfg.instructions || '',
      },
      expectedAmount: order.price, expectedCurrency: cfg.currency, expectedCryptoAmount: null,
    };
  } else if (method === 'bitcoin') {
    const cfg = await settings.getMethodSettings(store, 'bitcoin');
    const err = methodStatusError(cfg, 'Bitcoin');
    if (err) return { error: err, code: 409 };
    let rate;
    try { rate = await getBtcUsdRate(); }
    catch (e) { return { error: 'Could not fetch a live BTC/USD rate right now. Please try again shortly.', code: 503 }; }
    const btcAmount = Number((order.price / rate).toFixed(8));
    attemptData = {
      orderType, orderRef, method, asset: 'BTC', network: 'BITCOIN', tokenIdentifier: null,
      environment: 'live',
      destinationSnapshot: { address: cfg.address, requiredConfirmations: cfg.requiredConfirmations },
      expectedAmount: order.price, expectedCurrency: 'USD', expectedCryptoAmount: btcAmount,
      rateSource: 'coingecko', rateTimestamp: now.toISOString(),
      expiresAt: new Date(now.getTime() + cfg.expirationMinutes * 60000).toISOString(),
    };
  } else if (method === 'usdc') {
    if (!settings.USDC_NETWORKS.includes(network)) return { error: 'Unknown USDC network.', code: 400 };
    const cfg = await settings.getMethodSettings(store, 'usdc');
    const overallErr = methodStatusError(cfg, 'USDC');
    if (overallErr) return { error: overallErr, code: 409 };
    const netCfg = cfg.networks[network];
    const netErr = methodStatusError(netCfg, `USDC on ${network}`);
    if (netErr) return { error: netErr, code: 409 };
    const tokenField = network === 'solana' ? 'tokenMint' : 'tokenContract';
    attemptData = {
      orderType, orderRef, method, asset: 'USDC', network: network.toUpperCase(),
      tokenIdentifier: netCfg[tokenField], environment: 'live',
      destinationSnapshot: {
        wallet: netCfg.wallet, [tokenField]: netCfg[tokenField],
        requiredConfirmations: netCfg.requiredConfirmations, network,
      },
      expectedAmount: order.price, expectedCurrency: 'USD', expectedCryptoAmount: order.price,
      rateSource: 'pegged_1_1', rateTimestamp: now.toISOString(),
      expiresAt: new Date(now.getTime() + netCfg.expirationMinutes * 60000).toISOString(),
    };
  } else {
    return { error: 'Unknown payment method.', code: 400 };
  }

  const attempt = await store.paymentAttempts.create(attemptData);
  await logEvent(store, {
    event: 'PAYMENT_ATTEMPT_CREATED', orderType, orderRef, paymentAttemptId: attempt.id,
    actorType: actorId ? 'customer' : 'system', actorId,
    metadata: { method, network: network || null, expectedAmount: attemptData.expectedAmount },
  });
  return { attempt, order };
}

module.exports = { getOrderInfo, getBtcUsdRate, createPaymentAttempt };
