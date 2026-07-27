'use strict';

const QRCode = require('qrcode');

/*
 * QR codes are generated strictly from the payment attempt's own snapshot —
 * never from live settings — so a QR always matches the instructions shown
 * beside it. The human-readable asset/network/address/amount text is the
 * source of truth; the QR is a convenience, never the only way to read the
 * destination (spec §26).
 */

// Standard BIP21 URI so wallet apps prefill both address and amount.
function bitcoinUri({ address, amountBtc }) {
  const amt = amountBtc != null ? `?amount=${amountBtc}` : '';
  return `bitcoin:${address}${amt}`;
}

// No universal payment-URI standard spans all four USDC networks safely —
// encoding just the bare address (never a token-specific URI scheme that
// could be misread by the wrong wallet) keeps the QR from ever implying an
// incorrect network on its own.
function usdcQrPayload({ address }) {
  return address;
}

async function pngDataUrl(text) {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}

async function pngBuffer(text) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 1, width: 320, type: 'png' });
}

async function qrForAttempt(attempt) {
  const snap = attempt.destinationSnapshot || {};
  if (attempt.method === 'bitcoin') {
    return pngBuffer(bitcoinUri({ address: snap.address, amountBtc: attempt.expectedCryptoAmount }));
  }
  if (attempt.method === 'usdc') {
    return pngBuffer(usdcQrPayload({ address: snap.wallet }));
  }
  return null;
}

module.exports = { bitcoinUri, usdcQrPayload, pngDataUrl, pngBuffer, qrForAttempt };
