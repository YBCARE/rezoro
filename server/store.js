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

const DATABASE_URL = process.env.DATABASE_URL;
const byCreatedDesc = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);

/* ── In-memory backend ──────────────────────────────────── */
function memoryStore() {
  const users = new Map();       // email → user
  const bookings = new Map();    // id → booking
  const fancards = new Map();    // userId → [card, ...]
  const subscribers = new Map(); // email → subscriber

  return {
    persistent: false,
    users: {
      async findByEmail(email) { return users.get(email) || null; },
      async create(u) { users.set(u.email, u); return u; },
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
  `);

  const q = (text, params) => pool.query(text, params);

  return {
    persistent: true,
    users: {
      async findByEmail(email) {
        const r = await q('SELECT data FROM users WHERE email = $1', [email]);
        return r.rows[0]?.data || null;
      },
      async create(u) {
        await q('INSERT INTO users(email, data) VALUES($1, $2) ON CONFLICT(email) DO NOTHING', [u.email, u]);
        return u;
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
