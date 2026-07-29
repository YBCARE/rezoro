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
const { fulfillFancardOrder }      = require('./fancard-fulfillment');
const { stripImageMetadata }       = require('./image-clean');
const wikiProxy                    = require('./wiki-proxy');
const { createStore }              = require('./store');
const { seedBuiltInCelebrities }   = require('./seed-celebrities');
const {
  sendFanCardEmail,
  sendBookingConfirmation,
  sendBookingAccepted,
  sendBookingRejected,
  sendNewsletterWelcome,
  sendNewsletter,
  sendVerificationEmail
} = require('./mailer');

const { mountPaymentRoutes } = require('./payments/routes');
const paymentSettings        = require('./payments/settings');
const paymentAudit           = require('./payments/audit');
const { startExpirySweeper } = require('./payments/expire-sweep');
const { transitionPaymentStatus } = require('./payments/state-machine');
const { activateMembershipAfterVerifiedPayment } = require('./payments/membership-gate');

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
   PAYMENTS  (Flutterwave / Bank Transfer / Bitcoin / USDC)
═══════════════════════════════════════════════════════════ */
mountPaymentRoutes(app, {
  getStore: () => store,
  adminAuthMiddleware, optionalAuthMiddleware, upload, rateLimit, SITE_URL,
});

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

  // The customer picks a payment method (whichever admin has enabled) on
  // order.html — this no longer creates a Flutterwave link directly, since
  // Flutterwave might be disabled/in maintenance while Bank/BTC/USDC still work.
  const paymentLink = `${SITE_URL}/order.html?type=booking&ref=${booking.ref}`;
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
   FLUTTERWAVE — shared resolution (webhook + return-URL verify)
═══════════════════════════════════════════════════════════ */
// Re-verifies server-side via Flutterwave's own /verify endpoint — never
// trusts the webhook payload or a frontend redirect alone — using whichever
// key (test/live) was actually active when this attempt was created, not
// whatever the payload claims. Idempotent: a resolved attempt short-circuits.
async function handleFlutterwaveResolution(attempt, providerTransactionId) {
  if (attempt.status !== 'PENDING_PAYMENT') return { alreadyResolved: true };

  const keys = paymentSettings.resolveFlutterwaveKeys(attempt.environment);
  if (!keys) {
    console.error(`[flutterwave] cannot verify attempt ${attempt.id} — no ${attempt.environment} keys configured`);
    return { error: 'not_configured' };
  }

  let vData;
  try {
    const vRes = await fetch(`https://api.flutterwave.com/v3/transactions/${providerTransactionId}/verify`, {
      headers: { Authorization: `Bearer ${keys.secretKey}` }
    });
    vData = await vRes.json();
  } catch (e) {
    console.error('[flutterwave] verify request failed:', e.message);
    return { error: 'verify_request_failed' };
  }

  const tx = vData?.data;
  const ok = vData?.status === 'success' && tx?.status === 'successful' && tx?.tx_ref === attempt.id
    && Number(tx?.amount) >= Number(attempt.expectedAmount) && tx?.currency === attempt.expectedCurrency;

  if (!ok) {
    await paymentAudit.logEvent(store, {
      event: 'PAYMENT_VERIFICATION_FAILED', orderType: attempt.orderType, orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'webhook', metadata: { providerTransactionId },
    });
    return { verified: false };
  }

  if (attempt.environment === 'test') {
    await transitionPaymentStatus(store, attempt.id, ['PENDING_PAYMENT'], 'TEST_PAID', {
      providerTransactionId: String(providerTransactionId), verifiedAt: new Date().toISOString(),
    });
    await paymentAudit.logEvent(store, {
      event: 'PAYMENT_VERIFIED', orderType: attempt.orderType, orderRef: attempt.orderRef,
      paymentAttemptId: attempt.id, actorType: 'webhook',
      metadata: { environment: 'test', note: 'Test-mode payment — membership NOT activated.' },
    });
    return { verified: true, environment: 'test' };
  }

  const result = await activateMembershipAfterVerifiedPayment(store, {
    paymentAttemptId: attempt.id, fromStatuses: ['PENDING_PAYMENT'],
    verificationResult: { provider: 'flutterwave', status: tx.status, amount: tx.amount, currency: tx.currency },
    extraPatch: { providerTransactionId: String(providerTransactionId) },
  });
  return { verified: true, environment: 'live', activated: result.activated };
}

/*
 * Backward-compatibility path for Flutterwave payment links created BEFORE
 * the payment-attempt system existed, where tx_ref was the order's own
 * human-readable ref ("RZ-...") rather than a payment_attempts UUID.
 *
 * This must verify against Flutterwave exactly as rigorously as the modern
 * path does. An earlier version of this function trusted the webhook payload's
 * own `status: "successful"` and fulfilled immediately — meaning anyone able to
 * POST a forged body with a valid verif-hash could mint a free fan card or
 * confirm an unpaid booking. It now re-verifies server-side (real transaction,
 * matching ref, sufficient amount, matching currency) before anything is
 * fulfilled, and bookings get the amount/currency check they previously
 * skipped entirely.
 */
async function resolveLegacyFlutterwaveRef(txRef, providerTransactionId) {
  const booking = await store.bookings.getByRef(txRef);
  const order = booking ? null : await store.fancardOrders.getByRef(txRef);
  const target = booking || order;
  if (!target) return { error: 'unknown_ref' };

  // Already resolved — nothing to do (idempotent under webhook retries).
  if (booking ? booking.status === 'confirmed' : order.status === 'paid') {
    return { alreadyResolved: true };
  }

  const keys = paymentSettings.resolveFlutterwaveKeys('live');
  if (!keys || !providerTransactionId) {
    console.error(`[flutterwave-legacy] cannot verify ${txRef} — missing live keys or transaction id`);
    return { error: 'not_verifiable' };
  }

  let tx;
  try {
    const vRes = await fetch(`https://api.flutterwave.com/v3/transactions/${providerTransactionId}/verify`, {
      headers: { Authorization: `Bearer ${keys.secretKey}` },
      signal: AbortSignal.timeout(15000),
    });
    tx = (await vRes.json())?.data;
  } catch (e) {
    console.error('[flutterwave-legacy] verify request failed:', e.message);
    return { error: 'verify_request_failed' };
  }

  const expectedAmount = Number(target.price);
  const ok = tx?.status === 'successful' && tx?.tx_ref === txRef
    && Number.isFinite(expectedAmount) && Number(tx?.amount) >= expectedAmount
    && tx?.currency === 'USD';

  if (!ok) {
    await paymentAudit.logEvent(store, {
      event: 'PAYMENT_VERIFICATION_FAILED', orderType: booking ? 'booking' : 'fancard',
      orderRef: txRef, actorType: 'webhook',
      metadata: { legacy: true, providerTransactionId },
    }).catch(() => {});
    return { verified: false };
  }

  if (booking) {
    await store.bookings.updateByRef(txRef, { status: 'confirmed' });
  } else {
    await fulfillFancardOrder(store, order);
  }
  await paymentAudit.logEvent(store, {
    event: 'MEMBERSHIP_ACTIVATED', orderType: booking ? 'booking' : 'fancard',
    orderRef: txRef, actorType: 'webhook', metadata: { legacy: true },
  }).catch(() => {});
  return { verified: true, activated: true };
}

// Lets order.html trigger verification as soon as Flutterwave redirects the
// customer back — the webhook remains the authoritative path if the
// customer never lands back on the page, but this makes the common case instant.
app.get('/api/payment-attempts/:id/verify-flutterwave', rateLimit('fw-verify', 30, 60 * 60 * 1000), async (req, res) => {
  try {
    const attempt = await store.paymentAttempts.getById(req.params.id);
    if (!attempt || attempt.method !== 'flutterwave') return res.status(404).json({ error: 'Payment attempt not found.' });
    const transactionId = req.query.transaction_id;
    if (!transactionId) return res.status(400).json({ error: 'transaction_id is required.' });
    const result = await handleFlutterwaveResolution(attempt, transactionId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[flutterwave-verify]', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

/* ══════════════════════════════════════════════════════════
   FLUTTERWAVE WEBHOOK
═══════════════════════════════════════════════════════════ */
app.post('/api/payment/webhook', async (req, res) => {
  // Reject all webhooks unless the shared secret is configured AND matches.
  const secret = req.headers['verif-hash'] || '';
  if (!FW_WEBHOOK_SECRET || secret !== FW_WEBHOOK_SECRET) {
    await paymentAudit.logEvent(store, {
      event: 'WEBHOOK_REJECTED', actorType: 'webhook',
      metadata: { reason: 'invalid_or_missing_verif_hash' },
    }).catch(() => {});
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { data } = req.body;
    if (data && data.status === 'successful' && data.tx_ref) {
      // New-style payments: tx_ref is a payment_attempts.id (a UUID) created via
      // /api/orders/:type/:ref/attempts. Falls through to the legacy path below
      // for any payment link created before this system existed (tx_ref was the
      // order's own human-readable ref, e.g. "RZ-...", for those).
      const attempt = await store.paymentAttempts.getById(data.tx_ref);
      if (attempt) {
        await handleFlutterwaveResolution(attempt, data.id);
      } else {
        await resolveLegacyFlutterwaveRef(data.tx_ref, data.id);
      }
    }
  } catch (err) {
    // Always acknowledge receipt even if our own processing failed — a 5xx
    // here just makes Flutterwave retry the same webhook, which won't help
    // if the bug is on our side, and this event isn't the only path to
    // fulfillment (the return-URL verify and admin approval both also work).
    console.error('[webhook] processing failed:', err.message);
  }
  res.json({ status: 'ok' });
});

/* ══════════════════════════════════════════════════════════
   USER AUTH
═══════════════════════════════════════════════════════════ */
// Undefined means the account predates email verification — treat it as
// verified so existing users are never locked out by this feature.
const isVerified = user => user.emailVerified !== false;
const publicUser = user => ({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, emailVerified: isVerified(user) });

function sendVerificationLink(user) {
  const verifyToken = jwt.sign({ email: user.email, purpose: 'verify-email' }, JWT_SECRET, { expiresIn: '3d' });
  const verifyUrl = `${SITE_URL}/api/auth/verify-email?token=${verifyToken}`;
  return sendVerificationEmail({ to: user.email, name: user.name, verifyUrl })
    .catch(e => console.error('[email] verification:', e.message));
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
    if (await store.users.findByEmail(email.toLowerCase())) return res.status(409).json({ error: 'Email already registered.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const hash = await bcrypt.hash(password, 10);
    const user = { id: randomUUID(), name, email: email.toLowerCase(), hash, createdAt: new Date().toISOString(), emailVerified: false };
    await store.users.create(user);
    sendVerificationLink(user);

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
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
    res.json({ token, user: publicUser(user) });
  } catch {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await store.users.findByEmail(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

app.post('/api/auth/resend-verification', rateLimit('resend-verify', 5, 60 * 60 * 1000), authMiddleware, async (req, res) => {
  const user = await store.users.findByEmail(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isVerified(user)) return res.json({ success: true, alreadyVerified: true });
  await sendVerificationLink(user);
  res.json({ success: true });
});

app.get('/api/auth/verify-email', async (req, res) => {
  const sendResult = (title, message) => res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title} — Rezoro</title>
    <style>body{background:#07070A;color:#F0ECE4;font-family:Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:2rem;}
    a{color:#C9A84C;}</style></head><body><div><h1 style="font-weight:600;">${title}</h1><p style="color:#9A9490;">${message}</p>
    <p style="margin-top:1.5rem;"><a href="/account.html">Go to your account →</a></p></div></body></html>`);

  try {
    const { token } = req.query;
    if (!token) return sendResult('Invalid link', 'This verification link is missing its token.');
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch { return sendResult('Link expired', 'This verification link has expired. Sign in and request a new one from your account page.'); }
    if (payload.purpose !== 'verify-email' || !payload.email) return sendResult('Invalid link', 'This verification link is not valid.');

    const user = await store.users.findByEmail(payload.email);
    if (!user) return sendResult('Account not found', 'We could not find an account for this email.');
    await store.users.update(payload.email, { emailVerified: true });
    res.redirect('/account.html?verified=1');
  } catch (err) {
    sendResult('Something went wrong', 'Please try again or contact support.');
  }
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
      // Google has already verified this address — no separate verification needed.
      user = { id: randomUUID(), name: gData.name || email, email, hash: '', createdAt: new Date().toISOString(), google: true, emailVerified: true };
      await store.users.create(user);
    }
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
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

/* ══════════════════════════════════════════════════════════
   WIKIPEDIA PROXY  (fallback photos for celebrities with no admin
   upload) — routed through our server so a visitor's browser never
   talks to Wikipedia/Wikimedia directly, and their IP never reaches
   Wikimedia's servers just from browsing the homepage.
═══════════════════════════════════════════════════════════ */
app.get('/api/wiki-summary/:slug', rateLimit('wiki-summary', 120, 60 * 1000), async (req, res) => {
  const data = await wikiProxy.getWikiSummary(req.params.slug);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(data);
});

app.get('/api/wiki-image', rateLimit('wiki-image', 120, 60 * 1000), async (req, res) => {
  const result = await wikiProxy.fetchWikiImage(req.query.u);
  if (!result) return res.status(404).end();
  res.set('Content-Type', result.contentType || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(result.buffer);
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
    let photo = null;
    if (req.file) {
      photo = await stripImageMetadata(req.file.buffer);
      if (!photo) return res.status(400).json({ error: 'That photo could not be processed. Please upload a valid JPG or PNG image.' });
    }
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
    if (req.file) {
      const cleaned = await stripImageMetadata(req.file.buffer);
      if (!cleaned) return res.status(400).json({ error: 'That photo could not be processed. Please upload a valid JPG or PNG image.' });
      patch.photo = cleaned;
    }
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
   TESTIMONIALS  (real customer quotes, transcribed by admin — shown on index.html)
═══════════════════════════════════════════════════════════ */

// Public — only visible testimonials, no photo bytes (use /photo route)
app.get('/api/testimonials', async (_req, res) => {
  res.json(await store.testimonials.all({ onlyVisible: true }));
});

// Public — serves the actual photo bytes for a testimonial
app.get('/api/testimonials/:id/photo', async (req, res) => {
  const photo = await store.testimonials.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  res.set('Content-Type', photo.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(photo.buffer);
});

// Admin — full list including hidden entries
app.get('/api/admin/testimonials', adminAuthMiddleware, async (_req, res) => {
  res.json(await store.testimonials.all());
});

app.post('/api/admin/testimonials', adminAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { quote, name, role } = req.body;
    if (!quote || !name) return res.status(400).json({ error: 'quote and name are required.' });
    const visible = req.body.visible !== 'false';
    let photo = null;
    if (req.file) {
      photo = await stripImageMetadata(req.file.buffer);
      if (!photo) return res.status(400).json({ error: 'That photo could not be processed. Please upload a valid JPG or PNG image.' });
    }
    const row = await store.testimonials.create({
      quote: quote.trim(), name: name.trim(), role: (role || '').trim(), visible, photo
    });
    res.json({ success: true, testimonial: row });
  } catch (err) {
    console.error('[testimonials create]', err.message);
    res.status(500).json({ error: 'Failed to add testimonial.' });
  }
});

app.put('/api/admin/testimonials/:id', adminAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const existing = await store.testimonials.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Testimonial not found.' });
    const patch = {};
    if (req.body.quote !== undefined)   patch.quote = req.body.quote.trim();
    if (req.body.name !== undefined)    patch.name = req.body.name.trim();
    if (req.body.role !== undefined)    patch.role = req.body.role.trim();
    if (req.body.visible !== undefined) patch.visible = req.body.visible !== 'false';
    if (req.file) {
      const cleaned = await stripImageMetadata(req.file.buffer);
      if (!cleaned) return res.status(400).json({ error: 'That photo could not be processed. Please upload a valid JPG or PNG image.' });
      patch.photo = cleaned;
    }
    const row = await store.testimonials.update(req.params.id, patch);
    res.json({ success: true, testimonial: row });
  } catch (err) {
    console.error('[testimonials update]', err.message);
    res.status(500).json({ error: 'Failed to update testimonial.' });
  }
});

app.delete('/api/admin/testimonials/:id', adminAuthMiddleware, async (req, res) => {
  const ok = await store.testimonials.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Testimonial not found.' });
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

// Creates the order only — no payment method is chosen yet. The customer is
// sent to order.html, which lists whichever methods are currently ENABLED
// and creates the actual payment attempt once one is picked (see
// server/payments/routes.js). This is what makes "admin disables Flutterwave,
// Bank/BTC/USDC still work" possible — nothing here is FLW-specific anymore.
app.post('/api/fancard/checkout', rateLimit('fancard', 8, 60 * 60 * 1000), optionalAuthMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { fanName, country, celebName, celebWiki, celebId, tier, email } = req.body;
    if (!fanName || !celebName || !email) {
      return res.status(400).json({ error: 'fanName, celebName and email are required.' });
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
    // Strip EXIF/GPS from the buyer's photo before it's stored and printed onto
    // the emailed card — a phone selfie carries the exact coordinates it was
    // taken at, and we never want that travelling with the collectible.
    let photo = null;
    if (req.file) {
      photo = await stripImageMetadata(req.file.buffer);
      if (!photo) return res.status(400).json({ error: 'That photo could not be processed. Please upload a valid JPG or PNG image.' });
    }

    await store.fancardOrders.create({
      ref, fanName, country: country || '', celebName, celebWiki: celebWiki || '', celebId: celebId || null,
      tier: tierClean, price, email, userId: req.user ? req.user.id : null, photo
    });
    await paymentAudit.logEvent(store, {
      event: 'ORDER_CREATED', orderType: 'fancard', orderRef: ref,
      actorType: req.user ? 'customer' : 'system', actorId: req.user ? req.user.id : null,
      metadata: { celebName, tier: tierClean, price },
    });

    res.json({ success: true, ref });
  } catch (err) {
    console.error('[fancard/checkout]', err.message);
    res.status(500).json({ error: 'Failed to start checkout.' });
  }
});

app.get('/api/payment/verify', rateLimit('verify', 30, 60 * 60 * 1000), async (req, res) => {
  try {
    const { type, ref, transaction_id } = req.query;
    if (!type || !ref) return res.status(400).json({ error: 'type and ref are required.' });

    if (type !== 'fancard' && type !== 'booking') {
      return res.status(400).json({ error: 'Unknown payment type.' });
    }

    const target = type === 'booking'
      ? await store.bookings.getByRef(ref)
      : await store.fancardOrders.getByRef(ref);
    if (!target) return res.status(404).json({ error: 'Order not found.' });

    const alreadyDone = type === 'booking' ? target.status === 'confirmed' : target.status === 'paid';
    if (alreadyDone) {
      return res.json({ success: true, alreadyProcessed: true, celebName: target.celebName, tier: target.tier, ref });
    }

    // Same hardened verification the webhook uses — real Flutterwave lookup,
    // matching ref, sufficient amount, matching currency. Bookings previously
    // skipped the amount/currency check here entirely.
    const result = await resolveLegacyFlutterwaveRef(ref, transaction_id);
    if (!result.verified) return res.status(402).json({ error: 'Payment could not be verified.' });

    // Deliberately no customer email in the response — this endpoint takes only
    // a guessable order ref and no authentication, so echoing the buyer's email
    // back made it an unauthenticated PII lookup.
    return res.json({ success: true, celebName: target.celebName, tier: target.tier, ref });
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
    startExpirySweeper(store);
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
