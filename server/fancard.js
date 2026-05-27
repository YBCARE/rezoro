'use strict';
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const https = require('https');
const path = require('path');

async function getWikiThumb(slug) {
  return new Promise((resolve) => {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
    https.get(url, { headers: { 'User-Agent': 'Rezoro/1.0 (rezoro.pro)' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(j.thumbnail?.source || null); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

/* ── Register Windows system fonts for elegant typography ── */
const FONTS_DIR = 'C:\\Windows\\Fonts';
const tryFont = (file, family) => {
  try { GlobalFonts.registerFromPath(path.join(FONTS_DIR, file), family); } catch {}
};
tryFont('georgia.ttf',  'Georgia');
tryFont('georgiai.ttf', 'Georgia');
tryFont('georgiab.ttf', 'Georgia');
tryFont('georgiaz.ttf', 'Georgia');
tryFont('arial.ttf',    'Arial');
tryFont('arialbd.ttf',  'Arial');

/* ── Card dimensions (credit-card aspect ratio 1.586:1) ─── */
const W = 920;
const H = 540;

/* ── Tier palette ─────────────────────────────────────── */
const PALETTE = {
  gold: {
    bg:      [['#0d0800',0], ['#1e1400',0.35], ['#2a1c00',0.5], ['#1e1400',0.65], ['#0d0800',1]],
    accent:  '#C9A84C',
    accentL: '#E4C870',
    glow:    'rgba(201,168,76,0.22)',
    border:  'rgba(201,168,76,0.55)',
    shimmer: 'rgba(228,200,112,0.12)',
    chip:    ['#C9A84C','#8a6b1e','#E4C870'],
    label:   'GOLD',
  },
  silver: {
    bg:      [['#080a0e',0], ['#101520',0.35], ['#181f2a',0.5], ['#101520',0.65], ['#080a0e',1]],
    accent:  '#A8B8C4',
    accentL: '#C8D8E4',
    glow:    'rgba(168,184,196,0.2)',
    border:  'rgba(168,184,196,0.45)',
    shimmer: 'rgba(200,216,228,0.1)',
    chip:    ['#A8B8C4','#6a7e8a','#C8D8E4'],
    label:   'SILVER',
  },
  bronze: {
    bg:      [['#0a0500',0], ['#1a0e04',0.35], ['#261408',0.5], ['#1a0e04',0.65], ['#0a0500',1]],
    accent:  '#C07848',
    accentL: '#D89060',
    glow:    'rgba(192,120,72,0.2)',
    border:  'rgba(192,120,72,0.45)',
    shimmer: 'rgba(216,144,96,0.1)',
    chip:    ['#C07848','#7a4c28','#D89060'],
    label:   'BRONZE',
  },
};

/* ── Helpers ──────────────────────────────────────────── */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y);
  ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r);
  ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h);
  ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}

async function drawCircularPhoto(ctx, src, cx, cy, r) {
  try {
    const img = await loadImage(src);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    // Cover-fit: scale to fill circle
    const scale = Math.max((r*2)/img.width, (r*2)/img.height);
    const sw = img.width  * scale;
    const sh = img.height * scale;
    ctx.drawImage(img, cx - sw/2, cy - sh/2, sw, sh);
    ctx.restore();
    return true;
  } catch {
    return false;
  }
}

function measureFit(ctx, text, maxWidth) {
  while (ctx.measureText(text).width > maxWidth && ctx.font.match(/\d+/)) {
    const size = parseInt(ctx.font.match(/(\d+)px/)[1]) - 1;
    ctx.font = ctx.font.replace(/\d+px/, `${size}px`);
  }
}

/* ══════════════════════════════════════════════════════════
   generateFanCard — returns a PNG Buffer
══════════════════════════════════════════════════════════ */
async function generateFanCard({
  fanName    = 'Fan Name',
  country    = '',
  celebName  = 'Celebrity',
  celebEmoji = '🎬',
  celebWiki  = null,
  tier       = 'gold',
  ref        = 'RZ-000000',
  photoSrc   = null,
}) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const P      = PALETTE[tier] || PALETTE.gold;

  // Fetch celebrity Wikipedia photo
  let celebPhotoUrl = null;
  if (celebWiki) {
    celebPhotoUrl = await getWikiThumb(celebWiki);
  }

  /* ── 1. Card background ───────────────────────────── */
  roundRect(ctx, 0, 0, W, H, 22);
  ctx.save();
  ctx.clip();

  // Base gradient
  const bgG = ctx.createLinearGradient(0, 0, W, H);
  P.bg.forEach(([col, stop]) => bgG.addColorStop(stop, col));
  ctx.fillStyle = bgG;
  ctx.fillRect(0, 0, W, H);

  // Diagonal shimmer streak
  const shG = ctx.createLinearGradient(0, H, W, 0);
  shG.addColorStop(0,    'transparent');
  shG.addColorStop(0.38, 'transparent');
  shG.addColorStop(0.48, P.shimmer);
  shG.addColorStop(0.52, P.shimmer);
  shG.addColorStop(0.62, 'transparent');
  shG.addColorStop(1,    'transparent');
  ctx.fillStyle = shG;
  ctx.fillRect(0, 0, W, H);

  // Radial glow — top-left quadrant
  const glowTL = ctx.createRadialGradient(60, 60, 0, 60, 60, 320);
  glowTL.addColorStop(0, P.glow);
  glowTL.addColorStop(1, 'transparent');
  ctx.fillStyle = glowTL;
  ctx.fillRect(0, 0, W, H);

  // Radial glow — bottom-right quadrant
  const glowBR = ctx.createRadialGradient(W-80, H-60, 0, W-80, H-60, 260);
  glowBR.addColorStop(0, P.glow);
  glowBR.addColorStop(1, 'transparent');
  ctx.fillStyle = glowBR;
  ctx.fillRect(0, 0, W, H);

  // Subtle horizontal scan lines (luxury texture)
  ctx.globalAlpha = 0.025;
  for (let y = 0; y < H; y += 3) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, 1);
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  /* ── 2. Border ────────────────────────────────────── */
  roundRect(ctx, 0.75, 0.75, W-1.5, H-1.5, 21.5);
  ctx.strokeStyle = P.border;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Inner subtle border glow
  roundRect(ctx, 3, 3, W-6, H-6, 19);
  ctx.strokeStyle = `${P.accent}18`;
  ctx.lineWidth   = 1;
  ctx.stroke();

  /* ── 3. REZORO logo — top left ────────────────────── */
  ctx.font      = 'bold 18px Arial';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#F0ECE4';
  ctx.letterSpacing = '4px';
  ctx.fillText('REZ', 36, 32);
  const rezW    = ctx.measureText('REZ').width + 4; // account for letter-spacing
  ctx.fillStyle = P.accent;
  ctx.fillText('ORO', 36 + rezW, 32);
  ctx.letterSpacing = '0px';

  // Tiny dot after logo
  ctx.beginPath();
  ctx.arc(36 + rezW + ctx.measureText('ORO').width + 10, 41, 2.5, 0, Math.PI*2);
  ctx.fillStyle = P.accent;
  ctx.fill();

  /* ── 4. Tier badge — top right ────────────────────── */
  const badgeLabel = P.label;
  ctx.font = 'bold 10px Arial';
  ctx.letterSpacing = '2px';
  const bTw = ctx.measureText(badgeLabel).width + 4; // account for letter-spacing
  const bPx = 16, bPy = 9;
  const bW  = bTw + bPx * 2;
  const bH  = 28;
  const bX  = W - bW - 34;
  const bY  = 26;

  // Badge background
  roundRect(ctx, bX, bY, bW, bH, 5);
  const badgeBg = ctx.createLinearGradient(bX, bY, bX+bW, bY+bH);
  badgeBg.addColorStop(0, `${P.accent}30`);
  badgeBg.addColorStop(1, `${P.accent}18`);
  ctx.fillStyle = badgeBg;
  ctx.fill();

  roundRect(ctx, bX, bY, bW, bH, 5);
  ctx.strokeStyle = P.border;
  ctx.lineWidth   = 1;
  ctx.stroke();

  // Badge text
  ctx.fillStyle    = P.accentL;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeLabel, bX + bW/2, bY + bH/2);
  ctx.letterSpacing = '0px';

  /* ── 5. Left panel — fan photo ────────────────────── */
  const photoX = 148;    // center x of photo
  const photoY = 236;    // center y of photo
  const photoR = 62;     // radius

  // Outer decorative ring
  const ringG = ctx.createLinearGradient(photoX-photoR-6, photoY-photoR-6, photoX+photoR+6, photoY+photoR+6);
  ringG.addColorStop(0, P.accentL);
  ringG.addColorStop(0.5, `${P.accent}60`);
  ringG.addColorStop(1, P.accentL);
  ctx.beginPath();
  ctx.arc(photoX, photoY, photoR+5, 0, Math.PI*2);
  ctx.strokeStyle = ringG;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Photo or placeholder
  const hasPhoto = photoSrc ? await drawCircularPhoto(ctx, photoSrc, photoX, photoY, photoR) : false;

  if (!hasPhoto) {
    // Elegant placeholder
    ctx.beginPath();
    ctx.arc(photoX, photoY, photoR, 0, Math.PI*2);
    const phG = ctx.createRadialGradient(photoX-10, photoY-10, 0, photoX, photoY, photoR);
    phG.addColorStop(0, `${P.accent}22`);
    phG.addColorStop(1, `${P.accent}08`);
    ctx.fillStyle = phG;
    ctx.fill();

    // Silhouette icon
    ctx.fillStyle    = `${P.accent}55`;
    ctx.font         = '44px Arial';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('◉', photoX, photoY);
  }

  /* ── 6. Fan name + country — below photo ─────────── */
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';

  // Fan name
  ctx.font      = 'bold 16px Georgia';
  ctx.fillStyle = '#F0ECE4';
  const maxNameW = 230;
  measureFit(ctx, fanName, maxNameW);
  ctx.fillText(fanName, photoX, photoY + photoR + 18);

  // Country
  if (country) {
    ctx.font      = '11px Arial';
    ctx.fillStyle = P.accent;
    ctx.letterSpacing = '1px';
    ctx.fillText(country.toUpperCase(), photoX, photoY + photoR + 42);
    ctx.letterSpacing = '0px';
  }

  /* ── 7. Vertical divider ──────────────────────────── */
  const divX = 290;
  const divGrad = ctx.createLinearGradient(divX, 70, divX, H-70);
  divGrad.addColorStop(0,   'transparent');
  divGrad.addColorStop(0.15, `${P.accent}40`);
  divGrad.addColorStop(0.85, `${P.accent}40`);
  divGrad.addColorStop(1,   'transparent');
  ctx.beginPath();
  ctx.moveTo(divX, 70);
  ctx.lineTo(divX, H-70);
  ctx.strokeStyle = divGrad;
  ctx.lineWidth   = 1;
  ctx.stroke();

  /* ── 8. Right panel — celebrity ───────────────────── */
  const rX   = 326;   // right panel left edge
  const rCx  = Math.round((rX + W - 44) / 2);  // center x of right panel ≈ 601

  // Micro label
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'top';
  ctx.font         = '10px Arial';
  ctx.fillStyle    = `${P.accent}80`;
  ctx.letterSpacing = '3px';
  ctx.fillText('CELEBRITY', rX, 108);
  ctx.letterSpacing = '0px';

  if (celebPhotoUrl) {
    /* ── Photo mode: circular celebrity headshot ── */
    const cpX = rCx, cpY = 230, cpR = 82;

    // Outer decorative ring
    const cRingG = ctx.createLinearGradient(cpX-cpR-6, cpY-cpR-6, cpX+cpR+6, cpY+cpR+6);
    cRingG.addColorStop(0, P.accentL);
    cRingG.addColorStop(0.5, `${P.accent}60`);
    cRingG.addColorStop(1, P.accentL);
    ctx.beginPath();
    ctx.arc(cpX, cpY, cpR + 5, 0, Math.PI * 2);
    ctx.strokeStyle = cRingG;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    const drewCelebPhoto = await drawCircularPhoto(ctx, celebPhotoUrl, cpX, cpY, cpR);
    if (!drewCelebPhoto) {
      ctx.font = '52px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(celebEmoji, rX, 128);
    }

    // Celebrity name centered below photo
    const celebMaxW = W - rX - 44;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.font         = 'bold 38px Georgia';
    ctx.fillStyle    = '#F0ECE4';
    if (ctx.measureText(celebName).width > celebMaxW) ctx.font = 'bold 30px Georgia';
    if (ctx.measureText(celebName).width > celebMaxW) ctx.font = 'bold 24px Georgia';
    const nameY = cpY + cpR + 16;
    ctx.fillText(celebName, rCx, nameY);

    // Accent underline (centered)
    const nameW2 = Math.min(ctx.measureText(celebName).width, celebMaxW);
    const lineY2 = nameY + parseInt(ctx.font) + 6;
    const lineG2 = ctx.createLinearGradient(rCx - nameW2/2, 0, rCx + nameW2/2, 0);
    lineG2.addColorStop(0, 'transparent');
    lineG2.addColorStop(0.3, P.accentL);
    lineG2.addColorStop(0.7, P.accent);
    lineG2.addColorStop(1, 'transparent');
    ctx.fillStyle = lineG2;
    ctx.fillRect(rCx - nameW2/2, lineY2, nameW2, 2);

  } else {
    /* ── Emoji mode: original layout ── */
    ctx.textAlign    = 'left';
    ctx.font         = '52px Arial';
    ctx.textBaseline = 'top';
    ctx.fillText(celebEmoji, rX, 128);

    const celebMaxW = W - rX - 44;
    ctx.textBaseline = 'top';
    ctx.font         = 'bold 42px Georgia';
    ctx.fillStyle    = '#F0ECE4';
    if (ctx.measureText(celebName).width > celebMaxW) ctx.font = 'bold 34px Georgia';
    if (ctx.measureText(celebName).width > celebMaxW) ctx.font = 'bold 28px Georgia';
    ctx.fillText(celebName, rX, 200);

    const nameW = Math.min(ctx.measureText(celebName).width, celebMaxW);
    const lineY = 200 + parseInt(ctx.font) + 8;
    const lineG = ctx.createLinearGradient(rX, 0, rX + nameW, 0);
    lineG.addColorStop(0, P.accentL);
    lineG.addColorStop(0.6, P.accent);
    lineG.addColorStop(1, 'transparent');
    ctx.fillStyle = lineG;
    ctx.fillRect(rX, lineY, nameW, 2);
  }

  /* ── 9. EMV-style chip (left panel, decorative) ───── */
  const chipX = 80, chipY = 128, chipW = 42, chipH = 32, chipR = 5;
  roundRect(ctx, chipX, chipY, chipW, chipH, chipR);
  const chipG = ctx.createLinearGradient(chipX, chipY, chipX+chipW, chipY+chipH);
  chipG.addColorStop(0,   P.chip[0]);
  chipG.addColorStop(0.45, P.chip[1]);
  chipG.addColorStop(1,   P.chip[2]);
  ctx.fillStyle = chipG;
  ctx.fill();

  // Chip detail lines
  ctx.strokeStyle = `${P.chip[1]}90`;
  ctx.lineWidth   = 0.8;
  [[chipX+12,chipY+2,chipX+12,chipY+chipH-2],[chipX+chipW-12,chipY+2,chipX+chipW-12,chipY+chipH-2]].forEach(([x1,y1,x2,y2])=>{
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  });
  ctx.beginPath(); ctx.moveTo(chipX+2,chipY+chipH/2); ctx.lineTo(chipX+chipW-2,chipY+chipH/2); ctx.stroke();

  /* ── 10. Bottom section — reference + divider ─────── */
  const bottomY = 398;

  // Horizontal rule
  const hrG = ctx.createLinearGradient(rX, 0, W-40, 0);
  hrG.addColorStop(0, `${P.accent}50`);
  hrG.addColorStop(1, 'transparent');
  ctx.fillStyle = hrG;
  ctx.fillRect(rX, bottomY, W - rX - 40, 1);

  // "BOOKING REFERENCE" label
  ctx.font         = '10px Arial';
  ctx.fillStyle    = `${P.accent}70`;
  ctx.letterSpacing = '2.5px';
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  ctx.fillText('BOOKING REFERENCE', rX, bottomY + 14);
  ctx.letterSpacing = '0px';

  // Reference number (monospace feel)
  ctx.font      = 'bold 20px Arial';
  ctx.fillStyle = P.accentL;
  ctx.letterSpacing = '1px';
  ctx.fillText(ref, rX, bottomY + 32);
  ctx.letterSpacing = '0px';

  // Left side: horizontal rule above ref on left panel
  const lHrG = ctx.createLinearGradient(36, 0, divX-20, 0);
  lHrG.addColorStop(0, `${P.accent}50`);
  lHrG.addColorStop(1, 'transparent');
  ctx.fillStyle = lHrG;
  ctx.fillRect(36, bottomY, divX - 56, 1);

  /* ── 11. Bottom footer bar ────────────────────────── */
  const footY = H - 46;

  // Subtle separator
  const footSep = ctx.createLinearGradient(36, 0, W-36, 0);
  footSep.addColorStop(0,   'transparent');
  footSep.addColorStop(0.1,  `${P.accent}25`);
  footSep.addColorStop(0.9,  `${P.accent}25`);
  footSep.addColorStop(1,   'transparent');
  ctx.fillStyle = footSep;
  ctx.fillRect(36, footY, W-72, 1);

  // Footer text
  ctx.font         = '10px Arial';
  ctx.fillStyle    = `${P.accent}55`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '2px';
  ctx.fillText('REZORO  ·  PREMIUM CELEBRITY EXPERIENCES  ·  REZORO.PRO', W/2, footY + 23);
  ctx.letterSpacing = '0px';

  /* ── 12. Corner accent dots ───────────────────────── */
  [[34, 34], [W-34, 34], [34, H-34], [W-34, H-34]].forEach(([x,y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI*2);
    ctx.fillStyle = `${P.accent}45`;
    ctx.fill();
  });

  return canvas.toBuffer('image/png');
}

module.exports = { generateFanCard };
