'use strict';

/*
 * The browser's declared Content-Type / filename extension can be spoofed
 * trivially — this checks the actual leading bytes of the uploaded file
 * against the real magic numbers for the formats we accept, so a renamed
 * executable can't slip through as "receipt.jpg".
 */
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', check: b => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: 'image/png',  ext: 'png', check: b => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { mime: 'application/pdf', ext: 'pdf', check: b => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
];

// Returns { mime, ext } for a recognized, allowed format, or null if the
// bytes don't match any of JPG/PNG/PDF regardless of what the upload claims.
function sniffReceiptFile(buffer) {
  const match = SIGNATURES.find(sig => sig.check(buffer));
  return match ? { mime: match.mime, ext: match.ext } : null;
}

module.exports = { sniffReceiptFile };
