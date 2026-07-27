'use strict';

/*
 * Storage layer.
 *
 * When DATABASE_URL is set, data is stored in Postgres and survives deploys,
 * restarts, and free-tier spin-downs. When it is not set, an in-memory store
 * is used so local dev and un-provisioned deploys still run — but that data is
 * lost whenever the process restarts. Set DATABASE_URL (e.g. a free Neon
 * Postgres connection string) in production.
 */

const { randomUUID } = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const byCreatedDesc = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);

// Omit the raw photo bytes from list/detail JSON — the photo is served by its own route.
function stripPhoto(row) {
  const { photo, ...rest } = row;
  return { ...rest, hasPhoto: !!photo };
}

// Same idea for bank-transfer receipt uploads — served by their own route, never inlined.
function stripReceipt(row) {
  const { receipt, ...rest } = row;
  return { ...rest, hasReceipt: !!receipt };
}

/* ── In-memory backend ──────────────────────────────────── */
function memoryStore() {
  const users = new Map();       // email → user
  const bookings = new Map();    // id → booking
  const fancards = new Map();    // userId → [card, ...]
  const subscribers = new Map(); // email → subscriber
  const editions = new Map();    // key → running count
  const celebrities = new Map(); // id → { id, name, tier, knownFor, trailerUrl, visible, wiki, photo:{buffer,mime}|null, createdAt }
  const testimonials = new Map(); // id → { id, quote, name, role, visible, photo:{buffer,mime}|null, createdAt }
  const settings = new Map();    // key → value
  const fancardOrders = new Map(); // ref → order
  const paymentAttempts = new Map(); // id → attempt
  const paymentAuditLog = [];        // append-only list of events

  return {
    persistent: false,
    editions: {
      async next(key) { const n = (editions.get(key) || 0) + 1; editions.set(key, n); return n; },
    },
    celebrities: {
      async all({ onlyVisible = false } = {}) {
        let list = [...celebrities.values()];
        if (onlyVisible) list = list.filter(c => c.visible !== false);
        return list.sort(byCreatedDesc).map(stripPhoto);
      },
      async getById(id) { return celebrities.get(id) || null; },
      async getPhoto(id) { return celebrities.get(id)?.photo || null; },
      async create(c) {
        const row = { id: randomUUID(), createdAt: new Date().toISOString(), ...c };
        celebrities.set(row.id, row);
        return stripPhoto(row);
      },
      async update(id, patch) {
        const row = celebrities.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        return stripPhoto(row);
      },
      async remove(id) { return celebrities.delete(id); },
    },
    testimonials: {
      async all({ onlyVisible = false } = {}) {
        let list = [...testimonials.values()];
        if (onlyVisible) list = list.filter(t => t.visible !== false);
        return list.sort(byCreatedDesc).map(stripPhoto);
      },
      async getById(id) { return testimonials.get(id) || null; },
      async getPhoto(id) { return testimonials.get(id)?.photo || null; },
      async create(t) {
        const row = { id: randomUUID(), createdAt: new Date().toISOString(), ...t };
        testimonials.set(row.id, row);
        return stripPhoto(row);
      },
      async update(id, patch) {
        const row = testimonials.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        return stripPhoto(row);
      },
      async remove(id) { return testimonials.delete(id); },
    },
    fancardOrders: {
      async create(o) {
        const row = { status: 'pending', createdAt: new Date().toISOString(), ...o };
        fancardOrders.set(row.ref, row);
        return stripPhoto(row);
      },
      async getByRef(ref) { return fancardOrders.get(ref) || null; },
      async getPhoto(ref) { return fancardOrders.get(ref)?.photo || null; },
      async markPaid(ref, patch) {
        const row = fancardOrders.get(ref);
        if (!row) return null;
        Object.assign(row, { status: 'paid', paidAt: new Date().toISOString() }, patch);
        return stripPhoto(row);
      },
      async all() { return [...fancardOrders.values()].sort(byCreatedDesc).map(stripPhoto); },
    },
    paymentAttempts: {
      async create(a) {
        const now = new Date().toISOString();
        const row = { id: randomUUID(), status: 'PENDING_PAYMENT', createdAt: now, updatedAt: now, ...a };
        paymentAttempts.set(row.id, row);
        return stripReceipt(row);
      },
      async getById(id) { return paymentAttempts.get(id) || null; },
      async getReceipt(id) { return paymentAttempts.get(id)?.receipt || null; },
      async getByOrder(orderType, orderRef) {
        return [...paymentAttempts.values()]
          .filter(a => a.orderType === orderType && a.orderRef === orderRef)
          .sort(byCreatedDesc).map(stripReceipt);
      },
      async getByTxid(txid) {
        return [...paymentAttempts.values()].find(a => a.txid && a.txid === txid) || null;
      },
      async getByProviderTransactionId(providerTransactionId) {
        return [...paymentAttempts.values()].find(a => a.providerTransactionId && a.providerTransactionId === providerTransactionId) || null;
      },
      // The heart of idempotent status changes: only applies if the row's current
      // status is still one of `fromStatuses` — a stale/duplicate caller (double
      // webhook, double click, retry) sees no matching row and gets null back,
      // rather than corrupting state that another caller already moved on.
      async transitionStatus(id, fromStatuses, toStatus, patch = {}) {
        const row = paymentAttempts.get(id);
        if (!row || !fromStatuses.includes(row.status)) return null;
        Object.assign(row, patch, { status: toStatus, updatedAt: new Date().toISOString() });
        return stripReceipt(row);
      },
      async update(id, patch) {
        const row = paymentAttempts.get(id);
        if (!row) return null;
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return stripReceipt(row);
      },
      async all({ status, orderType } = {}) {
        let list = [...paymentAttempts.values()];
        if (status) list = list.filter(a => (Array.isArray(status) ? status.includes(a.status) : a.status === status));
        if (orderType) list = list.filter(a => a.orderType === orderType);
        return list.sort(byCreatedDesc).map(stripReceipt);
      },
      async sweepExpired(now = new Date()) {
        const expired = [];
        for (const row of paymentAttempts.values()) {
          if (row.status === 'PENDING_PAYMENT' && row.expiresAt && new Date(row.expiresAt) < now) {
            row.status = 'EXPIRED';
            row.updatedAt = new Date().toISOString();
            expired.push(stripReceipt(row));
          }
        }
        return expired;
      },
    },
    paymentAuditLog: {
      async append(event) {
        const row = { id: paymentAuditLog.length + 1, createdAt: new Date().toISOString(), ...event };
        paymentAuditLog.push(row);
        return row;
      },
      async byOrder(orderType, orderRef) {
        return paymentAuditLog.filter(e => e.orderType === orderType && e.orderRef === orderRef).sort(byCreatedDesc);
      },
      async byPaymentAttempt(paymentAttemptId) {
        return paymentAuditLog.filter(e => e.paymentAttemptId === paymentAttemptId).sort(byCreatedDesc);
      },
      async recent(limit = 200) {
        return [...paymentAuditLog].sort(byCreatedDesc).slice(0, limit);
      },
    },
    users: {
      async findByEmail(email) { return users.get(email) || null; },
      async create(u) { users.set(u.email, u); return u; },
      async update(email, patch) {
        const u = users.get(email);
        if (!u) return null;
        Object.assign(u, patch);
        return u;
      },
    },
    bookings: {
      async create(b) { bookings.set(b.id, b); return b; },
      async getById(id) { return bookings.get(id) || null; },
      async getByRef(ref) {
        for (const b of bookings.values()) { if (b.ref === ref) return b; }
        return null;
      },
      async update(id, patch) {
        const b = bookings.get(id);
        if (!b) return null;
        Object.assign(b, patch);
        return b;
      },
      async updateByRef(ref, patch) {
        for (const b of bookings.values()) {
          if (b.ref === ref) { Object.assign(b, patch); return b; }
        }
        return null;
      },
      async all() { return [...bookings.values()].sort(byCreatedDesc); },
      async byEmail(email) {
        return [...bookings.values()].filter(b => b.email === email).sort(byCreatedDesc);
      },
    },
    fancards: {
      async add(userId, card) {
        const arr = fancards.get(userId) || [];
        arr.unshift(card);
        fancards.set(userId, arr);
        return card;
      },
      async byUser(userId) { return fancards.get(userId) || []; },
    },
    subscribers: {
      async has(email) { return subscribers.has(email); },
      async add(s) { subscribers.set(s.email, s); return s; },
      async all() { return [...subscribers.values()].sort(byCreatedDesc); },
      async emails() { return [...subscribers.keys()]; },
    },
    settings: {
      async get(key, fallback = null) { return settings.has(key) ? settings.get(key) : fallback; },
      async set(key, value) { settings.set(key, value); return value; },
    },
  };
}

/* ── Postgres backend ───────────────────────────────────── */
async function postgresStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      data  JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id         TEXT PRIMARY KEY,
      ref        TEXT,
      email      TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      data       JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fancards (
      id         BIGSERIAL PRIMARY KEY,
      user_id    TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      data       JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscribers (
      email      TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      data       JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS editions (
      k TEXT PRIMARY KEY,
      n INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS celebrities (
      id         TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      data       JSONB NOT NULL,
      photo      BYTEA,
      photo_mime TEXT
    );
    CREATE TABLE IF NOT EXISTS testimonials (
      id         TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      data       JSONB NOT NULL,
      photo      BYTEA,
      photo_mime TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fancard_orders (
      ref        TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now(),
      paid_at    TIMESTAMPTZ,
      data       JSONB NOT NULL,
      photo      BYTEA,
      photo_mime TEXT
    );
    CREATE TABLE IF NOT EXISTS payment_attempts (
      id                       TEXT PRIMARY KEY,
      order_type               TEXT NOT NULL,
      order_ref                TEXT NOT NULL,
      method                   TEXT NOT NULL,
      asset                    TEXT,
      network                  TEXT,
      token_identifier         TEXT,
      environment              TEXT NOT NULL DEFAULT 'live',
      destination_snapshot     JSONB,
      expected_amount          NUMERIC,
      expected_currency        TEXT,
      expected_crypto_amount   NUMERIC,
      rate_source              TEXT,
      rate_timestamp           TIMESTAMPTZ,
      provider_transaction_id  TEXT,
      txid                     TEXT,
      sender_name              TEXT,
      bank_reference           TEXT,
      receipt                  BYTEA,
      receipt_mime             TEXT,
      status                   TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
      failure_reason           TEXT,
      verification_result      JSONB,
      expires_at               TIMESTAMPTZ,
      verified_at              TIMESTAMPTZ,
      approved_at              TIMESTAMPTZ,
      approved_by              TEXT,
      rejected_at              TIMESTAMPTZ,
      rejected_by              TEXT,
      rejection_reason         TEXT,
      created_at               TIMESTAMPTZ DEFAULT now(),
      updated_at               TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_txid_uniq
      ON payment_attempts (txid) WHERE txid IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_provider_tx_uniq
      ON payment_attempts (provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS payment_attempts_order_idx
      ON payment_attempts (order_type, order_ref);
    CREATE TABLE IF NOT EXISTS payment_audit_log (
      id                 BIGSERIAL PRIMARY KEY,
      event              TEXT NOT NULL,
      order_type         TEXT,
      order_ref          TEXT,
      payment_attempt_id TEXT,
      actor_type         TEXT NOT NULL,
      actor_id           TEXT,
      metadata           JSONB,
      created_at         TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS payment_audit_log_order_idx
      ON payment_audit_log (order_type, order_ref);
    CREATE INDEX IF NOT EXISTS payment_audit_log_attempt_idx
      ON payment_audit_log (payment_attempt_id);
  `);

  const q = (text, params) => pool.query(text, params);

  // camelCase (app) ↔ snake_case (db) mapping for payment_attempts. Used both to
  // build the row returned to callers and to whitelist which columns a patch
  // object may touch — patch keys not in this map are silently ignored, so a
  // caller can never write to an arbitrary column.
  const ATTEMPT_FIELD_MAP = {
    environment: 'environment',
    destinationSnapshot: 'destination_snapshot',
    expectedAmount: 'expected_amount',
    expectedCurrency: 'expected_currency',
    expectedCryptoAmount: 'expected_crypto_amount',
    rateSource: 'rate_source',
    rateTimestamp: 'rate_timestamp',
    providerTransactionId: 'provider_transaction_id',
    txid: 'txid',
    senderName: 'sender_name',
    bankReference: 'bank_reference',
    failureReason: 'failure_reason',
    verificationResult: 'verification_result',
    expiresAt: 'expires_at',
    verifiedAt: 'verified_at',
    approvedAt: 'approved_at',
    approvedBy: 'approved_by',
    rejectedAt: 'rejected_at',
    rejectedBy: 'rejected_by',
    rejectionReason: 'rejection_reason',
  };
  const JSONB_FIELDS = new Set(['destinationSnapshot', 'verificationResult']);

  function attemptRowToObj(row) {
    if (!row) return null;
    return {
      id: row.id, orderType: row.order_type, orderRef: row.order_ref, method: row.method,
      asset: row.asset, network: row.network, tokenIdentifier: row.token_identifier,
      environment: row.environment, destinationSnapshot: row.destination_snapshot,
      expectedAmount: row.expected_amount, expectedCurrency: row.expected_currency,
      expectedCryptoAmount: row.expected_crypto_amount, rateSource: row.rate_source,
      rateTimestamp: row.rate_timestamp, providerTransactionId: row.provider_transaction_id,
      txid: row.txid, senderName: row.sender_name, bankReference: row.bank_reference,
      hasReceipt: !!row.receipt, status: row.status, failureReason: row.failure_reason,
      verificationResult: row.verification_result, expiresAt: row.expires_at,
      verifiedAt: row.verified_at, approvedAt: row.approved_at, approvedBy: row.approved_by,
      rejectedAt: row.rejected_at, rejectedBy: row.rejected_by, rejectionReason: row.rejection_reason,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // Builds a safe "col = $n" SET fragment from a whitelisted patch object.
  // receipt/receiptMime are handled by the caller separately (bytea pair).
  function buildAttemptSet(patch, startIndex) {
    const sets = [];
    const values = [];
    let i = startIndex;
    for (const [key, val] of Object.entries(patch)) {
      const col = ATTEMPT_FIELD_MAP[key];
      if (!col) continue;
      if (JSONB_FIELDS.has(key)) {
        sets.push(`${col} = $${i}::jsonb`);
        values.push(val === undefined ? null : JSON.stringify(val));
      } else {
        sets.push(`${col} = $${i}`);
        values.push(val === undefined ? null : val);
      }
      i++;
    }
    return { sets, values };
  }

  return {
    persistent: true,
    editions: {
      async next(key) {
        const r = await q(
          'INSERT INTO editions(k, n) VALUES($1, 1) ON CONFLICT(k) DO UPDATE SET n = editions.n + 1 RETURNING n',
          [key]
        );
        return r.rows[0].n;
      },
    },
    users: {
      async findByEmail(email) {
        const r = await q('SELECT data FROM users WHERE email = $1', [email]);
        return r.rows[0]?.data || null;
      },
      async create(u) {
        await q('INSERT INTO users(email, data) VALUES($1, $2) ON CONFLICT(email) DO NOTHING', [u.email, u]);
        return u;
      },
      async update(email, patch) {
        const r = await q('UPDATE users SET data = data || $2::jsonb WHERE email = $1 RETURNING data', [email, JSON.stringify(patch)]);
        return r.rows[0]?.data || null;
      },
    },
    bookings: {
      async create(b) {
        await q('INSERT INTO bookings(id, ref, email, data) VALUES($1, $2, $3, $4)', [b.id, b.ref, b.email, b]);
        return b;
      },
      async getById(id) {
        const r = await q('SELECT data FROM bookings WHERE id = $1', [id]);
        return r.rows[0]?.data || null;
      },
      async getByRef(ref) {
        const r = await q('SELECT data FROM bookings WHERE ref = $1', [ref]);
        return r.rows[0]?.data || null;
      },
      async update(id, patch) {
        const r = await q('UPDATE bookings SET data = data || $2::jsonb WHERE id = $1 RETURNING data', [id, JSON.stringify(patch)]);
        return r.rows[0]?.data || null;
      },
      async updateByRef(ref, patch) {
        const r = await q('UPDATE bookings SET data = data || $2::jsonb WHERE ref = $1 RETURNING data', [ref, JSON.stringify(patch)]);
        return r.rows[0]?.data || null;
      },
      async all() {
        const r = await q('SELECT data FROM bookings ORDER BY created_at DESC');
        return r.rows.map(row => row.data);
      },
      async byEmail(email) {
        const r = await q('SELECT data FROM bookings WHERE email = $1 ORDER BY created_at DESC', [email]);
        return r.rows.map(row => row.data);
      },
    },
    fancards: {
      async add(userId, card) {
        await q('INSERT INTO fancards(user_id, data) VALUES($1, $2)', [userId, card]);
        return card;
      },
      async byUser(userId) {
        const r = await q('SELECT data FROM fancards WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        return r.rows.map(row => row.data);
      },
    },
    subscribers: {
      async has(email) {
        const r = await q('SELECT 1 FROM subscribers WHERE email = $1', [email]);
        return r.rowCount > 0;
      },
      async add(s) {
        await q('INSERT INTO subscribers(email, data) VALUES($1, $2) ON CONFLICT(email) DO NOTHING', [s.email, s]);
        return s;
      },
      async all() {
        const r = await q('SELECT data FROM subscribers ORDER BY created_at DESC');
        return r.rows.map(row => row.data);
      },
      async emails() {
        const r = await q('SELECT email FROM subscribers');
        return r.rows.map(row => row.email);
      },
    },
    celebrities: {
      async all({ onlyVisible = false } = {}) {
        const r = await q(
          `SELECT id, data, (photo IS NOT NULL) AS has_photo FROM celebrities
           ${onlyVisible ? "WHERE (data->>'visible') IS DISTINCT FROM 'false'" : ''}
           ORDER BY created_at DESC`
        );
        return r.rows.map(row => ({ id: row.id, ...row.data, hasPhoto: row.has_photo }));
      },
      async getById(id) {
        const r = await q('SELECT id, data, (photo IS NOT NULL) AS has_photo FROM celebrities WHERE id = $1', [id]);
        if (!r.rows[0]) return null;
        return { id: r.rows[0].id, ...r.rows[0].data, hasPhoto: r.rows[0].has_photo };
      },
      async getPhoto(id) {
        const r = await q('SELECT photo, photo_mime FROM celebrities WHERE id = $1', [id]);
        if (!r.rows[0]?.photo) return null;
        return { buffer: r.rows[0].photo, mime: r.rows[0].photo_mime || 'image/jpeg' };
      },
      async create(c) {
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const { photo, ...data } = c;
        await q(
          'INSERT INTO celebrities(id, data, photo, photo_mime) VALUES($1, $2, $3, $4)',
          [id, { ...data, createdAt }, photo?.buffer || null, photo?.mime || null]
        );
        return { id, ...data, createdAt, hasPhoto: !!photo };
      },
      async update(id, patch) {
        const { photo, ...rest } = patch;
        if (photo !== undefined) {
          await q('UPDATE celebrities SET photo = $2, photo_mime = $3 WHERE id = $1', [id, photo?.buffer || null, photo?.mime || null]);
        }
        if (Object.keys(rest).length) {
          await q('UPDATE celebrities SET data = data || $2::jsonb WHERE id = $1', [id, JSON.stringify(rest)]);
        }
        return this.getById(id);
      },
      async remove(id) {
        const r = await q('DELETE FROM celebrities WHERE id = $1', [id]);
        return r.rowCount > 0;
      },
    },
    testimonials: {
      async all({ onlyVisible = false } = {}) {
        const r = await q(
          `SELECT id, data, (photo IS NOT NULL) AS has_photo FROM testimonials
           ${onlyVisible ? "WHERE (data->>'visible') IS DISTINCT FROM 'false'" : ''}
           ORDER BY created_at DESC`
        );
        return r.rows.map(row => ({ id: row.id, ...row.data, hasPhoto: row.has_photo }));
      },
      async getById(id) {
        const r = await q('SELECT id, data, (photo IS NOT NULL) AS has_photo FROM testimonials WHERE id = $1', [id]);
        if (!r.rows[0]) return null;
        return { id: r.rows[0].id, ...r.rows[0].data, hasPhoto: r.rows[0].has_photo };
      },
      async getPhoto(id) {
        const r = await q('SELECT photo, photo_mime FROM testimonials WHERE id = $1', [id]);
        if (!r.rows[0]?.photo) return null;
        return { buffer: r.rows[0].photo, mime: r.rows[0].photo_mime || 'image/jpeg' };
      },
      async create(t) {
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const { photo, ...data } = t;
        await q(
          'INSERT INTO testimonials(id, data, photo, photo_mime) VALUES($1, $2, $3, $4)',
          [id, { ...data, createdAt }, photo?.buffer || null, photo?.mime || null]
        );
        return { id, ...data, createdAt, hasPhoto: !!photo };
      },
      async update(id, patch) {
        const { photo, ...rest } = patch;
        if (photo !== undefined) {
          await q('UPDATE testimonials SET photo = $2, photo_mime = $3 WHERE id = $1', [id, photo?.buffer || null, photo?.mime || null]);
        }
        if (Object.keys(rest).length) {
          await q('UPDATE testimonials SET data = data || $2::jsonb WHERE id = $1', [id, JSON.stringify(rest)]);
        }
        return this.getById(id);
      },
      async remove(id) {
        const r = await q('DELETE FROM testimonials WHERE id = $1', [id]);
        return r.rowCount > 0;
      },
    },
    fancardOrders: {
      async create(o) {
        const { photo, ref, ...data } = o;
        const createdAt = new Date().toISOString();
        await q(
          'INSERT INTO fancard_orders(ref, status, data, photo, photo_mime) VALUES($1, $2, $3, $4, $5)',
          [ref, 'pending', { ...data, ref, createdAt }, photo?.buffer || null, photo?.mime || null]
        );
        return { ref, status: 'pending', createdAt, ...data, hasPhoto: !!photo };
      },
      async getByRef(ref) {
        const r = await q('SELECT status, data, paid_at, photo, photo_mime FROM fancard_orders WHERE ref = $1', [ref]);
        if (!r.rows[0]) return null;
        const row = r.rows[0];
        return {
          ...row.data, ref, status: row.status, paidAt: row.paid_at,
          photo: row.photo ? { buffer: row.photo, mime: row.photo_mime || 'image/jpeg' } : null,
        };
      },
      async getPhoto(ref) {
        const r = await q('SELECT photo, photo_mime FROM fancard_orders WHERE ref = $1', [ref]);
        if (!r.rows[0]?.photo) return null;
        return { buffer: r.rows[0].photo, mime: r.rows[0].photo_mime || 'image/jpeg' };
      },
      async markPaid(ref, patch = {}) {
        await q(
          `UPDATE fancard_orders
           SET status = 'paid', paid_at = now(), data = data || $2::jsonb
           WHERE ref = $1`,
          [ref, JSON.stringify(patch)]
        );
        return this.getByRef(ref);
      },
      async all() {
        const r = await q('SELECT ref, status, data, paid_at, (photo IS NOT NULL) AS has_photo FROM fancard_orders ORDER BY created_at DESC');
        return r.rows.map(row => ({ ...row.data, ref: row.ref, status: row.status, paidAt: row.paid_at, hasPhoto: row.has_photo }));
      },
    },
    paymentAttempts: {
      async create(a) {
        const id = randomUUID();
        const r = await q(
          `INSERT INTO payment_attempts
            (id, order_type, order_ref, method, asset, network, token_identifier, environment,
             destination_snapshot, expected_amount, expected_currency, expected_crypto_amount,
             rate_source, rate_timestamp, status, expires_at, receipt, receipt_mime)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           RETURNING *`,
          [
            id, a.orderType, a.orderRef, a.method, a.asset || null, a.network || null,
            a.tokenIdentifier || null, a.environment || 'live',
            a.destinationSnapshot ? JSON.stringify(a.destinationSnapshot) : null,
            a.expectedAmount ?? null, a.expectedCurrency || null, a.expectedCryptoAmount ?? null,
            a.rateSource || null, a.rateTimestamp || null, a.status || 'PENDING_PAYMENT',
            a.expiresAt || null, a.receipt?.buffer || null, a.receipt?.mime || null,
          ]
        );
        return attemptRowToObj(r.rows[0]);
      },
      async getById(id) {
        const r = await q('SELECT * FROM payment_attempts WHERE id = $1', [id]);
        return attemptRowToObj(r.rows[0]);
      },
      async getReceipt(id) {
        const r = await q('SELECT receipt, receipt_mime FROM payment_attempts WHERE id = $1', [id]);
        if (!r.rows[0]?.receipt) return null;
        return { buffer: r.rows[0].receipt, mime: r.rows[0].receipt_mime || 'application/octet-stream' };
      },
      async getByOrder(orderType, orderRef) {
        const r = await q(
          'SELECT * FROM payment_attempts WHERE order_type = $1 AND order_ref = $2 ORDER BY created_at DESC',
          [orderType, orderRef]
        );
        return r.rows.map(attemptRowToObj);
      },
      async getByTxid(txid) {
        const r = await q('SELECT * FROM payment_attempts WHERE txid = $1', [txid]);
        return attemptRowToObj(r.rows[0]);
      },
      async getByProviderTransactionId(providerTransactionId) {
        const r = await q('SELECT * FROM payment_attempts WHERE provider_transaction_id = $1', [providerTransactionId]);
        return attemptRowToObj(r.rows[0]);
      },
      async transitionStatus(id, fromStatuses, toStatus, patch = {}) {
        const { receipt, ...restPatch } = patch;
        const { sets, values } = buildAttemptSet(restPatch, 4);
        if (receipt !== undefined) {
          sets.push(`receipt = $${values.length + 4}`, `receipt_mime = $${values.length + 5}`);
          values.push(receipt?.buffer || null, receipt?.mime || null);
        }
        const setClause = sets.length ? ', ' + sets.join(', ') : '';
        const r = await q(
          `UPDATE payment_attempts
           SET status = $2, updated_at = now()${setClause}
           WHERE id = $1 AND status = ANY($3)
           RETURNING *`,
          [id, toStatus, fromStatuses, ...values]
        );
        return attemptRowToObj(r.rows[0]);
      },
      async update(id, patch) {
        const { receipt, ...restPatch } = patch;
        const { sets, values } = buildAttemptSet(restPatch, 2);
        if (receipt !== undefined) {
          sets.push(`receipt = $${values.length + 2}`, `receipt_mime = $${values.length + 3}`);
          values.push(receipt?.buffer || null, receipt?.mime || null);
        }
        if (!sets.length) return this.getById(id);
        const r = await q(
          `UPDATE payment_attempts SET updated_at = now(), ${sets.join(', ')} WHERE id = $1 RETURNING *`,
          [id, ...values]
        );
        return attemptRowToObj(r.rows[0]);
      },
      async all({ status, orderType } = {}) {
        const clauses = [];
        const params = [];
        if (status) {
          params.push(Array.isArray(status) ? status : [status]);
          clauses.push(`status = ANY($${params.length})`);
        }
        if (orderType) {
          params.push(orderType);
          clauses.push(`order_type = $${params.length}`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const r = await q(`SELECT * FROM payment_attempts ${where} ORDER BY created_at DESC`, params);
        return r.rows.map(attemptRowToObj);
      },
      async sweepExpired() {
        const r = await q(
          `UPDATE payment_attempts SET status = 'EXPIRED', updated_at = now()
           WHERE status = 'PENDING_PAYMENT' AND expires_at IS NOT NULL AND expires_at < now()
           RETURNING *`
        );
        return r.rows.map(attemptRowToObj);
      },
    },
    paymentAuditLog: {
      async append(event) {
        const r = await q(
          `INSERT INTO payment_audit_log (event, order_type, order_ref, payment_attempt_id, actor_type, actor_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
          [
            event.event, event.orderType || null, event.orderRef || null,
            event.paymentAttemptId || null, event.actorType, event.actorId || null,
            event.metadata ? JSON.stringify(event.metadata) : null,
          ]
        );
        const row = r.rows[0];
        return { id: row.id, event: row.event, orderType: row.order_type, orderRef: row.order_ref, paymentAttemptId: row.payment_attempt_id, actorType: row.actor_type, actorId: row.actor_id, metadata: row.metadata, createdAt: row.created_at };
      },
      async byOrder(orderType, orderRef) {
        const r = await q('SELECT * FROM payment_audit_log WHERE order_type = $1 AND order_ref = $2 ORDER BY created_at DESC', [orderType, orderRef]);
        return r.rows.map(row => ({ id: row.id, event: row.event, orderType: row.order_type, orderRef: row.order_ref, paymentAttemptId: row.payment_attempt_id, actorType: row.actor_type, actorId: row.actor_id, metadata: row.metadata, createdAt: row.created_at }));
      },
      async byPaymentAttempt(paymentAttemptId) {
        const r = await q('SELECT * FROM payment_audit_log WHERE payment_attempt_id = $1 ORDER BY created_at DESC', [paymentAttemptId]);
        return r.rows.map(row => ({ id: row.id, event: row.event, orderType: row.order_type, orderRef: row.order_ref, paymentAttemptId: row.payment_attempt_id, actorType: row.actor_type, actorId: row.actor_id, metadata: row.metadata, createdAt: row.created_at }));
      },
      async recent(limit = 200) {
        const r = await q('SELECT * FROM payment_audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
        return r.rows.map(row => ({ id: row.id, event: row.event, orderType: row.order_type, orderRef: row.order_ref, paymentAttemptId: row.payment_attempt_id, actorType: row.actor_type, actorId: row.actor_id, metadata: row.metadata, createdAt: row.created_at }));
      },
    },
    settings: {
      async get(key, fallback = null) {
        const r = await q('SELECT value FROM settings WHERE key = $1', [key]);
        return r.rows[0] ? r.rows[0].value : fallback;
      },
      async set(key, value) {
        await q(
          'INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2',
          [key, JSON.stringify(value)]
        );
        return value;
      },
    },
  };
}

async function createStore() {
  if (DATABASE_URL) {
    const store = await postgresStore();
    console.log('[store] Postgres connected — data is persistent.');
    return store;
  }
  console.warn('[store] DATABASE_URL not set — using in-memory store. Data will NOT survive restarts.');
  return memoryStore();
}

module.exports = { createStore };
