'use strict';
const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { generateFanCard }          = require('./fancard');
const {
  sendFanCardEmail,
  sendBookingConfirmation,
  sendBookingAccepted,
  sendBookingRejected,
  sendNewsletterWelcome,
  sendNewsletter
} = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3001;
const ROOT = path.join(__dirname, '..');
const JWT_SECRET      = process.env.JWT_SECRET;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;
const FW_SECRET        = process.env.FLUTTERWAVE_SECRET_KEY || '';
const FW_PUBLIC        = process.env.FLUTTERWAVE_PUBLIC_KEY || '';
const FW_WEBHOOK_SECRET = process.env.FW_WEBHOOK_SECRET || '';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set. Set it in Render before starting the server.');
}
if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is not set. Set it in Render before starting the server.');
}

/* ══════════════════════════════════════════════════════════
   IN-MEMORY STORES  (swap to DB for production)
═══════════════════════════════════════════════════════════ */
const bookings    = new Map();   // id → booking
const users       = new Map();   // email → user
const fancards    = new Map();   // userId → [fancard, ...]
const subscribers = new Map();   // email → { email, name, createdAt }

/* ── Middleware ─────────────────────────────────────────── */
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT, { acceptRanges: true }));

/* ── Photo uploads (memory, max 5 MB) ───────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

/* ── Helpers ────────────────────────────────────────────── */
function makeRef() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `RZ-${yy}${mm}${dd}-${uuidv4().replace(/-/g,'').slice(0,6).toUpperCase()}`;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Populates req.user if a valid token is present, but never blocks the request.
function optionalAuthMiddleware(req, _res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore invalid token */ }
  }
  next();
}

function adminAuthMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('not admin');
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin session' });
  }
}

// Minimal in-memory fixed-window rate limiter (per IP, per bucket).
const rateBuckets = new Map(); // key → { count, resetAt }
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const id  = `${key}:${req.ip}`;
    const now = Date.now();
    let bucket = rateBuckets.get(id);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(id, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

/* ══════════════════════════════════════════════════════════
   HEALTH
═══════════════════════════════════════════════════════════ */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Rezoro Backend', version: '2.0.0' });
});

/* ══════════════════════════════════════════════════════════
   HERO VIDEO STREAMING
═══════════════════════════════════════════════════════════ */
app.get('/hero.mp4', (req, res) => {
  const fs       = require('fs');
  const filePath = path.join(ROOT, 'hero.mp4');
  try {
    const stat  = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;
    if (range) {
      const [s, e]  = range.replace(/bytes=/, '').split('-');
      const start   = parseInt(s, 10);
      const end     = e ? parseInt(e, 10) : total - 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   'video/mp4'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch { res.status(404).send('Not found'); }
});

/* ══════════════════════════════════════════════════════════
   BOOKING INQUIRY  (index.html → submit booking)
═══════════════════════════════════════════════════════════ */
const TIERS = {
  individual: {
    bronze: { price: 2500,  days: 3  },
    silver: { price: 4100,  days: 7  },
    gold:   { price: 5000,  days: 14 }
  },
  company: {
    standard: { price: 10000, days: 7  },
    premium:  { price: 25000, days: 14 },
    elite:    { price: 50000, days: 30 }
  }
};

app.post('/api/booking-inquiry', rateLimit('booking', 5, 60 * 60 * 1000), async (req, res) => {
  try {
    const { name, email, phone, company, celebName, tier, tierType, message } = req.body;
    if (!name || !email || !celebName || !tier || !tierType) {
      return res.status(400).json({ error: 'name, email, celebName, tier and tierType are required.' });
    }

    const typeKey = (tierType||'individual').toLowerCase();
    const tierKey = (tier||'').toLowerCase();
    const tierData = (TIERS[typeKey]||{})[tierKey] || { price: 0, days: 0 };

    const ref = makeRef();
    const booking = {
      id: uuidv4(), ref,
      status: 'pending',
      name, email, phone: phone||'',
      company: company||'',
      celebName,
      tier: tier.charAt(0).toUpperCase() + tier.slice(1),
      tierType: typeKey,
      price: tierData.price,
      days: tierData.days,
      message: message||'',
      createdAt: new Date().toISOString(),
      paymentLink: null
    };
    bookings.set(booking.id, booking);

    console.log(`[BOOKING] ${ref} — ${celebName} for ${name} (${email})`);

    // Send confirmation email (non-blocking — don't fail booking if email fails)
    sendBookingConfirmation({
      to: email, name, celebName, ref,
      tier: booking.tier, tierType: typeKey,
      price: tierData.price, days: tierData.days
    }).catch(e => console.error('[email] confirmation failed:', e.message));

    res.json({ success: true, ref, message: `Booking received. Confirmation sent to ${email}` });
  } catch (err) {
    console.error('[booking-inquiry]', err.message);
    res.status(500).json({ error: 'Failed to process booking.' });
  }
});

/* ══════════════════════════════════════════════════════════
   ADMIN — AUTH + BOOKINGS
═══════════════════════════════════════════════════════════ */
app.post('/api/admin/login', rateLimit('admin-login', 10, 15 * 60 * 1000), (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/admin/bookings', adminAuthMiddleware, (_req, res) => {
  res.json([...bookings.values()].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)));
});

app.post('/api/admin/bookings/:id/accept', adminAuthMiddleware, async (req, res) => {
  const booking = bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Generate Flutterwave payment link
  let paymentLink = `https://rezoro.pro?ref=${booking.ref}`; // fallback
  if (FW_SECRET) {
    try {
      const fwRes = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${FW_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_ref:       booking.ref,
          amount:       booking.price,
          currency:     'USD',
          redirect_url: `https://rezoro.pro/payment-success.html?ref=${booking.ref}`,
          customer: { email: booking.email, name: booking.name },
          customizations: {
            title:       'Rezoro — Celebrity Booking',
            description: `${booking.tier} booking — ${booking.celebName}`,
            logo:        'https://rezoro.pro/logo.png'
          }
        })
      });
      const fwData = await fwRes.json();
      if (fwData.status === 'success') paymentLink = fwData.data.link;
    } catch (e) { console.error('[flutterwave]', e.message); }
  }

  booking.status      = 'accepted';
  booking.paymentLink = paymentLink;

  sendBookingAccepted({
    to: booking.email, name: booking.name,
    celebName: booking.celebName, ref: booking.ref,
    tier: `${booking.tier} (${booking.tierType})`,
    price: booking.price, days: booking.days,
    paymentLink
  }).catch(e => console.error('[email] accepted:', e.message));

  res.json({ success: true, booking });
});

app.post('/api/admin/bookings/:id/reject', adminAuthMiddleware, async (req, res) => {
  const booking = bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  booking.status = 'rejected';

  sendBookingRejected({
    to: booking.email, name: booking.name,
    celebName: booking.celebName, ref: booking.ref
  }).catch(e => console.error('[email] rejected:', e.message));

  res.json({ success: true, booking });
});

app.post('/api/admin/bookings/:id/status', adminAuthMiddleware, (req, res) => {
  const booking = bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const allowed = ['pending','accepted','payment_sent','confirmed','completed','rejected'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  booking.status = req.body.status;
  res.json({ success: true, booking });
});

/* ══════════════════════════════════════════════════════════
   FLUTTERWAVE WEBHOOK
═══════════════════════════════════════════════════════════ */
app.post('/api/payment/webhook', (req, res) => {
  // Reject all webhooks unless the shared secret is configured AND matches.
  const secret = req.headers['verif-hash'] || '';
  if (!FW_WEBHOOK_SECRET || secret !== FW_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { data } = req.body;
  if (data && data.status === 'successful') {
    const ref = data.tx_ref;
    for (const [, b] of bookings) {
      if (b.ref === ref) { b.status = 'confirmed'; break; }
    }
  }
  res.json({ status: 'ok' });
});

/* ══════════════════════════════════════════════════════════
   USER AUTH
═══════════════════════════════════════════════════════════ */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
    if (users.has(email.toLowerCase())) return res.status(409).json({ error: 'Email already registered.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const hash = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), name, email: email.toLowerCase(), hash, createdAt: new Date().toISOString() };
    users.set(user.email, user);

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.get((email||'').toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    const ok = await bcrypt.compare(password, user.hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
  } catch {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = users.get(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt });
});

/* ── Google Sign-In ─────────────────────────────────────── */
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'No credential' });
    // Verify via Google's tokeninfo endpoint
    const gRes  = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const gData = await gRes.json();
    if (gData.error || !gData.email) return res.status(401).json({ error: 'Invalid Google token' });

    const email = gData.email.toLowerCase();
    let user = users.get(email);
    if (!user) {
      user = { id: uuidv4(), name: gData.name || email, email, hash: '', createdAt: new Date().toISOString(), google: true };
      users.set(email, user);
    }
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
  } catch (err) {
    res.status(500).json({ error: 'Google sign-in failed.' });
  }
});

/* ══════════════════════════════════════════════════════════
   USER — PROFILE DATA
═══════════════════════════════════════════════════════════ */
app.get('/api/user/bookings', authMiddleware, (req, res) => {
  const userBookings = [...bookings.values()]
    .filter(b => b.email === req.user.email)
    .sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
  res.json(userBookings);
});

app.get('/api/user/fancards', authMiddleware, (req, res) => {
  res.json(fancards.get(req.user.id) || []);
});

/* ══════════════════════════════════════════════════════════
   NEWSLETTER
═══════════════════════════════════════════════════════════ */
app.post('/api/newsletter/subscribe', rateLimit('subscribe', 5, 60 * 60 * 1000), async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required.' });
  const key = email.toLowerCase();
  if (subscribers.has(key)) return res.json({ success: true, message: 'Already subscribed.' });
  subscribers.set(key, { email: key, name: name||'', createdAt: new Date().toISOString() });
  sendNewsletterWelcome({ to: key, name: name||'' }).catch(e => console.error('[email] welcome:', e.message));
  res.json({ success: true, message: 'Subscribed successfully!' });
});

app.get('/api/newsletter/subscribers', adminAuthMiddleware, (_req, res) => {
  res.json([...subscribers.values()].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)));
});

app.post('/api/newsletter/send', adminAuthMiddleware, async (req, res) => {
  try {
    const { subject, html, text } = req.body;
    if (!subject || !html) return res.status(400).json({ error: 'subject and html are required.' });
    const list = [...subscribers.keys()];
    if (list.length === 0) return res.json({ success: true, sent: 0 });
    let sent = 0;
    for (const to of list) {
      try { await sendNewsletter({ to, subject, html, text }); sent++; } catch {}
    }
    res.json({ success: true, sent, total: list.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send newsletter.' });
  }
});

/* ══════════════════════════════════════════════════════════
   FAN CARD  (existing + link to user account)
═══════════════════════════════════════════════════════════ */
app.post('/api/fancard', rateLimit('fancard', 5, 60 * 60 * 1000), optionalAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { fanName, country, celebName, celebEmoji, celebWiki, tier, email } = req.body;
    if (!fanName || !celebName || !email) {
      return res.status(400).json({ error: 'fanName, celebName and email are required.' });
    }
    const ref       = makeRef();
    const photoSrc  = req.file ? req.file.buffer : null;
    const tierClean = ['gold','silver','bronze'].includes(tier) ? tier : 'gold';

    const cardBuffer = await generateFanCard({
      fanName, country: country||'', celebName,
      celebEmoji: celebEmoji||'🎬', celebWiki: celebWiki||'', tier: tierClean, ref, photoSrc
    });

    await sendFanCardEmail({ to: email, fanName, country: country||'', celebName, tier: tierClean, ref, cardBuffer });

    // Save to the authenticated user's collection (identity from the verified JWT, never the request body)
    if (req.user) {
      const existing = fancards.get(req.user.id) || [];
      existing.unshift({ ref, celebName, tier: tierClean, fanName, country: country||'', createdAt: new Date().toISOString() });
      fancards.set(req.user.id, existing);
    }

    console.log(`[FANCARD] ${ref} — ${celebName} for ${fanName}`);
    res.json({ success: true, ref, message: `Fan card sent to ${email}` });
  } catch (err) {
    console.error('[fancard]', err.message);
    res.status(500).json({ error: 'Failed to process fan card.' });
  }
});

/* ── Start ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   R E Z O R O   B A C K E N D  v2    ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  http://localhost:${PORT}                ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
