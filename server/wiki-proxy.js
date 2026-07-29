'use strict';

/*
 * Proxies Wikipedia celebrity photo lookups through our own server so a
 * visitor's browser never talks to Wikipedia/Wikimedia directly — without
 * this, simply loading the homepage or fan card picker sent every visitor's
 * IP address straight to Wikimedia's servers for every celebrity photo shown.
 */
const https = require('https');

const UA = 'Rezoro/1.0 (https://rezoro.pro; wikipedia proxy)';
const NET_TIMEOUT = 10000;
// Only Wikimedia's own image host is ever fetched — the client supplies a
// URL to /api/wiki-image, but it's validated against this allow-list before
// any request is made, so this can never become an open proxy for arbitrary
// URLs (SSRF).
const ALLOWED_IMAGE_HOSTS = ['upload.wikimedia.org'];

function httpGet(url, { redirectsLeft = 4 } = {}) {
  return new Promise((resolve) => {
    if (!url || redirectsLeft < 0) return resolve(null);
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };

    const req = https.get(url, { headers: { 'User-Agent': UA }, timeout: NET_TIMEOUT }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpGet(next, { redirectsLeft: redirectsLeft - 1 }).then(done);
      }
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => done({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || null }));
      res.on('error', () => done(null));
    });

    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

/*
 * Fetches a Wikipedia page summary server-side and rewrites any image URLs
 * in it to point at our own /api/wiki-image proxy instead of Wikimedia
 * directly, so the browser's subsequent <img> request never leaves our site.
 */
async function getWikiSummary(slug) {
  if (!slug || slug.length > 200) return null;
  const result = await httpGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`);
  if (!result) return null;
  let data;
  try { data = JSON.parse(result.buffer.toString('utf8')); } catch { return null; }

  const proxied = { thumbnail: null, originalimage: null };
  if (data.thumbnail?.source) proxied.thumbnail = { source: `/api/wiki-image?u=${encodeURIComponent(data.thumbnail.source)}` };
  if (data.originalimage?.source) proxied.originalimage = { source: `/api/wiki-image?u=${encodeURIComponent(data.originalimage.source)}` };
  return proxied;
}

async function fetchWikiImage(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) return null;
  return httpGet(parsed.toString());
}

module.exports = { getWikiSummary, fetchWikiImage };
