'use strict';
// f3 drop server.
// Holds encrypted snippets in memory only, for a few minutes. It never sees the
// decryption key and never writes snippets to disk. No dependencies; Node 18+.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const CFG = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',
  authFile: process.env.AUTH_FILE || '/var/lib/f3drop/auth',
  allowOrigin: process.env.ALLOW_ORIGIN || 'https://f3.sa',
  ttlMs: num(process.env.TTL_MS, 5 * 60 * 1000),          // uncopied items die after 5 minutes
  maxBody: num(process.env.MAX_BODY, 400 * 1024),          // request body cap (encrypted, base64)
  maxItems: num(process.env.MAX_ITEMS, 50),
  maxTotal: num(process.env.MAX_TOTAL, 16 * 1024 * 1024),
  failLimit: num(process.env.FAIL_LIMIT, 20),              // failed logins per IP per window
  failWindowMs: num(process.env.FAIL_WINDOW_MS, 10 * 60 * 1000),
  sweepMs: num(process.env.SWEEP_MS, 1000),
};

const items = new Map(); // id -> { iv, ct, created, expires, size }
let totalBytes = 0;
const fails = new Map(); // ip -> { count, resetAt }

function readHash() {
  try {
    const h = fs.readFileSync(CFG.authFile, 'utf8').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(h) ? h : null;
  } catch (_) {
    return null;
  }
}
let authHash = readHash();

function writeHash(h) {
  const tmp = path.join(path.dirname(CFG.authFile), '.auth.tmp');
  fs.writeFileSync(tmp, h + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CFG.authFile);
}

function removeItem(id) {
  const it = items.get(id);
  if (!it) return false;
  totalBytes -= it.size;
  items.delete(id);
  return true;
}

function clearAll() {
  items.clear();
  totalBytes = 0;
}

function sweep() {
  const now = Date.now();
  for (const [id, it] of items) if (it.expires <= now) removeItem(id);
  for (const [ip, f] of fails) if (f.resetAt <= now) fails.delete(ip);
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (local && xff) return String(xff).split(',')[0].trim();
  return remote;
}

function blocked(ip) {
  const f = fails.get(ip);
  return !!f && f.resetAt > Date.now() && f.count >= CFG.failLimit;
}

function noteFail(ip) {
  const now = Date.now();
  const f = fails.get(ip);
  if (!f || f.resetAt <= now) fails.set(ip, { count: 1, resetAt: now + CFG.failWindowMs });
  else f.count += 1;
}

function authorized(req) {
  if (!authHash) return false;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1], 'utf8').digest();
  return crypto.timingSafeEqual(got, Buffer.from(authHash, 'hex'));
}

function baseHeaders(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const o = req.headers.origin;
  if (o && o === CFG.allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function readJson(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > CFG.maxBody) return resolve({ error: 413 });
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > CFG.maxBody) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ error: 413 });
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (_) {
        resolve({ error: 400 });
      }
    });
    req.on('error', () => resolve({ error: 400 }));
  });
}

const B64URL = /^[A-Za-z0-9_-]+$/;

async function handle(req, res) {
  baseHeaders(req, res);
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;

  const origin = req.headers.origin;
  if (origin && origin !== CFG.allowOrigin) return send(res, 403, { error: 'origin' });
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, ready: !!authHash });
  if (!p.startsWith('/v1/')) return send(res, 404, { error: 'not_found' });

  const ip = clientIp(req);
  if (blocked(ip)) return send(res, 429, { error: 'too_many_attempts' });
  if (!authHash) return send(res, 503, { error: 'not_set_up' });
  if (!authorized(req)) {
    noteFail(ip);
    return send(res, 401, { error: 'bad_link' });
  }
  fails.delete(ip);
  sweep();

  if (p === '/v1/items' && req.method === 'GET') {
    const list = [...items.entries()]
      .map(([id, it]) => ({ id, iv: it.iv, ct: it.ct, created: it.created, expires: it.expires }))
      .sort((a, b) => b.created - a.created);
    return send(res, 200, { now: Date.now(), ttl: CFG.ttlMs, items: list });
  }

  if (p === '/v1/items' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: body.error === 413 ? 'too_big' : 'bad_request' });
    const { iv, ct } = body.value || {};
    if (typeof iv !== 'string' || iv.length !== 16 || !B64URL.test(iv)) return send(res, 400, { error: 'bad_request' });
    if (typeof ct !== 'string' || ct.length < 24 || !B64URL.test(ct)) return send(res, 400, { error: 'bad_request' });
    if (items.size >= CFG.maxItems) return send(res, 409, { error: 'inbox_full' });
    const size = iv.length + ct.length;
    if (totalBytes + size > CFG.maxTotal) return send(res, 409, { error: 'inbox_full' });
    const id = crypto.randomBytes(12).toString('base64url');
    const created = Date.now();
    const expires = created + CFG.ttlMs;
    items.set(id, { iv, ct, created, expires, size });
    totalBytes += size;
    return send(res, 201, { id, created, expires });
  }

  if (p === '/v1/items' && req.method === 'DELETE') {
    clearAll();
    return send(res, 204);
  }

  const one = /^\/v1\/items\/([A-Za-z0-9_-]{16})$/.exec(p);
  if (one && req.method === 'DELETE') {
    return removeItem(one[1]) ? send(res, 204) : send(res, 404, { error: 'gone' });
  }

  if (p === '/v1/rotate' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: 'bad_request' });
    const h = String((body.value || {}).hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) return send(res, 400, { error: 'bad_request' });
    try {
      writeHash(h);
    } catch (_) {
      return send(res, 500, { error: 'could_not_save' });
    }
    authHash = h;
    clearAll();
    return send(res, 204);
  }

  return send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, { error: 'server' });
    else res.end();
  });
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.on('clientError', (_e, socket) => socket.destroy());

setInterval(sweep, CFG.sweepMs).unref();

server.listen(CFG.port, CFG.host, () => {
  // Startup line only. Nothing about requests or content is ever printed.
  process.stdout.write(`f3drop listening on ${CFG.host}:${server.address().port}\n`);
});

process.on('SIGTERM', () => {
  clearAll();
  server.close(() => process.exit(0));
});
