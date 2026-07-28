'use strict';

// One Transfer(address,address,uint256) event topic0, shared by every ERC-20.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_DECIMALS = 6;

// Etherscan migrated to a unified "V2" API (api.etherscan.io/v2/api?chainid=...)
// where a single Etherscan API key works across every chain they support,
// Base included — a separate Basescan key is no longer required. We still
// honor BASESCAN_API_KEY first if someone has one from before the merge, so
// nothing breaks for an existing separate-key setup, but ETHERSCAN_API_KEY
// alone is enough to cover both chains going forward.
const V2_API_BASE = 'https://api.etherscan.io/v2/api';
const CHAINS = {
  ethereum: { chainId: 1, keyEnvs: ['ETHERSCAN_API_KEY'] },
  base: { chainId: 8453, keyEnvs: ['BASESCAN_API_KEY', 'ETHERSCAN_API_KEY'] },
};

function topicToAddress(topic) {
  return '0x' + topic.slice(26).toLowerCase();
}

function addressToTopicSuffix(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function rpcCall(chainId, apiKey, params) {
  const url = `${V2_API_BASE}?chainid=${chainId}&module=proxy&${params}&apikey=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Provider RPC error');
  return data.result;
}

/*
 * Verifies a specific transaction hash paid the configured USDC contract to
 * the configured wallet, for at least the expected amount, with enough
 * block confirmations. Chain-agnostic — `chain` selects Etherscan vs
 * Basescan, everything else is identical since both are standard EVM
 * chains. Returns `{ available: false }` untouched (no network call) when
 * the relevant API key isn't configured.
 */
async function verifyEvmUsdcPayment({ chain, txid, expectedContract, expectedToAddress, expectedAmount, requiredConfirmations }) {
  const chainCfg = CHAINS[chain];
  if (!chainCfg) return { available: false, failureReason: `Unsupported EVM chain: ${chain}` };
  const apiKey = chainCfg.keyEnvs.map(k => process.env[k]).find(Boolean) || '';
  if (!apiKey) return { available: false };

  let receipt, blockNumberHex;
  try {
    receipt = await rpcCall(chainCfg.chainId, apiKey, `action=eth_getTransactionReceipt&txhash=${txid}`);
    blockNumberHex = await rpcCall(chainCfg.chainId, apiKey, 'action=eth_blockNumber');
  } catch (e) {
    return { available: true, verified: false, failureReason: `Provider request failed: ${e.message}` };
  }

  if (!receipt) {
    return { available: true, verified: false, txid, failureReason: 'Transaction not found yet — it may still be pending.' };
  }
  if (receipt.status !== '0x1') {
    return { available: true, verified: false, txid, failureReason: 'Transaction failed on-chain.' };
  }

  const expectedTopicTo = addressToTopicSuffix(expectedToAddress);
  const matchingLog = (receipt.logs || []).find(log =>
    log.address?.toLowerCase() === expectedContract.toLowerCase() &&
    log.topics?.[0] === TRANSFER_TOPIC &&
    log.topics?.[2]?.toLowerCase().endsWith(expectedTopicTo)
  );

  if (!matchingLog) {
    return {
      available: true, verified: false, asset: 'USDC', network: chain.toUpperCase(), txid,
      failureReason: 'No matching USDC transfer to the configured wallet was found in this transaction.',
    };
  }

  const rawAmount = BigInt(matchingLog.data);
  const expectedRaw = BigInt(Math.round(expectedAmount * 10 ** USDC_DECIMALS));
  const amount = Number(rawAmount) / 10 ** USDC_DECIMALS;

  const currentBlock = parseInt(blockNumberHex, 16);
  const txBlock = parseInt(receipt.blockNumber, 16);
  const confirmations = Number.isFinite(currentBlock) && Number.isFinite(txBlock) ? currentBlock - txBlock : 0;

  const underpaid = rawAmount < expectedRaw;
  const verified = !underpaid && confirmations >= requiredConfirmations;

  return {
    available: true, verified, asset: 'USDC', network: chain.toUpperCase(),
    token: matchingLog.address, destination: expectedToAddress, amount, confirmations, txid,
    underpayment: underpaid,
    overpayment: rawAmount > (expectedRaw * 102n) / 100n,
    failureReason: verified ? null
      : underpaid ? 'Amount received is less than expected.'
      : `Waiting for confirmations (${confirmations}/${requiredConfirmations}).`,
  };
}

module.exports = { verifyEvmUsdcPayment, CHAINS };
