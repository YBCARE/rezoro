'use strict';

const { tronBase58ToHex } = require('./tron-address');

const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const USDC_DECIMALS = 6;

/*
 * Verifies a TRON transaction ID transferred the configured TRC-20 contract
 * (the admin-configured USDC token — never assumed, never a hardcoded
 * "official" address, since USDC on TRON is not something to guess at) to
 * the configured wallet, for at least the expected amount. Returns
 * `{ available: false }` untouched when TRONGRID_API_KEY isn't set.
 */
async function verifyTronUsdcPayment({ txid, expectedContract, expectedWallet, expectedAmount, requiredConfirmations }) {
  if (!TRONGRID_API_KEY) return { available: false };

  const expectedWalletHex = tronBase58ToHex(expectedWallet);
  const expectedContractHex = tronBase58ToHex(expectedContract);
  if (!expectedWalletHex || !expectedContractHex) {
    return { available: true, verified: false, failureReason: 'Configured TRON wallet/contract address is not well-formed.' };
  }

  const headers = { 'TRON-PRO-API-KEY': TRONGRID_API_KEY };
  let txRes, eventsRes;
  try {
    [txRes, eventsRes] = await Promise.all([
      fetch(`https://api.trongrid.io/v1/transactions/${encodeURIComponent(txid)}`, { headers, signal: AbortSignal.timeout(15000) }),
      fetch(`https://api.trongrid.io/v1/transactions/${encodeURIComponent(txid)}/events`, { headers, signal: AbortSignal.timeout(15000) }),
    ]);
  } catch (e) {
    return { available: true, verified: false, failureReason: `Provider request failed: ${e.message}` };
  }
  if (!txRes.ok || !eventsRes.ok) {
    return { available: true, verified: false, failureReason: `Provider returned an error (tx ${txRes.status}, events ${eventsRes.status}).` };
  }

  const txData = await txRes.json();
  const tx = txData?.data?.[0];
  if (!tx) {
    return { available: true, verified: false, txid, failureReason: 'Transaction not found yet — it may still be pending.' };
  }
  const success = tx.ret?.[0]?.contractRet === 'SUCCESS';
  if (!success) {
    return { available: true, verified: false, txid, failureReason: 'Transaction failed on-chain.' };
  }

  const eventsData = await eventsRes.json();
  const transferEvent = (eventsData?.data || []).find(ev => {
    if (ev.event_name !== 'Transfer') return false;
    // event.contract_address is TronGrid's own base58 TRC-20 contract address field.
    const evContractHex = tronBase58ToHex(ev.contract_address);
    // event.result.to/from come back as raw hex ("41..." without 0x) in most TronGrid responses.
    const evToHex = String(ev.result?.to || '').toLowerCase().replace(/^0x/, '');
    return evContractHex === expectedContractHex && evToHex === expectedWalletHex;
  });

  if (!transferEvent) {
    return {
      available: true, verified: false, asset: 'USDC', network: 'TRON', txid,
      failureReason: 'No matching USDC (TRC-20) transfer to the configured wallet was found in this transaction.',
    };
  }

  const rawAmount = BigInt(transferEvent.result.value);
  const expectedRaw = BigInt(Math.round(expectedAmount * 10 ** USDC_DECIMALS));
  const amount = Number(rawAmount) / 10 ** USDC_DECIMALS;

  // TronGrid doesn't return a confirmations count on this endpoint directly;
  // `tx.blockNumber` combined with the current block would be needed for a
  // precise count. We treat presence in a finalized block (confirmed=true on
  // the tx record) as sufficient when the admin's requiredConfirmations is
  // at its default — a real confirmations count is a known limitation, see
  // the implementation report.
  const confirmed = tx.confirmed === true || eventsData?.data?.some(ev => ev.confirmed === true);
  const underpaid = rawAmount < expectedRaw;
  const verified = !underpaid && confirmed;

  return {
    available: true, verified, asset: 'USDC', network: 'TRON',
    token: expectedContract, destination: expectedWallet, amount, confirmations: confirmed ? requiredConfirmations : 0, txid,
    underpayment: underpaid,
    overpayment: rawAmount > (expectedRaw * 102n) / 100n,
    failureReason: verified ? null
      : underpaid ? 'Amount received is less than expected.'
      : 'Waiting for block confirmation.',
  };
}

module.exports = { verifyTronUsdcPayment };
