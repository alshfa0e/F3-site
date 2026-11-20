'use strict';
// f3 drop server, v2: daily rooms.
// A device opens f3.sa/code and gets a room for the day. Its other device joins with a
// 4-character code (10 minutes, one use). Snippets are locked in the browser; this server
// only holds locked bytes, in memory, for 5 minutes at most. Rooms end after 24 hours.
// Stats are counts only (no addresses, no content), kept for 30 days in one small file.
// No dependencies; Node 18+.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const CFG = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',
  allowOrigin: process.env.ALLOW_ORIGIN || 'https://f3.sa',
  dataDir: process.env.DATA_DIR || '/var/lib/f3drop',
  itemTtlMs: num(process.env.ITEM_TTL_MS, 5 * 60 * 1000),       // uncopied snippets die after 5 minutes
  roomTtlMs: num(process.env.ROOM_TTL_MS, 24 * 60 * 60 * 1000),  // rooms end after one day
  codeTtlMs: num(process.env.CODE_TTL_MS, 10 * 60 * 1000),       // join codes work for 10 minutes, once
  maxBody: num(process.env.MAX_BODY, 14 * 1024 * 1024),       // one item: 10 MB locked, as base64 text
  maxRooms: num(process.env.MAX_ROOMS, 200),
  roomsPerIpDay: num(process.env.ROOMS_PER_IP_DAY, 10),
  maxItemsPerRoom: num(process.env.MAX_ITEMS, 30),
  maxRoomBytes: num(process.env.MAX_ROOM_BYTES, 40 * 1024 * 1024),
  maxTotal: num(process.env.MAX_TOTAL, 100 * 1024 * 1024),   // all rooms; the service may use 300 MB in total
  joinFailsPerIp: num(process.env.JOIN_FAILS_PER_IP, 10),        // wrong codes per address per hour
  joinFailsGlobal: num(process.env.JOIN_FAILS_GLOBAL, 30),       // wrong codes from everyone per hour
  joinWindowMs: num(process.env.JOIN_WINDOW_MS, 60 * 60 * 1000),
  authFailLimit: num(process.env.AUTH_FAIL_LIMIT, 30),
  authWindowMs: num(process.env.AUTH_WINDOW_MS, 10 * 60 * 1000),
  visitsPerIpDay: num(process.env.VISITS_PER_IP_DAY, 100),
  statsDays: num(process.env.STATS_DAYS, 30),
  statsSaveMs: num(process.env.STATS_SAVE_MS, 60 * 1000),
  sweepMs: num(process.env.SWEEP_MS, 1000),
  tzOffsetMin: num(process.env.TZ_OFFSET_MIN, 180),              // Riyadh days for the stats page
};
const STATS_FILE = path.join(CFG.dataDir, 'stats.json');
const STATS_AUTH_FILE = path.join(CFG.dataDir, 'stats-auth');

const DEVICES = ['iphone', 'ipad', 'android', 'windows', 'mac', 'linux', 'other'];
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes, base64url
const HEX64 = /^[0-9a-f]{64}$/;

// ---------- state (memory only) ----------
const rooms = new Map();   // id -> { id, created, expires, members:[{tok, dev, joined}], items:Map, bytes, code }
const codes = new Map();   // sha256(tag) hex -> room id
let totalBytes = 0;
const roomsByIp = new Map();   // ip -> { day, count }
const visitsByIp = new Map();  // ip -> { day, count }
const joinFails = new Map();   // ip -> { count, resetAt }
let joinFailsAll = { count: 0, resetAt: 0 };
const authFails = new Map();   // ip -> { count, resetAt }

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const newId = () => crypto.randomBytes(12).toString('base64url');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// ---------- stats (counts only) ----------
function dayKey(t) {
  return new Date(t + CFG.tzOffsetMin * 60000).toISOString().slice(0, 10);
}
const blankDay = () => ({ visits: 0, dev: {}, rooms: 0, joins: 0, wrong: 0, sent: 0, copied: 0, expired: 0, ended: 0, limited: 0 });
let stats = {};
let statsDirty = false;
try {
  const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  if (s && typeof s === 'object' && s.days && typeof s.days === 'object') stats = s.days;
} catch (_) { stats = {}; }

function bump(field, by = 1, dev) {
  const k = dayKey(Date.now());
  const d = stats[k] || (stats[k] = blankDay());
  if (field === 'visits' && dev) d.dev[dev] = (d.dev[dev] || 0) + by;
  d[field] = (d[field] || 0) + by;
  statsDirty = true;
}

function pruneStats() {
  const keep = new Set();
  for (let i = 0; i < CFG.statsDays; i++) keep.add(dayKey(Date.now() - i * 86400000));
  for (const k of Object.keys(stats)) if (!keep.has(k)) delete stats[k];
}

function saveStats() {
  if (!statsDirty) return;
  pruneStats();
  try {
    const tmp = path.join(CFG.dataDir, '.stats.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, days: stats }), { mode: 0o600 });
    fs.renameSync(tmp, STATS_FILE);
    statsDirty = false;
  } catch (_) { /* best effort; counts stay in memory */ }
}

function readStatsHash() {
  try {
    const h = fs.readFileSync(STATS_AUTH_FILE, 'utf8').trim().toLowerCase();
    return HEX64.test(h) ? h : null;
  } catch (_) { return null; }
}
let statsHash = readStatsHash();

// Last result of the auto-updater (written by /usr/local/bin/f3drop-update), shown on /health.
function updateStatus() {
  try {
    const [at, result] = fs.readFileSync(path.join(CFG.dataDir, 'update-status'), 'utf8').trim().split(/\s+/);
    if (/^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(at) && /^[a-z-]{1,20}$/.test(result)) return { at, result };
  } catch (_) { /* no updater run yet */ }
  return null;
}

// ---------- rooms ----------
function dropItem(room, id, why) {
  const it = room.items.get(id);
  if (!it) return false;
  room.items.delete(id);
  room.bytes -= it.size;
  totalBytes -= it.size;
  if (why) bump(why);
  return true;
}

function dropCode(room) {
  if (room.code) codes.delete(room.code.tagHash);
  room.code = null;
}

function dropRoom(id) {
  const room = rooms.get(id);
  if (!room) return false;
  for (const iid of [...room.items.keys()]) dropItem(room, iid);
  dropCode(room);
  rooms.delete(id);
  return true;
}

function sweep() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.expires <= now) { dropRoom(room.id); continue; }
    for (const [iid, it] of room.items) if (it.expires <= now) dropItem(room, iid, 'expired');
    if (room.code && room.code.expires <= now) dropCode(room);
  }
  for (const m of [joinFails, authFails]) for (const [ip, f] of m) if (f.resetAt <= now) m.delete(ip);
  const today = dayKey(now);
  for (const m of [roomsByIp, visitsByIp]) for (const [ip, v] of m) if (v.day !== today) m.delete(ip);
}

// ---------- request helpers ----------
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (local && xff) return String(xff).split(',')[0].trim();
  return remote;
}

function over(map, ip, limit) {
  const f = map.get(ip);
  return !!f && f.resetAt > Date.now() && f.count >= limit;
}

function note(map, ip, windowMs) {
  const now = Date.now();
  const f = map.get(ip);
  if (!f || f.resetAt <= now) map.set(ip, { count: 1, resetAt: now + windowMs });
  else f.count += 1;
}

function dailyCount(map, ip) {
  const today = dayKey(Date.now());
  const v = map.get(ip);
  if (!v || v.day !== today) { map.set(ip, { day: today, count: 0 }); return map.get(ip); }
  return v;
}

function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
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
  if (body === undefined) { res.writeHead(status); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Small requests get a small cap; only sending an item may use the big one.
function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] || 0) > limit) return resolve({ error: 413 });
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ error: 413 });
      try { resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {} }); }
      catch (_) { resolve({ error: 400 }); }
    });
    req.on('error', () => resolve({ error: 400 }));
  });
}

const devOf = (v) => (DEVICES.includes(v) ? v : 'other');

function roomView(room, me) {
  return {
    now: Date.now(),
    room: room.id,
    expires: room.expires,
    itemTtl: CFG.itemTtlMs,
    me: me.dev,
    others: room.members.filter((m) => m !== me).map((m) => ({ dev: m.dev, joined: m.joined })),
    code: room.code ? { expires: room.code.expires, mine: room.code.by === me.tok } : null,
    // Only the list here. Each device fetches an item's locked bytes once, by id, so polling stays light.
    items: [...room.items.entries()]
      .map(([id, it]) => ({ id, size: it.size, created: it.created, expires: it.expires }))
      .sort((a, b) => b.created - a.created),
  };
}

// Finds the room and checks the device token. Returns { room, me } or sends an error.
function member(req, res, ip, id) {
  const tok = bearer(req);
  const room = ID_RE.test(id) ? rooms.get(id) : null;
  if (!room) {
    note(authFails, ip, CFG.authWindowMs);
    send(res, 404, { error: 'room_gone' });
    return null;
  }
  const h = tok ? sha(tok) : '';
  const me = h ? room.members.find((m) => safeEq(m.tok, h)) : null;
  if (!me) {
    note(authFails, ip, CFG.authWindowMs);
    send(res, 401, { error: 'not_in_room' });
    return null;
  }
  return { room, me };
}

// ---------- routes ----------
async function handle(req, res) {
  baseHeaders(req, res);
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const origin = req.headers.origin;
  if (origin && origin !== CFG.allowOrigin) return send(res, 403, { error: 'origin' });
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, v: 2, stats: !!statsHash, update: updateStatus() });
  if (!p.startsWith('/v1/')) return send(res, 404, { error: 'not_found' });

  const ip = clientIp(req);
  sweep();

  // Page visit (counted, nothing else kept).
  if (p === '/v1/hello' && req.method === 'POST') {
    const body = await readJson(req);
    const v = dailyCount(visitsByIp, ip);
    if (v.count < CFG.visitsPerIpDay) {
      v.count += 1;
      bump('visits', 1, devOf(body.value && body.value.dev));
    }
    return send(res, 204);
  }

  // Join a room with a code.
  if (p === '/v1/join' && req.method === 'POST') {
    const now = Date.now();
    if (joinFailsAll.resetAt <= now) joinFailsAll = { count: 0, resetAt: now + CFG.joinWindowMs };
    if (joinFailsAll.count >= CFG.joinFailsGlobal || over(joinFails, ip, CFG.joinFailsPerIp)) {
      bump('limited');
      return send(res, 429, { error: 'join_locked' });
    }
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: 'bad_request' });
    const { tag, dev } = body.value;
    const roomId = typeof tag === 'string' && TAG_RE.test(tag) ? codes.get(sha(tag)) : undefined;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !room.code || room.code.expires <= now) {
      note(joinFails, ip, CFG.joinWindowMs);
      joinFailsAll.count += 1;
      bump('wrong');
      return send(res, 404, { error: 'bad_code' });
    }
    const code = room.code;
    const owner = room.members.find((m) => m.tok === code.by);
    const tok = crypto.randomBytes(32).toString('base64url');
    const joiner = { tok: sha(tok), dev: devOf(dev), joined: now };
    room.members = owner ? [owner, joiner] : [joiner];   // two devices: the code maker and the joiner
    dropCode(room);
    bump('joins');
    return send(res, 200, { room: room.id, token: tok, iv: code.iv, wrapped: code.wrapped, expires: room.expires, now });
  }

  // Start a room for this device.
  if (p === '/v1/rooms' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: 'bad_request' });
    const c = dailyCount(roomsByIp, ip);
    if (c.count >= CFG.roomsPerIpDay) { bump('limited'); return send(res, 429, { error: 'too_many_rooms' }); }
    if (rooms.size >= CFG.maxRooms) { bump('limited'); return send(res, 503, { error: 'full' }); }
    c.count += 1;
    const now = Date.now();
    const tok = crypto.randomBytes(32).toString('base64url');
    const room = {
      id: newId(), created: now, expires: now + CFG.roomTtlMs,
      members: [{ tok: sha(tok), dev: devOf(body.value.dev), joined: now }],
      items: new Map(), bytes: 0, code: null,
    };
    rooms.set(room.id, room);
    bump('rooms');
    return send(res, 201, { room: room.id, token: tok, expires: room.expires, now });
  }

  // Stats: claim once, then read with the private link.
  if (p === '/v1/stats/claim' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: 'bad_request' });
    const h = String(body.value.hash || '').toLowerCase();
    if (!HEX64.test(h)) return send(res, 400, { error: 'bad_request' });
    if (statsHash || readStatsHash()) return send(res, 409, { error: 'already_claimed' });
    try {
      fs.writeFileSync(STATS_AUTH_FILE, h + '\n', { mode: 0o600, flag: 'wx' });
    } catch (_) {
      return send(res, 409, { error: 'already_claimed' });
    }
    statsHash = h;
    return send(res, 201, { ok: true });
  }

  if (p === '/v1/stats' && req.method === 'GET') {
    if (over(authFails, ip, CFG.authFailLimit)) return send(res, 429, { error: 'too_many_attempts' });
    const tok = bearer(req);
    if (!statsHash || !tok || !safeEq(sha(tok), statsHash)) {
      note(authFails, ip, CFG.authWindowMs);
      return send(res, 401, { error: 'bad_link' });
    }
    pruneStats();
    let paired = 0;
    let waiting = 0;
    for (const r of rooms.values()) { if (r.members.length > 1) paired += 1; waiting += r.items.size; }
    const days = Object.keys(stats).sort().reverse().map((date) => ({ date, ...stats[date] }));
    return send(res, 200, { now: Date.now(), live: { rooms: rooms.size, paired, items: waiting }, days });
  }

  // Everything below needs a room and a device token.
  const m = /^\/v1\/rooms\/([^/]+)(\/code|\/items(?:\/([^/]+))?)?$/.exec(p);
  if (!m) return send(res, 404, { error: 'not_found' });
  if (over(authFails, ip, CFG.authFailLimit)) return send(res, 429, { error: 'too_many_attempts' });
  const auth = member(req, res, ip, m[1]);
  if (!auth) return;
  const { room, me } = auth;
  const sub = m[2] || '';

  if (sub === '' && req.method === 'GET') return send(res, 200, roomView(room, me));

  if (sub === '' && req.method === 'DELETE') {
    dropRoom(room.id);
    bump('ended');
    return send(res, 204);
  }

  if (sub === '/code' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: 'bad_request' });
    const { tag, iv, wrapped } = body.value;
    if (typeof tag !== 'string' || !TAG_RE.test(tag)) return send(res, 400, { error: 'bad_request' });
    if (typeof iv !== 'string' || iv.length !== 16 || !B64URL.test(iv)) return send(res, 400, { error: 'bad_request' });
    if (typeof wrapped !== 'string' || wrapped.length < 40 || wrapped.length > 200 || !B64URL.test(wrapped)) {
      return send(res, 400, { error: 'bad_request' });
    }
    const tagHash = sha(tag);
    const holder = codes.get(tagHash);
    if (holder && holder !== room.id) return send(res, 409, { error: 'code_taken' }); // rare: pick another code
    dropCode(room);
    room.code = { tagHash, iv, wrapped, by: me.tok, expires: Math.min(Date.now() + CFG.codeTtlMs, room.expires) };
    codes.set(tagHash, room.id);
    return send(res, 201, { expires: room.code.expires });
  }

  if (sub === '/items' && req.method === 'POST') {
    const body = await readJson(req, CFG.maxBody);
    if (body.error) return send(res, body.error, { error: body.error === 413 ? 'too_big' : 'bad_request' });
    const { iv, ct } = body.value;
    if (typeof iv !== 'string' || iv.length !== 16 || !B64URL.test(iv)) return send(res, 400, { error: 'bad_request' });
    if (typeof ct !== 'string' || ct.length < 24 || !B64URL.test(ct)) return send(res, 400, { error: 'bad_request' });
    const size = iv.length + ct.length;
    if (room.items.size >= CFG.maxItemsPerRoom || room.bytes + size > CFG.maxRoomBytes) return send(res, 409, { error: 'room_full' });
    if (totalBytes + size > CFG.maxTotal) return send(res, 503, { error: 'server_full' });
    const id = newId();
    const created = Date.now();
    const expires = Math.min(created + CFG.itemTtlMs, room.expires);
    room.items.set(id, { iv, ct, created, expires, size });
    room.bytes += size;
    totalBytes += size;
    bump('sent');
    return send(res, 201, { id, created, expires });
  }

  if (sub.startsWith('/items/') && req.method === 'GET') {
    const it = ID_RE.test(m[3]) ? room.items.get(m[3]) : null;
    if (!it) return send(res, 404, { error: 'gone' });
    return send(res, 200, { id: m[3], iv: it.iv, ct: it.ct, created: it.created, expires: it.expires });
  }

  if (sub.startsWith('/items/') && req.method === 'DELETE') {
    const iid = m[3];
    if (!ID_RE.test(iid)) return send(res, 404, { error: 'gone' });
    const copied = url.searchParams.get('copied') === '1';
    return dropItem(room, iid, copied ? 'copied' : null) ? send(res, 204) : send(res, 404, { error: 'gone' });
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
server.requestTimeout = 5 * 60 * 1000; // a 10 MB upload on a slow phone link can take minutes
server.on('clientError', (_e, socket) => socket.destroy());

setInterval(sweep, CFG.sweepMs).unref();
setInterval(saveStats, CFG.statsSaveMs).unref();

server.listen(CFG.port, CFG.host, () => {
  // Startup line only. Nothing about requests, addresses or content is ever printed.
  process.stdout.write(`f3drop v2 listening on ${CFG.host}:${server.address().port}\n`);
});

function shutdown() {
  saveStats();
  for (const id of [...rooms.keys()]) dropRoom(id);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
