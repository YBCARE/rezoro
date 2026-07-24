'use strict';
/*
 * Print-ready Certificate of Authenticity.
 *
 * Landscape 7" x 5" at 300 DPI with 1/8" bleed. Pairs with a fan card —
 * same collector, celebrity, tier, serial, and edition number. Ivory
 * stock, tier-foil ornament, a wax-seal emblem, and a guilloché rosette
 * for a genuine security-print feel. Returns a PNG Buffer.
 */
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

const FONTS_DIR = 'C:\\Windows\\Fonts';
const tryFont = (file, family) => { try { GlobalFonts.registerFromPath(path.join(FONTS_DIR, file), family); } catch {} };
tryFont('georgia.ttf', 'Georgia'); tryFont('georgiai.ttf', 'Georgia');
tryFont('georgiab.ttf', 'Georgia'); tryFont('georgiaz.ttf', 'Georgia');
tryFont('arial.ttf', 'Arial'); tryFont('arialbd.ttf', 'Arial');
tryFont('gabriola.ttf', 'Gabriola');   // elegant script for the signature
tryFont('segoesc.ttf', 'Segoe Script');

const BLEED = 38;
const CW = 2100, CH = 1500;
const W = CW + BLEED * 2, H = CH + BLEED * 2;
const TRIM = { x: BLEED, y: BLEED, w: CW, h: CH };

const FOIL = {
  gold:   ['#8A6B1E', '#EBD488', '#C9A84C', '#F4E3A6', '#8A6B1E'],
  silver: ['#6A7E8A', '#DCE7EF', '#A8B8C4', '#EEF5FA', '#6A7E8A'],
  bronze: ['#7A4C28', '#E6A578', '#C07848', '#F0BB94', '#7A4C28'],
};
const ACCENT = { gold: '#9A7B24', silver: '#5F7480', bronze: '#8A5330' };
const LABEL  = { gold: 'GOLD', silver: 'SILVER', bronze: 'BRONZE' };

const PAPER = '#F7F2E6';
const INK   = '#241B0C';
const INKMUTE = '#6E6046';

function foil(ctx, x, y, w, h, tier) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  const s = FOIL[tier] || FOIL.gold;
  g.addColorStop(0, s[0]); g.addColorStop(0.28, s[1]); g.addColorStop(0.5, s[2]);
  g.addColorStop(0.72, s[3]); g.addColorStop(1, s[4]);
  return g;
}

// Curved text centered on `centerAngle`, spanning `spread` radians.
// bottom=true flips glyphs so the lower arc still reads left-to-right.
function arcText(ctx, text, cx, cy, radius, centerAngle, spread, bottom, font, fill) {
  ctx.save();
  ctx.font = font; ctx.fillStyle = fill;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const chars = [...text];
  const step = spread / chars.length;
  chars.forEach((ch, i) => {
    const a = bottom
      ? centerAngle + spread / 2 - step * (i + 0.5)
      : centerAngle - spread / 2 + step * (i + 0.5);
    ctx.save();
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.rotate(bottom ? a - Math.PI / 2 : a + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

// Guilloché rosette (rose curve family) — subtle security-print texture.
function rosette(ctx, cx, cy, R, petals, turns, stroke, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 0.8;
  for (let t = 0; t < turns; t++) {
    const rot = (Math.PI / turns) * t;
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.01) {
      const r = R * Math.cos(petals * a);
      const x = cx + Math.cos(a + rot) * r;
      const y = cy + Math.sin(a + rot) * r;
      a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function seal(ctx, cx, cy, R, tier) {
  // outer foil ring
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 6; ctx.strokeStyle = foil(ctx, cx - R, cy - R, R * 2, R * 2, tier); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R - 12, 0, Math.PI * 2);
  ctx.lineWidth = 2; ctx.strokeStyle = foil(ctx, cx - R, cy - R, R * 2, R * 2, tier); ctx.stroke();
  // radiating ticks
  ctx.save(); ctx.strokeStyle = foil(ctx, cx - R, cy - R, R * 2, R * 2, tier); ctx.lineWidth = 2;
  for (let i = 0; i < 72; i++) {
    const a = (Math.PI * 2 / 72) * i;
    const r1 = R - 20, r2 = R - 30;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.stroke();
  }
  ctx.restore();
  // rosette inside
  rosette(ctx, cx, cy, R - 50, 7, 5, ACCENT[tier], 0.22);
  // curved text — top arc reads normally, bottom arc flipped
  arcText(ctx, 'CERTIFIED · AUTHENTIC', cx, cy, R - 30, -Math.PI / 2, Math.PI * 0.92, false, 'bold 21px Arial', ACCENT[tier]);
  arcText(ctx, 'REZORO · LIMITED EDITION', cx, cy, R - 30, Math.PI / 2, Math.PI * 0.92, true, 'bold 19px Arial', ACCENT[tier]);
  // center monogram
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 88px Georgia';
  ctx.fillStyle = foil(ctx, cx - 60, cy - 60, 120, 120, tier);
  ctx.fillText('R', cx, cy - 14);
  ctx.font = 'bold 22px Arial'; ctx.letterSpacing = '4px';
  ctx.fillStyle = ACCENT[tier];
  ctx.fillText(LABEL[tier] || 'GOLD', cx, cy + 44);
  ctx.letterSpacing = '0px';
}

function fitFont(ctx, text, maxW, startPx, family, weight, minPx) {
  let px = startPx; ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxW && px > minPx) { px -= 2; ctx.font = `${weight} ${px}px ${family}`; }
  return px;
}

function generateCertificate({
  fanName   = 'Collector',
  celebName = 'Celebrity',
  tier      = 'gold',
  ref       = 'RZ-000000',
  edition   = null,
  issued    = null,       // Date or ISO string
} = {}) {
  const t = FOIL[tier] ? tier : 'gold';
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const cxc = W / 2;

  /* Paper with edge vignette */
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  const vig = ctx.createRadialGradient(cxc, H / 2, H * 0.2, cxc, H / 2, W * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(120,96,48,0.10)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);

  /* Faint full-page guilloché */
  rosette(ctx, cxc, H / 2, 560, 11, 6, ACCENT[t], 0.05);

  /* Ornamental double border */
  const m = 66;
  ctx.strokeStyle = foil(ctx, TRIM.x, TRIM.y, TRIM.w, TRIM.h, t);
  ctx.lineWidth = 5; ctx.strokeRect(TRIM.x + m, TRIM.y + m, TRIM.w - m * 2, TRIM.h - m * 2);
  ctx.lineWidth = 1.5; ctx.strokeRect(TRIM.x + m + 12, TRIM.y + m + 12, TRIM.w - m * 2 - 24, TRIM.h - m * 2 - 24);
  // corner diamonds
  [[TRIM.x + m, TRIM.y + m], [TRIM.x + TRIM.w - m, TRIM.y + m], [TRIM.x + m, TRIM.y + TRIM.h - m], [TRIM.x + TRIM.w - m, TRIM.y + TRIM.h - m]]
    .forEach(([x, y]) => { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillStyle = foil(ctx, -9, -9, 18, 18, t); ctx.fillRect(-9, -9, 18, 18); ctx.restore(); });

  /* Header */
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 40px Georgia'; ctx.letterSpacing = '8px';
  ctx.fillStyle = INK;
  ctx.fillText('REZ', cxc - 34, TRIM.y + 195);
  const rw = ctx.measureText('REZ').width;
  ctx.fillStyle = ACCENT[t];
  ctx.fillText('ORO', cxc - 34 + rw + 8, TRIM.y + 195);
  ctx.letterSpacing = '0px';

  ctx.font = 'bold 76px Georgia';
  ctx.fillStyle = INK;
  ctx.fillText('Certificate of Authenticity', cxc, TRIM.y + 300);

  ctx.font = 'bold 22px Arial'; ctx.letterSpacing = '6px';
  ctx.fillStyle = ACCENT[t];
  ctx.fillText('REZORO  LIMITED  EDITION  COLLECTIBLE', cxc, TRIM.y + 348);
  ctx.letterSpacing = '0px';

  // short foil rule
  const rl = 150;
  ctx.fillStyle = foil(ctx, cxc - rl, 0, rl * 2, 3, t);
  ctx.fillRect(cxc - rl, TRIM.y + 382, rl * 2, 3);

  /* Body statement */
  ctx.font = 'italic 30px Georgia'; ctx.fillStyle = INKMUTE;
  ctx.fillText('This certifies that the collectible described below is a genuine,', cxc, TRIM.y + 452);
  ctx.fillText('individually numbered Rezoro limited-edition fan card.', cxc, TRIM.y + 494);

  /* Details grid (two columns) */
  const rows = [
    ['COLLECTOR', fanName],
    ['CELEBRITY', celebName],
    ['TIER', (LABEL[t] || 'GOLD')],
    ['EDITION', edition ? edition : 'Limited Edition'],
    ['REFERENCE', `#${ref}`],
    ['ISSUED', fmtDate(issued)],
  ];
  const gx = TRIM.x + 220, gw = TRIM.w - 440;
  const colW = gw / 2, startY = TRIM.y + 590, rowH = 92;
  rows.forEach((r, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = gx + col * colW, y = startY + row * rowH;
    ctx.textAlign = 'left';
    ctx.font = 'bold 18px Arial'; ctx.letterSpacing = '3px';
    ctx.fillStyle = ACCENT[t];
    ctx.fillText(r[0], x, y);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = INK;
    const vpx = fitFont(ctx, String(r[1]), colW - 60, 38, 'Georgia', 'bold', 22);
    ctx.font = `bold ${vpx}px Georgia`;
    ctx.fillText(String(r[1]), x, y + 42);
    ctx.strokeStyle = 'rgba(110,96,70,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + 60); ctx.lineTo(x + colW - 40, y + 60); ctx.stroke();
  });

  /* Seal (bottom-left) */
  seal(ctx, TRIM.x + 320, TRIM.y + TRIM.h - 250, 158, t);

  /* Signature (bottom-right) */
  const sigX2 = TRIM.x + TRIM.w - 200, sigX1 = sigX2 - 420;
  const sigY = TRIM.y + TRIM.h - 210;
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = '92px Gabriola';
  ctx.fillText('Rezoro', (sigX1 + sigX2) / 2, sigY);
  ctx.strokeStyle = INKMUTE; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(sigX1, sigY + 18); ctx.lineTo(sigX2, sigY + 18); ctx.stroke();
  ctx.font = 'bold 18px Arial'; ctx.letterSpacing = '3px'; ctx.fillStyle = INKMUTE;
  ctx.fillText('AUTHORISED  ·  REZORO', (sigX1 + sigX2) / 2, sigY + 48);
  ctx.letterSpacing = '0px';

  /* Footer microtext */
  ctx.font = 'bold 16px Arial'; ctx.letterSpacing = '3px'; ctx.fillStyle = `${ACCENT[t]}`;
  ctx.fillText('VERIFY AT REZORO.PRO  ·  THIS CERTIFICATE ACCOMPANIES ONE NUMBERED REZORO COLLECTIBLE', cxc, TRIM.y + TRIM.h - 48);
  ctx.letterSpacing = '0px';

  return canvas.toBuffer('image/png');
}

function fmtDate(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

module.exports = { generateCertificate };
