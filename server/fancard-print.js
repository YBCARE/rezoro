'use strict';
/*
 * Print-ready collectible fan card.
 *
 * Portrait trading-card format (2.5" x 3.5") at 300 DPI with 1/8" bleed —
 * the spec custom card printers accept. Returns a PNG Buffer.
 *
 *   Trim size : 750 x 1050 px  (2.5" x 3.5" @ 300dpi)
 *   Bleed     : 38 px each edge
 *   Canvas    : 826 x 1126 px
 *   Safe area : keep key content ~38px inside the trim line
 */
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const https = require('https');
const path = require('path');

/* ── Fonts (Windows local; server falls back gracefully) ── */
const FONTS_DIR = 'C:\\Windows\\Fonts';
const tryFont = (file, family) => { try { GlobalFonts.registerFromPath(path.join(FONTS_DIR, file), family); } catch {} };
tryFont('georgia.ttf', 'Georgia'); tryFont('georgiai.ttf', 'Georgia');
tryFont('georgiab.ttf', 'Georgia'); tryFont('georgiaz.ttf', 'Georgia');
tryFont('arial.ttf', 'Arial');      tryFont('arialbd.ttf', 'Arial');

/* ── Wikipedia image (prefer full-resolution original for print) ── */
function getWikiImages(slug) {
  return new Promise((resolve) => {
    if (!slug) return resolve({ original: null, thumb: null });
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
    https.get(url, { headers: { 'User-Agent': 'Rezoro/1.0 (rezoro.pro)' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ original: j.originalimage?.source || null, thumb: j.thumbnail?.source || null });
        } catch { resolve({ original: null, thumb: null }); }
      });
    }).on('error', () => resolve({ original: null, thumb: null }));
  });
}

/* ── Geometry ── */
const BLEED = 38;
const CARD_W = 750, CARD_H = 1050;
const W = CARD_W + BLEED * 2;   // 826
const H = CARD_H + BLEED * 2;   // 1126
const TRIM = { x: BLEED, y: BLEED, w: CARD_W, h: CARD_H };

/* ── Tier palettes ── */
const PALETTE = {
  gold: {
    label: 'GOLD',
    bgTop: '#1c1305', bgMid: '#0c0900', bgBot: '#060400',
    accent: '#C9A84C', accentL: '#EBD488', accentD: '#8A6B1E',
    foil: ['#8A6B1E', '#EBD488', '#C9A84C', '#F4E3A6', '#8A6B1E'],
  },
  silver: {
    label: 'SILVER',
    bgTop: '#161b22', bgMid: '#0a0d12', bgBot: '#05070a',
    accent: '#A8B8C4', accentL: '#DCE7EF', accentD: '#6A7E8A',
    foil: ['#6A7E8A', '#DCE7EF', '#A8B8C4', '#EEF5FA', '#6A7E8A'],
  },
  bronze: {
    label: 'BRONZE',
    bgTop: '#23140a', bgMid: '#120a04', bgBot: '#080402',
    accent: '#C07848', accentL: '#E6A578', accentD: '#7A4C28',
    foil: ['#7A4C28', '#E6A578', '#C07848', '#F0BB94', '#7A4C28'],
  },
};

/* ── Helpers ── */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function foilGradient(ctx, x, y, w, h, P) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  const s = P.foil;
  g.addColorStop(0, s[0]); g.addColorStop(0.28, s[1]); g.addColorStop(0.5, s[2]);
  g.addColorStop(0.72, s[3]); g.addColorStop(1, s[4]);
  return g;
}

async function drawCover(ctx, img, x, y, w, h, focusY = 0.42) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = img.width * scale, sh = img.height * scale;
  const dx = x + (w - sw) / 2;
  const dy = y + (h - sh) * focusY;
  ctx.save();
  roundRect(ctx, x, y, w, h, 0);
  ctx.clip();
  ctx.drawImage(img, dx, dy, sw, sh);
  ctx.restore();
}

function fitFont(ctx, text, maxW, startPx, family, weight = 'bold', minPx = 20) {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxW && px > minPx) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

/* ══════════════════════════════════════════════════════════
   generatePrintCard — returns a print-ready PNG Buffer
══════════════════════════════════════════════════════════ */
async function generatePrintCard({
  fanName   = 'Collector',
  country   = '',
  celebName = 'Celebrity',
  celebWiki = null,
  tier      = 'gold',
  ref       = 'RZ-000000',
  edition   = null,        // e.g. "017 / 500"
  photoSrc  = null,        // optional fan photo (Buffer)
  celebImageSrc = null,    // pre-fetched celebrity image (Buffer/path); skips Wikipedia fetch
} = {}) {
  const P = PALETTE[tier] || PALETTE.gold;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  /* 1 ─ Full-bleed background */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, P.bgTop); bg.addColorStop(0.55, P.bgMid); bg.addColorStop(1, P.bgBot);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* 2 ─ Celebrity photo panel (hero, upper ~62%) */
  const photoH = Math.round(CARD_H * 0.62);
  const px = 0, py = 0, pw = W, ph = BLEED + photoH; // bleed to top & sides
  let celebImg = null;
  if (celebImageSrc) {
    try { celebImg = await loadImage(celebImageSrc); } catch {}
  }
  if (!celebImg && celebWiki) {
    const imgs = await getWikiImages(celebWiki);
    const url = imgs.original || imgs.thumb;
    if (url) { try { celebImg = await loadImage(url); } catch {} }
  }
  if (celebImg) {
    await drawCover(ctx, celebImg, px, py, pw, ph, 0.38);
  } else {
    // Monogram fallback
    ctx.fillStyle = P.bgTop;
    ctx.fillRect(px, py, pw, ph);
    const initials = celebName.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    ctx.fillStyle = `${P.accent}55`;
    ctx.font = `bold 200px Georgia`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials, W / 2, ph / 2);
  }

  /* 3 ─ Fade photo into the card body */
  const fade = ctx.createLinearGradient(0, ph - 260, 0, ph + 40);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.7, hexA(P.bgMid, 0.65));
  fade.addColorStop(1, P.bgMid);
  ctx.fillStyle = fade;
  ctx.fillRect(0, ph - 260, W, 300);
  // gentle top vignette for logo legibility
  const tv = ctx.createLinearGradient(0, 0, 0, 200);
  tv.addColorStop(0, 'rgba(0,0,0,0.55)'); tv.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = tv; ctx.fillRect(0, 0, W, 200);

  /* 4 ─ REZORO wordmark (top-left, inside safe area) */
  const safeL = TRIM.x + 40;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 34px Georgia';
  ctx.letterSpacing = '3px';
  ctx.fillStyle = '#F4F1EA';
  ctx.fillText('REZ', safeL, TRIM.y + 68);
  const rezW = ctx.measureText('REZ').width;
  ctx.fillStyle = P.accent;
  ctx.fillText('ORO', safeL + rezW + 3, TRIM.y + 68);
  ctx.letterSpacing = '0px';

  /* 5 ─ Tier badge (top-right, foil) */
  ctx.font = 'bold 22px Arial';
  ctx.letterSpacing = '3px';
  const badgeText = P.label;
  const bTextW = ctx.measureText(badgeText).width;
  const bW = bTextW + 44, bH = 46;
  const bX = TRIM.x + TRIM.w - 40 - bW, bY = TRIM.y + 28;
  roundRect(ctx, bX, bY, bW, bH, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
  roundRect(ctx, bX, bY, bW, bH, 4);
  ctx.lineWidth = 2; ctx.strokeStyle = foilGradient(ctx, bX, bY, bW, bH, P); ctx.stroke();
  ctx.fillStyle = foilGradient(ctx, bX, bY, bW, bH, P);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, bX + bW / 2, bY + bH / 2 + 1);
  ctx.letterSpacing = '0px';

  /* 6 ─ Text block below the photo */
  let cy = ph + 24;
  const cx = TRIM.x + 40;
  const contentW = TRIM.w - 80;

  // Celebrity name (large serif, accent)
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const namePx = fitFont(ctx, celebName, contentW, 66, 'Georgia', 'bold', 34);
  ctx.fillStyle = P.accentL;
  cy += namePx;
  ctx.fillText(celebName, cx, cy);

  // Foil underline
  const nameW = Math.min(ctx.measureText(celebName).width, contentW);
  cy += 20;
  ctx.fillStyle = foilGradient(ctx, cx, cy, nameW, 6, P);
  ctx.fillRect(cx, cy, nameW, 3);

  /* 7 ─ Divider + collector block (bottom, inside safe area) */
  const footY = TRIM.y + TRIM.h - 40;

  // COLLECTOR label + name
  ctx.textAlign = 'left';
  ctx.font = 'bold 17px Arial';
  ctx.letterSpacing = '4px';
  ctx.fillStyle = `${P.accent}`;
  ctx.fillText('COLLECTOR', cx, footY - 132);
  ctx.letterSpacing = '0px';

  const collPx = fitFont(ctx, fanName, contentW - 150, 44, 'Georgia', 'italic', 24);
  ctx.font = `italic ${collPx}px Georgia`;
  ctx.fillStyle = '#F4F1EA';
  ctx.fillText(fanName, cx, footY - 92);

  if (country) {
    ctx.font = 'bold 16px Arial';
    ctx.letterSpacing = '2px';
    ctx.fillStyle = `${P.accent}AA`;
    ctx.fillText(country.toUpperCase(), cx, footY - 64);
    ctx.letterSpacing = '0px';
  }

  // Optional fan photo inset (bottom-right, framed)
  if (photoSrc) {
    try {
      const fimg = await loadImage(photoSrc);
      const r = 52, fcx = TRIM.x + TRIM.w - 40 - r, fcy = footY - 108;
      ctx.save();
      ctx.beginPath(); ctx.arc(fcx, fcy, r, 0, Math.PI * 2); ctx.clip();
      const sc = Math.max((r * 2) / fimg.width, (r * 2) / fimg.height);
      ctx.drawImage(fimg, fcx - fimg.width * sc / 2, fcy - fimg.height * sc / 2, fimg.width * sc, fimg.height * sc);
      ctx.restore();
      ctx.beginPath(); ctx.arc(fcx, fcy, r + 2, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = foilGradient(ctx, fcx - r, fcy - r, r * 2, r * 2, P); ctx.stroke();
    } catch {}
  }

  // Thin foil divider
  const divY = footY - 44;
  ctx.fillStyle = foilGradient(ctx, cx, divY, contentW, 2, P);
  ctx.globalAlpha = 0.6; ctx.fillRect(cx, divY, contentW, 1.5); ctx.globalAlpha = 1;

  // Serial + edition
  ctx.font = 'bold 22px Arial';
  ctx.letterSpacing = '2px';
  ctx.fillStyle = P.accentL;
  ctx.fillText(`#${ref}`, cx, footY - 12);
  ctx.letterSpacing = '0px';

  ctx.textAlign = 'right';
  ctx.font = 'bold 16px Arial';
  ctx.letterSpacing = '2px';
  ctx.fillStyle = `${P.accent}`;
  ctx.fillText(edition ? `EDITION ${edition}` : 'LIMITED EDITION', TRIM.x + TRIM.w - 40, footY - 14);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  /* 8 ─ Metallic frame just inside the trim (the collectible border) */
  const fr = TRIM.x + 16;
  roundRect(ctx, fr, TRIM.y + 16, TRIM.w - 32, TRIM.h - 32, 10);
  ctx.lineWidth = 3;
  ctx.strokeStyle = foilGradient(ctx, fr, TRIM.y + 16, TRIM.w - 32, TRIM.h - 32, P);
  ctx.stroke();

  /* 9 ─ Authenticity microtext along the bottom edge */
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px Arial';
  ctx.letterSpacing = '3px';
  ctx.fillStyle = `${P.accent}88`;
  ctx.fillText('CERTIFICATE OF AUTHENTICITY  ·  REZORO LIMITED EDITION  ·  REZORO.PRO', W / 2, TRIM.y + TRIM.h - 4);
  ctx.letterSpacing = '0px';

  return canvas.toBuffer('image/png');
}

// #rrggbb + alpha → rgba()
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

module.exports = { generatePrintCard };
