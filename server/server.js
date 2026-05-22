'use strict';
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const { generateFanCard }   = require('./fancard');
const { sendFanCardEmail }  = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── Middleware ─────────────────────────────────────────── */
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the static HTML site from the parent directory
app.use(express.static(path.join(__dirname, '..'), { acceptRanges: true }));

// Explicit route for hero.mp4 — ensures video streaming works on all hosts
app.get('/hero.mp4', (req, res) => {
  const fs       = require('fs');
  const filePath = path.join(__dirname, '..', 'hero.mp4');
  const stat     = fs.statSync(filePath);
  const total    = stat.size;
  const range    = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : total - 1;
    const chunk = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   'video/mp4',
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   'video/mp4',
      'Accept-Ranges':  'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Photo uploads held in memory (max 5 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

/* ── Reference generator ────────────────────────────────── */
function makeRef() {
  const date  = new Date();
  const yy    = String(date.getFullYear()).slice(-2);
  const mm    = String(date.getMonth() + 1).padStart(2, '0');
  const dd    = String(date.getDate()).padStart(2, '0');
  const short = uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `RZ-${yy}${mm}${dd}-${short}`;
}

/* ── Health check ───────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Rezoro Backend', version: '1.0.0' });
});

/* ── Debug: show what files are visible to the server ───── */
app.get('/api/debug-files', (_req, res) => {
  const fs   = require('fs');
  const root = path.join(__dirname, '..');
  try {
    const files     = fs.readdirSync(root).slice(0, 40);
    const heroPath  = path.join(root, 'hero.mp4');
    const heroExists = fs.existsSync(heroPath);
    const heroSize  = heroExists ? fs.statSync(heroPath).size : null;
    res.json({ root, heroExists, heroSize, files });
  } catch (e) {
    res.json({ error: e.message, root });
  }
});

/* ── Shared handler for booking & fancard ───────────────── */
async function handleBooking(req, res) {
  try {
    const { fanName, country, celebName, celebEmoji, tier, email } = req.body;

    if (!fanName || !celebName || !email) {
      return res.status(400).json({ error: 'fanName, celebName and email are required.' });
    }

    const ref       = makeRef();
    const photoSrc  = req.file ? req.file.buffer : null;
    const tierClean = ['gold','silver','bronze'].includes(tier) ? tier : 'gold';

    console.log(`[${new Date().toISOString()}] Booking  ${ref}  ${celebName}  for ${fanName}  (${email})`);

    const cardBuffer = await generateFanCard({
      fanName,
      country:    country || '',
      celebName,
      celebEmoji: celebEmoji || '🎬',
      tier:       tierClean,
      ref,
      photoSrc
    });

    await sendFanCardEmail({ to: email, fanName, country: country||'', celebName, tier: tierClean, ref, cardBuffer });

    console.log(`[${new Date().toISOString()}] Email sent → ${email}`);

    res.json({ success: true, ref, message: `Fan card sent to ${email}` });

  } catch (err) {
    console.error('[booking] Error:', err.message);
    res.status(500).json({ error: 'Failed to process booking.', detail: err.message });
  }
}

/* ══════════════════════════════════════════════════════════
   POST /api/booking  &  POST /api/fancard  (same logic)
═══════════════════════════════════════════════════════════ */
app.post('/api/booking', upload.single('photo'), handleBooking);
app.post('/api/fancard', upload.single('photo'), handleBooking);

/* ══════════════════════════════════════════════════════════
   POST /api/preview-card
   Returns the fan card PNG directly (no email).
   Useful for showing a preview before purchase.
═══════════════════════════════════════════════════════════ */
app.post('/api/preview-card', upload.single('photo'), async (req, res) => {
  try {
    const { fanName, country, celebName, celebEmoji, tier } = req.body;
    const ref      = makeRef();
    const photoSrc = req.file ? req.file.buffer : null;
    const tierClean = ['gold','silver','bronze'].includes(tier) ? tier : 'gold';

    const cardBuffer = await generateFanCard({
      fanName:    fanName    || 'Preview Fan',
      country:    country    || '',
      celebName:  celebName  || 'Celebrity',
      celebEmoji: celebEmoji || '🎬',
      tier:       tierClean,
      ref,
      photoSrc
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(cardBuffer);

  } catch (err) {
    console.error('[/api/preview-card] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate preview.', detail: err.message });
  }
});

/* ── Start ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   R E Z O R O   B A C K E N D        ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  API     →  http://localhost:${PORT}/api ║`);
  console.log(`  ║  Site    →  http://localhost:${PORT}     ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
