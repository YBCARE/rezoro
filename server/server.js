'use strict';
const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const { generatePrintCard, generatePrintCardBack } = require('./fancard-print');
const { generateCertificate }      = require('./certificate');
const { createStore }              = require('./store');
const { seedBuiltInCelebrities }   = require('./seed-celebrities');
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
const SITE_URL = process.env.SITE_URL || 'https://rezoro.pro';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set. Set it in Render before starting the server.');
}
if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is not set. Set it in Render before starting the server.');
}

/* ══════════════════════════════════════════════════════════
   DATA STORE  (Postgres when DATABASE_URL is set, else memory)
═══════════════════════════════════════════════════════════ */
let store; // assigned before the server starts listening

/* ── Middleware ─────────────────────────────────────────── */
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT, { acceptRanges: true }));

/* ── Photo uploads (memory, max 10 MB) ──────────────────── */
// 5MB was too tight for an unedited phone photo — a normal camera shot
// or screenshot routinely lands in the 6-9MB range, which was causing
// multer to abort the upload stream mid-request. The browser reports
// that as a bare "Failed to fetch" instead of a readable error, since
// the connection drops before any response body arrives.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

/* ── Helpers ────────────────────────────────────────────── */
function makeRef() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `RZ-${yy}${mm}${dd}-${randomUUID().replace(/-/g,'').slice(0,6).toUpperCase()}`;
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
const DEFAULT_BOOKING_PRICING = {
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

app.get('/api/settings/booking-pricing', async (_req, res) => {
  res.json(await store.settings.get('booking-pricing', DEFAULT_BOOKING_PRICING));
});

app.put('/api/admin/settings/booking-pricing', adminAuthMiddleware, async (req, res) => {
  const body = req.body || {};
  const toPricing = (obj, tiers) => {
    const out = {};
    for (const t of tiers) {
      const price = Number(obj?.[t]?.price);
      const days  = Number(obj?.[t]?.days);
      if (!Number.isFinite(price) || price < 0 || !Number.isFinite(days) || days < 1) return null;
      out[t] = { price, days };
    }
    return out;
  };
  const individual = toPricing(body.individual, ['bronze','silver','gold']);
  const company     = toPricing(body.company, ['standard','premium','elite']);
  if (!individual || !company) {
    return res.status(400).json({ error: 'Every tier needs a valid non-negative price and a days value of at least 1.' });
  }
  const pricing = { individual, company };
  await store.settings.set('booking-pricing', pricing);
  res.json({ success: true, pricing });
});

app.post('/api/booking-inquiry', rateLimit('booking', 5, 60 * 60 * 1000), async (req, res) => {
  try {
    const { name, email, phone, company, celebName, tier, tierType, message } = req.body;
    if (!name || !email || !celebName || !tier || !tierType) {
      return res.status(400).json({ error: 'name, email, celebName, tier and tierType are required.' });
    }

    const typeKey = (tierType||'individual').toLowerCase();
    const tierKey = (tier||'').toLowerCase();
    const bookingPricing = await store.settings.get('booking-pricing', DEFAULT_BOOKING_PRICING);
    const tierData = (bookingPricing[typeKey]||{})[tierKey] || { price: 0, days: 0 };

    const ref = makeRef();
    const booking = {
      id: randomUUID(), ref,
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
    await store.bookings.create(booking);

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

app.get('/api/admin/bookings', adminAuthMiddleware, async (_req, res) => {
  res.json(await store.bookings.all());
});

app.post('/api/admin/bookings/:id/accept', adminAuthMiddleware, async (req, res) => {
  const booking = await store.bookings.getById(req.params.id);
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
          redirect_url: `${SITE_URL}/payment-success.html?type=booking&ref=${booking.ref}`,
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

  const updated = await store.bookings.update(booking.id, { status: 'accepted', paymentLink });

  sendBookingAccepted({
    to: booking.email, name: booking.name,
    celebName: booking.celebName, ref: booking.ref,
    tier: `${booking.tier} (${booking.tierType})`,
    price: booking.price, days: booking.days,
    paymentLink
  }).catch(e => console.error('[email] accepted:', e.message));

  res.json({ success: true, booking: updated });
});

app.post('/api/admin/bookings/:id/reject', adminAuthMiddleware, async (req, res) => {
  const booking = await store.bookings.getById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const updated = await store.bookings.update(booking.id, { status: 'rejected' });

  sendBookingRejected({
    to: booking.email, name: booking.name,
    celebName: booking.celebName, ref: booking.ref
  }).catch(e => console.error('[email] rejected:', e.message));

  res.json({ success: true, booking: updated });
});

app.post('/api/admin/bookings/:id/status', adminAuthMiddleware, async (req, res) => {
  const booking = await store.bookings.getById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const allowed = ['pending','accepted','payment_sent','confirmed','completed','rejected'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  const updated = await store.bookings.update(booking.id, { status: req.body.status });
  res.json({ success: true, booking: updated });
});

/* ══════════════════════════════════════════════════════════
   FLUTTERWAVE WEBHOOK
═══════════════════════════════════════════════════════════ */
app.post('/api/payment/webhook', async (req, res) => {
  // Reject all webhooks unless the shared secret is configured AND matches.
  const secret = req.headers['verif-hash'] || '';
  if (!FW_WEBHOOK_SECRET || secret !== FW_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { data } = req.body;
  if (data && data.status === 'successful' && data.tx_ref) {
    // Redundant confirmation path in case the buyer never lands back on
    // payment-success.html — covers both bookings and fan card orders.
    const booking = [...await store.bookings.all()].find(b => b.ref === data.tx_ref);
    if (booking) {
      await store.bookings.updateByRef(data.tx_ref, { status: 'confirmed' });
    } else {
      const order = await store.fancardOrders.getByRef(data.tx_ref);
      if (order && order.status !== 'paid') {
        try { await fulfillFancardOrder(order); }
        catch (e) { console.error('[webhook] fulfill failed:', e.message); }
      }
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
    if (await store.users.findByEmail(email.toLowerCase())) return res.status(409).json({ error: 'Email already registered.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const hash = await bcrypt.hash(password, 10);
    const user = { id: randomUUID(), name, email: email.toLowerCase(), hash, createdAt: new Date().toISOString() };
    await store.users.create(user);

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await store.users.findByEmail((email||'').toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    const ok = await bcrypt.compare(password, user.hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
  } catch {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await store.users.findByEmail(req.user.email);
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
    let user = await store.users.findByEmail(email);
    if (!user) {
      user = { id: randomUUID(), name: gData.name || email, email, hash: '', createdAt: new Date().toISOString(), google: true };
      await store.users.create(user);
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
app.get('/api/user/bookings', authMiddleware, async (req, res) => {
  res.json(await store.bookings.byEmail(req.user.email));
});

app.get('/api/user/fancards', authMiddleware, async (req, res) => {
  res.json(await store.fancards.byUser(req.user.id));
});

/* ══════════════════════════════════════════════════════════
   NEWSLETTER
═══════════════════════════════════════════════════════════ */
app.post('/api/newsletter/subscribe', rateLimit('subscribe', 5, 60 * 60 * 1000), async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required.' });
  const key = email.toLowerCase();
  if (await store.subscribers.has(key)) return res.json({ success: true, message: 'Already subscribed.' });
  await store.subscribers.add({ email: key, name: name||'', createdAt: new Date().toISOString() });
  sendNewsletterWelcome({ to: key, name: name||'' }).catch(e => console.error('[email] welcome:', e.message));
  res.json({ success: true, message: 'Subscribed successfully!' });
});

app.get('/api/newsletter/subscribers', adminAuthMiddleware, async (_req, res) => {
  res.json(await store.subscribers.all());
});

app.post('/api/newsletter/send', adminAuthMiddleware, async (req, res) => {
  try {
    const { subject, html, text } = req.body;
    if (!subject || !html) return res.status(400).json({ error: 'subject and html are required.' });
    const list = await store.subscribers.emails();
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
   CELEBRITIES  (roster shown on index.html / fans.html)
═══════════════════════════════════════════════════════════ */

// Public — only visible celebrities, no photo bytes (use /photo route)
app.get('/api/celebrities', async (_req, res) => {
  res.json(await store.celebrities.all({ onlyVisible: true }));
});

// Public — serves the actual photo bytes for a celebrity
app.get('/api/celebrities/:id/photo', async (req, res) => {
  const photo = await store.celebrities.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  res.set('Content-Type', photo.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(photo.buffer);
});

// Admin — full list including hidden entries
app.get('/api/admin/celebrities', adminAuthMiddleware, async (_req, res) => {
  res.json(await store.celebrities.all());
});

app.post('/api/admin/celebrities', adminAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { name, tier, knownFor, trailerUrl, wiki } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const tierClean = ['gold', 'silver', 'bronze'].includes(tier) ? tier : 'gold';
    const visible = req.body.visible !== 'false';
    const photo = req.file ? { buffer: req.file.buffer, mime: req.file.mimetype } : null;
    const row = await store.celebrities.create({
      name, tier: tierClean, knownFor: knownFor || '', trailerUrl: trailerUrl || '', wiki: wiki || '', visible, photo
    });
    res.json({ success: true, celebrity: row });
  } catch (err) {
    console.error('[celebrities create]', err.message);
    res.status(500).json({ error: 'Failed to add celebrity.' });
  }
});

app.put('/api/admin/celebrities/:id', adminAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const existing = await store.celebrities.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Celebrity not found.' });
    const patch = {};
    if (req.body.name !== undefined)       patch.name = req.body.name;
    if (req.body.tier !== undefined)       patch.tier = ['gold', 'silver', 'bronze'].includes(req.body.tier) ? req.body.tier : existing.tier;
    if (req.body.knownFor !== undefined)   patch.knownFor = req.body.knownFor;
    if (req.body.trailerUrl !== undefined) patch.trailerUrl = req.body.trailerUrl;
    if (req.body.wiki !== undefined)       patch.wiki = req.body.wiki;
    if (req.body.visible !== undefined)    patch.visible = req.body.visible !== 'false';
    if (req.file)                          patch.photo = { buffer: req.file.buffer, mime: req.file.mimetype };
    const row = await store.celebrities.update(req.params.id, patch);
    res.json({ success: true, celebrity: row });
  } catch (err) {
    console.error('[celebrities update]', err.message);
    res.status(500).json({ error: 'Failed to update celebrity.' });
  }
});

app.delete('/api/admin/celebrities/:id', adminAuthMiddleware, async (req, res) => {
  const ok = await store.celebrities.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Celebrity not found.' });
  res.json({ success: true });
});

/* ══════════════════════════════════════════════════════════
   FAN CARD PRICING  (editable tier prices, shown on fans.html)
═══════════════════════════════════════════════════════════ */
const DEFAULT_FANCARD_PRICING = { gold: 5000, silver: 4100, bronze: 2500 };

app.get('/api/settings/fancard-pricing', async (_req, res) => {
  res.json(await store.settings.get('fancard-pricing', DEFAULT_FANCARD_PRICING));
});

app.put('/api/admin/settings/fancard-pricing', adminAuthMiddleware, async (req, res) => {
  const { gold, silver, bronze } = req.body || {};
  const toPositiveNumber = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const pricing = {
    gold:   toPositiveNumber(gold),
    silver: toPositiveNumber(silver),
    bronze: toPositiveNumber(bronze),
  };
  if (Object.values(pricing).some(v => v === null)) {
    return res.status(400).json({ error: 'gold, silver and bronze must all be valid non-negative numbers.' });
  }
  await store.settings.set('fancard-pricing', pricing);
  res.json({ success: true, pricing });
});

/* ══════════════════════════════════════════════════════════
   FAN CARD BENEFITS  (editable tier feature lists, shown on fans.html)
═══════════════════════════════════════════════════════════ */
const DEFAULT_FANCARD_BENEFITS = {
  gold:   ['Top 10 A-list celebrities', 'Holographic gold-foil card', 'Digital & physical edition', "Numbered collector's certificate", 'Priority concierge support'],
  silver: ['10 international stars', 'Chrome-finish silver card', 'Digital & physical edition', 'Numbered limited edition', 'Standard support'],
  bronze: ['6 rising stars', 'Copper-metallic finish card', 'Digital edition', 'Standard edition', 'Email support'],
};

app.get('/api/settings/fancard-benefits', async (_req, res) => {
  res.json(await store.settings.get('fancard-benefits', DEFAULT_FANCARD_BENEFITS));
});

app.put('/api/admin/settings/fancard-benefits', adminAuthMiddleware, async (req, res) => {
  const { gold, silver, bronze } = req.body || {};
  const toList = v => Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean).slice(0, 12) : null;
  const benefits = { gold: toList(gold), silver: toList(silver), bronze: toList(bronze) };
  if (Object.values(benefits).some(v => v === null || v.length === 0)) {
    return res.status(400).json({ error: 'gold, silver and bronze must each have at least one benefit line.' });
  }
  await store.settings.set('fancard-benefits', benefits);
  res.json({ success: true, benefits });
});

/* ══════════════════════════════════════════════════════════
   FAN CARD ORDERS  (admin visibility into who paid, and how much)
═══════════════════════════════════════════════════════════ */
app.get('/api/admin/fancard-orders', adminAuthMiddleware, async (_req, res) => {
  res.json(await store.fancardOrders.all());
});

/* ══════════════════════════════════════════════════════════
   FAN CARD  (existing + link to user account)
═══════════════════════════════════════════════════════════ */

// Generates the print-ready card + certificate, emails them, and records
// the order as delivered. Called only after payment is verified. Safe to
// call twice for the same order — it's guarded by order.status at the
// call sites (checked before invoking).
async function fulfillFancardOrder(order) {
  let celebImageSrc = null;
  if (order.celebId) {
    const photo = await store.celebrities.getPhoto(order.celebId);
    if (photo) celebImageSrc = photo.buffer;
  }

  const edNum   = await store.editions.next(`${order.tier}:${order.celebName.toLowerCase()}`);
  const edition = `No. ${String(edNum).padStart(3, '0')}`;

  const photoSrc = order.photo ? order.photo.buffer : null;

  const issued = new Date();

  // Front: the celebrity. Back: the collector. Printed as one double-sided card.
  const cardBuffer = await generatePrintCard({
    fanName: order.fanName, country: order.country || '', celebName: order.celebName,
    celebWiki: order.celebWiki || '', celebImageSrc, tier: order.tier, ref: order.ref, edition
  });
  const cardBackBuffer = await generatePrintCardBack({
    fanName: order.fanName, country: order.country || '', celebName: order.celebName,
    tier: order.tier, ref: order.ref, edition, issued, photoSrc
  });
  const certBuffer = generateCertificate({
    fanName: order.fanName, celebName: order.celebName, tier: order.tier, ref: order.ref, edition, issued
  });

  await sendFanCardEmail({
    to: order.email, fanName: order.fanName, country: order.country || '', celebName: order.celebName,
    tier: order.tier, ref: order.ref, edition, cardBuffer, cardBackBuffer, certBuffer
  });

  if (order.userId) {
    await store.fancards.add(order.userId, {
      ref: order.ref, celebName: order.celebName, tier: order.tier, fanName: order.fanName,
      country: order.country || '', edition, createdAt: new Date().toISOString()
    });
  }

  await store.fancardOrders.markPaid(order.ref, { edition, delivered: true });
  console.log(`[FANCARD] ${order.ref} — ${order.celebName} for ${order.fanName} (paid, delivered)`);
}

app.post('/api/fancard/checkout', rateLimit('fancard', 8, 60 * 60 * 1000), optionalAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { fanName, country, celebName, celebWiki, celebId, tier, email } = req.body;
    if (!fanName || !celebName || !email) {
      return res.status(400).json({ error: 'fanName, celebName and email are required.' });
    }
    if (!FW_SECRET) {
      return res.status(503).json({ error: 'Payments are not configured yet. Contact the site owner.' });
    }

    const tierClean = ['gold','silver','bronze'].includes(tier) ? tier : 'gold';
    if (celebId) {
      const celeb = await store.celebrities.getById(celebId);
      if (!celeb || celeb.visible === false) {
        return res.status(400).json({ error: 'This celebrity is not currently available.' });
      }
    }

    // Price comes from admin-set settings — never trust a client-submitted amount.
    const pricing = await store.settings.get('fancard-pricing', { gold: 5000, silver: 4100, bronze: 2500 });
    const price = pricing[tierClean];

    const ref = makeRef();
    const photo = req.file ? { buffer: req.file.buffer, mime: req.file.mimetype } : null;

    await store.fancardOrders.create({
      ref, fanName, country: country || '', celebName, celebWiki: celebWiki || '', celebId: celebId || null,
      tier: tierClean, price, email, userId: req.user ? req.user.id : null, photo
    });

    let paymentLink = null;
    try {
      const fwRes = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${FW_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_ref: ref, amount: price, currency: 'USD',
          redirect_url: `${SITE_URL}/payment-success.html?type=fancard&ref=${ref}`,
          customer: { email, name: fanName },
          customizations: {
            title: 'Rezoro — Fan Card',
            description: `${tierClean} fan card — ${celebName}`,
            logo: `${SITE_URL}/logo.png`
          }
        })
      });
      const fwData = await fwRes.json();
      if (fwData.status === 'success') paymentLink = fwData.data.link;
    } catch (e) { console.error('[flutterwave]', e.message); }

    if (!paymentLink) {
      return res.status(502).json({ error: 'Could not start payment. Please try again shortly.' });
    }

    res.json({ success: true, ref, paymentLink });
  } catch (err) {
    console.error('[fancard/checkout]', err.message);
    res.status(500).json({ error: 'Failed to start checkout.' });
  }
});

app.get('/api/payment/verify', rateLimit('verify', 30, 60 * 60 * 1000), async (req, res) => {
  try {
    const { type, ref, transaction_id } = req.query;
    if (!type || !ref) return res.status(400).json({ error: 'type and ref are required.' });

    if (type === 'fancard') {
      const order = await store.fancardOrders.getByRef(ref);
      if (!order) return res.status(404).json({ error: 'Order not found.' });
      if (order.status === 'paid') {
        return res.json({ success: true, alreadyProcessed: true, celebName: order.celebName, tier: order.tier, email: order.email, ref });
      }
      if (!FW_SECRET || !transaction_id) return res.status(400).json({ error: 'Cannot verify this payment.' });

      const vRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
        headers: { 'Authorization': `Bearer ${FW_SECRET}` }
      });
      const vData = await vRes.json();
      const tx = vData?.data;
      const ok = vData.status === 'success' && tx?.status === 'successful' && tx?.tx_ref === ref
        && Number(tx?.amount) >= Number(order.price) && tx?.currency === 'USD';
      if (!ok) return res.status(402).json({ error: 'Payment could not be verified.' });

      await fulfillFancardOrder(order);
      return res.json({ success: true, celebName: order.celebName, tier: order.tier, email: order.email, ref });
    }

    if (type === 'booking') {
      const booking = [...await store.bookings.all()].find(b => b.ref === ref);
      if (!booking) return res.status(404).json({ error: 'Booking not found.' });
      if (booking.status !== 'confirmed' && FW_SECRET && transaction_id) {
        const vRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
          headers: { 'Authorization': `Bearer ${FW_SECRET}` }
        });
        const vData = await vRes.json();
        const tx = vData?.data;
        const ok = vData.status === 'success' && tx?.status === 'successful' && tx?.tx_ref === ref;
        if (ok) await store.bookings.updateByRef(ref, { status: 'confirmed' });
      }
      return res.json({ success: true, celebName: booking.celebName, tier: booking.tier, email: booking.email, ref });
    }

    res.status(400).json({ error: 'Unknown payment type.' });
  } catch (err) {
    console.error('[payment/verify]', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

/* ══════════════════════════════════════════════════════════
   ERROR HANDLING  (must be registered after every route)
   Without this, an upload error (e.g. a photo over the size limit)
   aborts the connection instead of returning JSON — the browser then
   reports a bare "Failed to fetch" with no explanation.
═══════════════════════════════════════════════════════════ */
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That photo is too large. Please upload one under 10MB.' });
    }
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }
  console.error('[unhandled]', err.stack || err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

/* ── Start ──────────────────────────────────────────────── */
createStore()
  .then(async s => {
    store = s;
    await seedBuiltInCelebrities(store);
    app.listen(PORT, () => {
      console.log(`\n  ╔══════════════════════════════════════╗`);
      console.log(`  ║   R E Z O R O   B A C K E N D  v2    ║`);
      console.log(`  ╠══════════════════════════════════════╣`);
      console.log(`  ║  http://localhost:${PORT}                ║`);
      console.log(`  ╚══════════════════════════════════════╝\n`);
    });
  })
  .catch(err => {
    console.error('[startup] Failed to initialise data store:', err.message);
    process.exit(1);
  });
