'use strict';

// Minimal Base58 (Bitcoin/TRON alphabet) decoder — enough to turn a TRON
// T-address into its 41-prefixed hex form for comparing against TronGrid's
// hex-formatted addresses. No external dependency needed for this.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  let num = 0n;
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = hex === '00' ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let leadingZeros = 0;
  for (const char of str) { if (char === '1') leadingZeros++; else break; }
  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

// Returns lowercase hex ("41...", 42 chars) or null if not a well-formed
// TRON base58 address (25 bytes: 1-byte prefix + 20-byte address + 4-byte checksum).
function tronBase58ToHex(address) {
  try {
    const decoded = base58Decode(address);
    if (decoded.length !== 25) return null;
    return decoded.subarray(0, 21).toString('hex').toLowerCase();
  } catch {
    return null;
  }
}

module.exports = { tronBase58ToHex };
