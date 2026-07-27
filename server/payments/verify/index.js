'use strict';

const { verifyBitcoinPayment } = require('./bitcoin');
const { verifyEvmUsdcPayment } = require('./evm');
const { verifySolanaUsdcPayment } = require('./solana');
const { verifyTronUsdcPayment } = require('./tron');

/*
 * Single entry point for "check whether this attempt's submitted TXID is a
 * real, sufficient, confirmed payment" — dispatches to the right chain
 * verifier by `attempt.method`/`attempt.network`. Every verifier returns the
 * same normalized shape (see the individual modules); this just picks which
 * one to call and forwards the attempt's own snapshot as the expected
 * values, never anything live from current settings.
 */
async function verifyCryptoPayment(attempt) {
  const snap = attempt.destinationSnapshot || {};

  if (attempt.method === 'bitcoin') {
    return verifyBitcoinPayment({
      txid: attempt.txid, expectedAddress: snap.address,
      expectedAmountBtc: attempt.expectedCryptoAmount, requiredConfirmations: snap.requiredConfirmations,
    });
  }

  if (attempt.method === 'usdc') {
    const network = (attempt.network || '').toLowerCase();
    if (network === 'ethereum' || network === 'base') {
      return verifyEvmUsdcPayment({
        chain: network, txid: attempt.txid, expectedContract: attempt.tokenIdentifier,
        expectedToAddress: snap.wallet, expectedAmount: attempt.expectedCryptoAmount,
        requiredConfirmations: snap.requiredConfirmations,
      });
    }
    if (network === 'solana') {
      return verifySolanaUsdcPayment({
        txid: attempt.txid, expectedMint: attempt.tokenIdentifier,
        expectedWallet: snap.wallet, expectedAmount: attempt.expectedCryptoAmount,
      });
    }
    if (network === 'tron') {
      return verifyTronUsdcPayment({
        txid: attempt.txid, expectedContract: attempt.tokenIdentifier,
        expectedWallet: snap.wallet, expectedAmount: attempt.expectedCryptoAmount,
        requiredConfirmations: snap.requiredConfirmations,
      });
    }
    return { available: false, failureReason: `Unsupported USDC network: ${attempt.network}` };
  }

  return { available: false, failureReason: `${attempt.method} is not a crypto payment method.` };
}

module.exports = { verifyCryptoPayment };
