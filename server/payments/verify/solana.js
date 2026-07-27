'use strict';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || '';

async function rpc(method, params) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RPC returned HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

/*
 * Verifies a Solana transaction signature transferred the configured USDC
 * mint to the configured wallet's associated token account, for at least
 * the expected amount. Requested at 'confirmed' commitment — Solana's own
 * notion of finality via the RPC call itself, rather than a manual
 * confirmations counter like Bitcoin/EVM use (there is no equivalent
 * "N confirmations" concept for Solana transactions). Returns
 * `{ available: false }` untouched when no SOLANA_RPC_URL is configured —
 * the public Solana RPC is far too rate-limited for production use, so this
 * intentionally does not fall back to it.
 */
async function verifySolanaUsdcPayment({ txid, expectedMint, expectedWallet, expectedAmount }) {
  if (!SOLANA_RPC_URL) return { available: false };

  let tx;
  try {
    tx = await rpc('getTransaction', [txid, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  } catch (e) {
    return { available: true, verified: false, failureReason: `Provider request failed: ${e.message}` };
  }
  if (!tx) {
    return { available: true, verified: false, txid, failureReason: 'Transaction not found yet — it may still be pending.' };
  }
  if (tx.meta?.err) {
    return { available: true, verified: false, txid, failureReason: 'Transaction failed on-chain.' };
  }

  const pre = tx.meta?.preTokenBalances || [];
  const post = tx.meta?.postTokenBalances || [];

  const matchPost = post.find(b => b.mint === expectedMint && b.owner === expectedWallet);
  if (!matchPost) {
    return {
      available: true, verified: false, asset: 'USDC', network: 'SOLANA', txid,
      failureReason: 'No matching USDC balance change for the configured wallet was found in this transaction.',
    };
  }
  const matchPre = pre.find(b => b.accountIndex === matchPost.accountIndex);
  const preAmount = matchPre?.uiTokenAmount?.uiAmount || 0;
  const postAmount = matchPost.uiTokenAmount?.uiAmount || 0;
  const delta = postAmount - preAmount;

  const underpaid = delta < expectedAmount;
  const verified = !underpaid;

  return {
    available: true, verified, asset: 'USDC', network: 'SOLANA',
    token: expectedMint, destination: expectedWallet, amount: delta, confirmations: verified ? 1 : 0, txid,
    blockTimestamp: tx.blockTime ? tx.blockTime * 1000 : null,
    underpayment: underpaid,
    overpayment: delta > expectedAmount * 1.02,
    failureReason: verified ? null : 'Amount received is less than expected.',
  };
}

module.exports = { verifySolanaUsdcPayment };
