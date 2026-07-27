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
  `);

  const q = (text, params) => pool.query(text, params);

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
