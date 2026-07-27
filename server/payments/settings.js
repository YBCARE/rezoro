'use strict';

/*
 * Payment method configuration, stored in the existing store.settings
 * key/value table (same mechanism as fancard-pricing/fancard-benefits) —
 * no new settings table needed. Secrets never live here; only public,
 * admin-editable configuration (destinations, messages, thresholds).
 */

const SETTINGS_KEYS = {
  flutterwave: 'payment-settings:flutterwave',
  bank_transfer: 'payment-settings:bank_transfer',
  bitcoin: 'payment-settings:bitcoin',
  usdc: 'payment-settings:usdc',
};

const USDC_NETWORKS = ['base', 'ethereum', 'solana', 'tron'];

const DEFAULT_MSG = {
  flutterwave: 'Card payments are temporarily unavailable. Please choose another payment method.',
  bank_transfer: 'Bank transfer is temporarily unavailable. Please choose another payment method.',
  bitcoin: 'Bitcoin payments are temporarily unavailable. Please choose another payment method.',
  usdc: 'USDC payments are temporarily unavailable. Please choose another payment method.',
  base: 'USDC on Base is temporarily unavailable.',
  ethereum: 'USDC on Ethereum is temporarily unavailable.',
  solana: 'USDC on Solana is temporarily unavailable.',
  tron: 'USDC on TRON is temporarily unavailable.',
};

function defaultUsdcNetwork(net) {
  const confirmations = { base: 12, ethereum: 12, solana: 1, tron: 20 }[net];
  const base = { status: 'disabled', wallet: '', requiredConfirmations: confirmations, expirationMinutes: 60, maintenanceMessage: DEFAULT_MSG[net] };
  return net === 'solana' ? { ...base, tokenMint: '' } : { ...base, tokenContract: '' };
}

function defaults(method) {
  switch (method) {
    case 'flutterwave':
      return { status: 'disabled', mode: 'test', maintenanceMessage: DEFAULT_MSG.flutterwave };
    case 'bank_transfer':
      return { status: 'disabled', bankName: '', accountHolder: '', accountNumber: '', iban: '', currency: 'USD', swift: '', instructions: '', maintenanceMessage: DEFAULT_MSG.bank_transfer };
    case 'bitcoin':
      return { status: 'disabled', address: '', requiredConfirmations: 2, expirationMinutes: 60, maintenanceMessage: DEFAULT_MSG.bitcoin };
    case 'usdc': {
      const networks = {};
      for (const n of USDC_NETWORKS) networks[n] = defaultUsdcNetwork(n);
      return { status: 'disabled', maintenanceMessage: DEFAULT_MSG.usdc, networks };
    }
    default:
      throw new Error(`Unknown payment method: ${method}`);
  }
}

// Shallow + one-level-deep merge (only usdc.networks needs the extra level) —
// avoids a stored partial config silently dropping fields added in later
// deploys, without pulling in a generic deep-merge dependency.
function mergeWithDefaults(method, stored) {
  const base = defaults(method);
  if (!stored) return base;
  if (method !== 'usdc') return { ...base, ...stored };
  const merged = { ...base, ...stored, networks: { ...base.networks } };
  for (const n of USDC_NETWORKS) {
    merged.networks[n] = { ...base.networks[n], ...(stored.networks && stored.networks[n]) };
  }
  return merged;
}

async function getMethodSettings(store, method) {
  const stored = await store.settings.get(SETTINGS_KEYS[method], null);
  return mergeWithDefaults(method, stored);
}

async function getAllMethodSettings(store) {
  const [flutterwave, bank_transfer, bitcoin, usdc] = await Promise.all([
    getMethodSettings(store, 'flutterwave'),
    getMethodSettings(store, 'bank_transfer'),
    getMethodSettings(store, 'bitcoin'),
    getMethodSettings(store, 'usdc'),
  ]);
  return { flutterwave, bank_transfer, bitcoin, usdc };
}

async function setMethodSettings(store, method, value) {
  await store.settings.set(SETTINGS_KEYS[method], value);
  return value;
}

/* ── Address format validation (loose — formats evolve, this is a sanity
   check against obvious typos/garbage, not a definitive validator) ────── */
const ADDRESS_PATTERNS = {
  bitcoin: /^(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  evm: /^0x[a-fA-F0-9]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

function isValidAddress(kind, address) {
  const pattern = ADDRESS_PATTERNS[kind];
  return !!pattern && typeof address === 'string' && pattern.test(address.trim());
}

/* ── Required-configuration gates before a method/network may be ENABLED
   (spec §43) — enforced here, server-side, not just in the admin UI ───── */
function bitcoinCanEnable(cfg) {
  if (!cfg.address) return 'A receiving Bitcoin address is required.';
  if (!isValidAddress('bitcoin', cfg.address)) return 'That does not look like a valid Bitcoin address.';
  return null;
}

function usdcNetworkCanEnable(network, cfg) {
  if (!cfg.wallet) return 'A receiving wallet address is required.';
  const addrKind = network === 'solana' ? 'solana' : network === 'tron' ? 'tron' : 'evm';
  if (!isValidAddress(addrKind, cfg.wallet)) return `That does not look like a valid ${network} address.`;
  const tokenField = network === 'solana' ? 'tokenMint' : 'tokenContract';
  if (!cfg[tokenField]) return `An expected USDC ${network === 'solana' ? 'mint' : 'contract'} address is required.`;
  const tokenAddrKind = network === 'solana' ? 'solana' : network === 'tron' ? 'tron' : 'evm';
  if (!isValidAddress(tokenAddrKind, cfg[tokenField])) return `That does not look like a valid ${network === 'solana' ? 'mint' : 'contract'} address.`;
  return null;
}

function bankTransferCanEnable(cfg) {
  if (!cfg.bankName || !cfg.accountHolder || !cfg.accountNumber || !cfg.currency) {
    return 'Bank name, account holder, account number, and currency are all required.';
  }
  return null;
}

/*
 * Resolves which Flutterwave keys to actually use for a given mode. Live
 * mode accepts either the new FLW_LIVE_* names or the original
 * FLUTTERWAVE_SECRET_KEY/FLUTTERWAVE_PUBLIC_KEY this project already had in
 * production — so existing live traffic keeps working immediately after
 * this deploy, without forcing an env var rename before anything works.
 * Test mode has no such fallback: using the live key for what an admin
 * believes is test mode would put real money at risk under a false sense of
 * safety, so test mode simply refuses to run without its own dedicated keys.
 */
function resolveFlutterwaveKeys(mode, env = process.env) {
  if (mode === 'test') {
    if (!env.FLW_TEST_PUBLIC_KEY || !env.FLW_TEST_SECRET_KEY) return null;
    return { publicKey: env.FLW_TEST_PUBLIC_KEY, secretKey: env.FLW_TEST_SECRET_KEY };
  }
  if (env.FLW_LIVE_PUBLIC_KEY && env.FLW_LIVE_SECRET_KEY) {
    return { publicKey: env.FLW_LIVE_PUBLIC_KEY, secretKey: env.FLW_LIVE_SECRET_KEY };
  }
  if (env.FLUTTERWAVE_PUBLIC_KEY && env.FLUTTERWAVE_SECRET_KEY) {
    return { publicKey: env.FLUTTERWAVE_PUBLIC_KEY, secretKey: env.FLUTTERWAVE_SECRET_KEY };
  }
  return null;
}

function flutterwaveLiveCanEnable(env = process.env) {
  if (!resolveFlutterwaveKeys('live', env)) {
    return 'Live Flutterwave credentials are not set on the server (FLW_LIVE_SECRET_KEY/FLW_LIVE_PUBLIC_KEY, or the original FLUTTERWAVE_SECRET_KEY/FLUTTERWAVE_PUBLIC_KEY).';
  }
  return null;
}

function flutterwaveTestCanEnable(env = process.env) {
  if (!resolveFlutterwaveKeys('test', env)) {
    return 'Test Flutterwave credentials are not set on the server (FLW_TEST_SECRET_KEY/FLW_TEST_PUBLIC_KEY).';
  }
  return null;
}

module.exports = {
  SETTINGS_KEYS, USDC_NETWORKS, defaults, getMethodSettings, getAllMethodSettings,
  setMethodSettings, isValidAddress, bitcoinCanEnable, usdcNetworkCanEnable,
  bankTransferCanEnable, flutterwaveLiveCanEnable, flutterwaveTestCanEnable, resolveFlutterwaveKeys,
};
