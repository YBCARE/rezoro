'use strict';

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';

/*
 * BlockCypher verification for a single Bitcoin transaction. Returns
 * `{ available: false }` with no network call at all when no token is
 * configured — callers must treat that as "cannot auto-verify right now",
 * never as "verified". Never trusts anything about the payment except what
 * this lookup itself confirms: the transaction exists, pays the expected
 * address, for at least the expected amount, with enough confirmations.
 */
async function verifyBitcoinPayment({ txid, expectedAddress, expectedAmountBtc, requiredConfirmations }) {
  if (!BLOCKCYPHER_TOKEN) return { available: false };

  let res;
  try {
    res = await fetch(
      `https://api.blockcypher.com/v1/btc/main/txs/${encodeURIComponent(txid)}?token=${BLOCKCYPHER_TOKEN}&limit=500`,
      { signal: AbortSignal.timeout(15000) }
    );
  } catch (e) {
    return { available: true, verified: false, failureReason: `Provider request failed: ${e.message}` };
  }
  if (res.status === 404) {
    return { available: true, verified: false, failureReason: 'Transaction not found on the Bitcoin network yet.' };
  }
  if (!res.ok) {
    return { available: true, verified: false, failureReason: `Provider returned HTTP ${res.status}.` };
  }

  const tx = await res.json();
  const expectedSats = Math.round(expectedAmountBtc * 1e8);
  const payingOutput = (tx.outputs || []).find(
    o => Array.isArray(o.addresses) && o.addresses.includes(expectedAddress)
  );

  if (!payingOutput) {
    return {
      available: true, verified: false, asset: 'BTC', network: 'BITCOIN', txid,
      failureReason: 'This transaction does not pay the configured receiving address.',
    };
  }

  const paidBtc = payingOutput.value / 1e8;
  const confirmations = tx.confirmations ?? 0;
  const underpaid = payingOutput.value < expectedSats;
  const verified = !underpaid && confirmations >= requiredConfirmations;

  return {
    available: true, verified, asset: 'BTC', network: 'BITCOIN',
    destination: expectedAddress, amount: paidBtc, confirmations, txid,
    blockTimestamp: tx.confirmed || null,
    underpayment: underpaid,
    overpayment: payingOutput.value > expectedSats * 1.02,
    failureReason: verified ? null
      : underpaid ? 'Amount received is less than expected.'
      : `Waiting for confirmations (${confirmations}/${requiredConfirmations}).`,
  };
}

module.exports = { verifyBitcoinPayment };
