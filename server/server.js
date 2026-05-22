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

const ROOT = path.join(__dirname, '..');

// ── Admin auth (server-side session tokens) ──────────────
const ADMIN_PASS   = 'Rezoro2025!';
const adminSessions = new Set();

function adminLoginPage(err) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rezoro — Admin Login</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant:wght@600&family=Montserrat:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:'Montserrat',sans-serif}
.card{width:100%;max-width:420px;background:#07070A;border:1px solid rgba(201,168,76,.22);border-radius:16px;padding:2.5rem 2rem;text-align:center}
.logo{font-family:'Cormorant',serif;font-size:2.2rem;font-weight:600;letter-spacing:.08em;color:#fff;margin-bottom:.2rem}
.logo span{color:#C9A84C}
.sub{font-size:.7rem;font-weight:500;letter-spacing:.25em;color:rgba(255,255,255,.35);text-transform:uppercase;margin-bottom:2rem}
label{display:block;font-size:.7rem;font-weight:600;letter-spacing:.18em;color:rgba(201,168,76,.7);text-transform:uppercase;text-align:left;margin-bottom:.5rem}
input{width:100%;padding:.9rem 1rem;background:#0E0E13;border:1px solid rgba(201,168,76,.2);border-radius:8px;color:#fff;font-family:'Montserrat',sans-serif;font-size:1rem;outline:none;-webkit-appearance:none}
input:focus{border-color:rgba(201,168,76,.55)}
button{width:100%;margin-top:1.2rem;padding:1rem;background:#C9A84C;color:#000;border:none;border-radius:8px;cursor:pointer;font-family:'Montserrat',sans-serif;font-size:.82rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;-webkit-appearance:none;touch-action:manipulation}
button:active{opacity:.8}
.err{margin-top:.75rem;font-size:.78rem;color:#e05555;min-height:1.1em}
</style></head><body>
<div class="card">
  <div class="logo">Rez<span>oro</span></div>
  <div class="sub">Admin Portal</div>
  <form method="POST" action="/admin-auth">
    <label>Password</label>
    <input type="password" name="pass" placeholder="Enter admin password"
           autocomplete="current-password" autocorrect="off" autocapitalize="off" autofocus>
    <button type="submit">Access Dashboard</button>
    <div class="err">${err || ''}</div>
  </form>
</div></body></html>`;
}

// GET /admin.html — check session cookie, show login or dashboard
app.get('/admin.html', (req, res) => {
  const token = (req.headers.cookie || '').match(/rz_admin=([^;]+)/)?.[1];
  if (token && adminSessions.has(token)) {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(ROOT, 'admin.html'));
  }
  res.set('Cache-Control', 'no-store');
  res.send(adminLoginPage());
});

// POST /admin-auth — validate password, set cookie
app.post('/admin-auth', (req, res) => {
  const pass = (req.body && req.body.pass) || '';
  if (pass === ADMIN_PASS) {
    const token = uuidv4();
    adminSessions.add(token);
    res.set('Set-Cookie', `rz_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.redirect(302, '/admin.html');
  } else {
    res.set('Cache-Control', 'no-store');
    res.send(adminLoginPage('Incorrect password. Try again.'));
  }
});

// Serve HTML files with no-cache to prevent CDN caching
['/index.html', '/fans.html', '/'].forEach(route => {
  const file = route === '/' ? 'index.html' : route.slice(1);
  app.get(route, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(ROOT, file));
  });
});

// Serve all other static assets
app.use(express.static(ROOT, { acceptRanges: true }));

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
  res.json({ status: 'ok', service: 'Rezoro Backend', version: '1.0.2' });
});

/* ── Debug: check admin.html content on disk ────────────── */
app.get('/api/debug-admin', (_req, res) => {
  const fs = require('fs');
  const p  = path.join(__dirname, '..', 'admin.html');
  try {
    const content = fs.readFileSync(p, 'utf8');
    const hasGate = content.includes('admin-gate');
    const size    = content.length;
    const snippet = content.slice(content.indexOf('</style>') - 200, content.indexOf('</style>') + 50);
    res.json({ hasGate, size, snippet });
  } catch(e) { res.json({ error: e.message }); }
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
