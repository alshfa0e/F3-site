'use strict';
// Server tests (v2 rooms). Run: node --test drop-server/test/server.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ORIGIN = 'https://f3.sa';
const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function start(env) {
  const dir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'f3drop-'));
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: '0', ALLOW_ORIGIN: ORIGIN, SWEEP_MS: '100', DATA_DIR: dir, ...env },
  });
  return new Promise((resolve, reject) => {
    proc.stdout.once('data', (d) => {
      const m = /:(\d+)/.exec(String(d));
      if (!m) return reject(new Error('no port'));
      resolve({ proc, dir, base: 'http://127.0.0.1:' + m[1] });
    });
    proc.once('exit', (c) => reject(new Error('exited ' + c)));
  });
}

function stop(s) {
  return new Promise((r) => { s.proc.once('exit', r); s.proc.kill('SIGTERM'); });
}

function client(s) {
  return async function call(method, p, { token, body, origin = ORIGIN, raw, ip = 'ip-' + rnd(6) } = {}) {
    const headers = { 'X-Forwarded-For': ip };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (origin) headers.Origin = origin;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(s.base + p, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text, headers: r.headers };
  };
}

const ivct = (n = 40) => ({ iv: rnd(12), ct: rnd(n) });
const codeBox = () => ({ tag: rnd(32), iv: rnd(12), wrapped: rnd(48) });

let A; let call;          // main server
let B; let call2;         // second server: short room life, small caps, global lock
const SEEN_IPS = [];

before(async () => {
  A = await start({ ITEM_TTL_MS: '1500', CODE_TTL_MS: '1500', MAX_ITEMS: '5', MAX_BODY: '4096',
    ROOMS_PER_IP_DAY: '4', JOIN_FAILS_PER_IP: '3', JOIN_FAILS_GLOBAL: '1000', AUTH_FAIL_LIMIT: '5', STATS_SAVE_MS: '200' });
  call = client(A);
  B = await start({ ROOM_TTL_MS: '1500', MAX_ROOMS: '3', JOIN_FAILS_PER_IP: '100', JOIN_FAILS_GLOBAL: '4', VISITS_PER_IP_DAY: '2' });
  call2 = client(B);
});
after(async () => { await stop(A).catch(() => {}); await stop(B).catch(() => {}); });

async function newRoom(c = call, dev = 'iphone', ip) {
  const r = await c('POST', '/v1/rooms', { body: { dev }, ip });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function pair(c = call) {
  const a = await newRoom(c, 'iphone');
  const box = codeBox();
  const k = await c('POST', `/v1/rooms/${a.room}/code`, { token: a.token, body: box });
  assert.equal(k.status, 201);
  const j = await c('POST', '/v1/join', { body: { tag: box.tag, dev: 'windows' } });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { a, b: j.json, box };
}

test('health, origin check, CORS', async () => {
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  assert.equal(h.json.v, 2);
  assert.equal(h.json.stats, false);
  assert.equal((await call('GET', '/health', { origin: 'https://evil.example' })).status, 403);
  const o = await call('OPTIONS', '/v1/rooms');
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(o.headers.get('access-control-allow-methods'), /DELETE/);
});

test('new room: own id and token, lasts 24 hours, starts empty', async () => {
  const a = await newRoom();
  assert.match(a.room, /^[A-Za-z0-9_-]{16}$/);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(a.expires - (a.now + 24 * 3600 * 1000)) < 1000);
  const v = await call('GET', `/v1/rooms/${a.room}`, { token: a.token });
  assert.equal(v.status, 200);
  assert.equal(v.json.me, 'iphone');
  assert.deepEqual(v.json.others, []);
  assert.deepEqual(v.json.items, []);
  assert.equal(v.json.code, null);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: rnd(32) })).status, 401);
  assert.equal((await call('GET', `/v1/rooms/${rnd(12)}`, { token: a.token })).status, 404);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`)).status, 401);
});

test('pair with a code: both see each other; code works once', async () => {
  const { a, b, box } = await pair();
  assert.equal(b.room, a.room);
  assert.equal(b.iv, box.iv);
  assert.equal(b.wrapped, box.wrapped);
  assert.notEqual(b.token, a.token);
  const va = await call('GET', `/v1/rooms/${a.room}`, { token: a.token });
  const vb = await call('GET', `/v1/rooms/${a.room}`, { token: b.token });
  assert.deepEqual(va.json.others.map((o) => o.dev), ['windows']);
  assert.deepEqual(vb.json.others.map((o) => o.dev), ['iphone']);
  assert.equal(va.json.code, null, 'code is used up');
  assert.ok(!/tok/.test(va.text + vb.text), 'no device tokens in room view');
  const again = await call('POST', '/v1/join', { body: { tag: box.tag, dev: 'mac' } });
  assert.equal(again.status, 404, 'same code cannot be used twice');
});

test('code expires after its time', async () => {
  const a = await newRoom();
  const box = codeBox();
  await call('POST', `/v1/rooms/${a.room}/code`, { token: a.token, body: box });
  await sleep(1800);
  assert.equal((await call('POST', '/v1/join', { body: { tag: box.tag } })).status, 404);
});

test('two devices per room: a new join replaces the old partner', async () => {
  const { a, b } = await pair();
  const box = codeBox();
  assert.equal((await call('POST', `/v1/rooms/${a.room}/code`, { token: a.token, body: box })).status, 201);
  const c = await call('POST', '/v1/join', { body: { tag: box.tag, dev: 'mac' } });
  assert.equal(c.status, 200);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: b.token })).status, 401, 'old partner is out');
  const va = await call('GET', `/v1/rooms/${a.room}`, { token: a.token });
  assert.deepEqual(va.json.others.map((o) => o.dev), ['mac']);
});

test('same code in two rooms at once is refused (pick another)', async () => {
  const a = await newRoom();
  const b = await newRoom();
  const box = codeBox();
  assert.equal((await call('POST', `/v1/rooms/${a.room}/code`, { token: a.token, body: box })).status, 201);
  assert.equal((await call('POST', `/v1/rooms/${b.room}/code`, { token: b.token, body: box })).status, 409);
});

test('send, list, copy-delete: gone for both devices', async () => {
  const { a, b } = await pair();
  const s = await call('POST', `/v1/rooms/${a.room}/items`, { token: b.token, body: ivct() });
  assert.equal(s.status, 201);
  const la = await call('GET', `/v1/rooms/${a.room}`, { token: a.token });
  assert.equal(la.json.items.length, 1);
  assert.equal(la.json.items[0].id, s.json.id);
  assert.equal((await call('DELETE', `/v1/rooms/${a.room}/items/${s.json.id}?copied=1`, { token: a.token })).status, 204);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: b.token })).json.items.length, 0);
  assert.equal((await call('DELETE', `/v1/rooms/${a.room}/items/${s.json.id}`, { token: b.token })).status, 404);
});

test('uncopied items are gone after the item time', async () => {
  const { a } = await pair();
  await call('POST', `/v1/rooms/${a.room}/items`, { token: a.token, body: ivct() });
  await sleep(1800);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: a.token })).json.items.length, 0);
});

test('rooms are separate: another room cannot see or delete items', async () => {
  const one = await pair();
  const two = await pair();
  const s = await call('POST', `/v1/rooms/${one.a.room}/items`, { token: one.a.token, body: ivct() });
  assert.equal((await call('GET', `/v1/rooms/${one.a.room}`, { token: two.a.token })).status, 401);
  assert.equal((await call('DELETE', `/v1/rooms/${one.a.room}/items/${s.json.id}`, { token: two.b.token })).status, 401);
  assert.equal((await call('GET', `/v1/rooms/${two.a.room}`, { token: two.a.token })).json.items.length, 0);
});

test('size and shape limits', async () => {
  const a = await newRoom();
  const t = { token: a.token };
  assert.equal((await call('POST', `/v1/rooms/${a.room}/items`, { ...t, body: ivct(5000) })).status, 413);
  assert.equal((await call('POST', `/v1/rooms/${a.room}/items`, { ...t, body: { iv: 'short', ct: rnd(40) } })).status, 400);
  assert.equal((await call('POST', `/v1/rooms/${a.room}/items`, { ...t, raw: '{bad' })).status, 400);
  assert.equal((await call('POST', `/v1/rooms/${a.room}/code`, { ...t, body: { tag: 'x', iv: rnd(12), wrapped: rnd(48) } })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/v1/rooms/${a.room}/items`, { ...t, body: ivct() })).status, 201);
  assert.equal((await call('POST', `/v1/rooms/${a.room}/items`, { ...t, body: ivct() })).status, 409, 'room full');
});

test('new rooms per network per day are limited', async () => {
  const ip = 'ip-rooms-limit';
  for (let i = 0; i < 4; i++) await newRoom(call, 'mac', ip);
  assert.equal((await call('POST', '/v1/rooms', { body: { dev: 'mac' }, ip })).status, 429);
  assert.equal((await call('POST', '/v1/rooms', { body: { dev: 'mac' }, ip: 'ip-other' })).status, 201);
});

test('wrong codes lock joining for that network', async () => {
  const ip = 'ip-guesser';
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/v1/join', { body: { tag: rnd(32) }, ip })).status, 404);
  const a = await newRoom();
  const box = codeBox();
  await call('POST', `/v1/rooms/${a.room}/code`, { token: a.token, body: box });
  assert.equal((await call('POST', '/v1/join', { body: { tag: box.tag }, ip })).status, 429, 'locked even with the right code');
  assert.equal((await call('POST', '/v1/join', { body: { tag: box.tag }, ip: 'ip-honest' })).status, 200, 'others still join');
});

test('bad device tokens lock that network', async () => {
  const a = await newRoom();
  const ip = 'ip-token-guesser';
  for (let i = 0; i < 5; i++) await call('GET', `/v1/rooms/${a.room}`, { token: rnd(32), ip });
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: a.token, ip })).status, 429);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: a.token })).status, 200);
});

test('end room: gone for both devices', async () => {
  const { a, b } = await pair();
  assert.equal((await call('DELETE', `/v1/rooms/${a.room}`, { token: b.token })).status, 204);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: a.token })).status, 404);
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: b.token })).status, 404);
});

test('stats: claim once, counts only, no addresses or content', async () => {
  const tok = rnd(32);
  assert.equal((await call('POST', '/v1/stats/claim', { body: { hash: sha(tok) } })).status, 201);
  assert.equal((await call('POST', '/v1/stats/claim', { body: { hash: sha(rnd(32)) } })).status, 409, 'second claim refused');
  assert.equal((await call('GET', '/health')).json.stats, true);
  for (const dev of ['iphone', 'iphone', 'windows', 'nonsense']) {
    const ip = 'ip-visit-' + rnd(4);
    SEEN_IPS.push(ip);
    assert.equal((await call('POST', '/v1/hello', { body: { dev }, ip })).status, 204);
  }
  const { a } = await pair();
  const s = await call('POST', `/v1/rooms/${a.room}/items`, { token: a.token, body: ivct() });
  await call('DELETE', `/v1/rooms/${a.room}/items/${s.json.id}?copied=1`, { token: a.token });
  assert.equal((await call('GET', '/v1/stats', { token: rnd(32) })).status, 401);
  const r = await call('GET', '/v1/stats', { token: tok });
  assert.equal(r.status, 200);
  const today = r.json.days[0];
  assert.equal(today.visits, 4);
  assert.equal(today.dev.iphone, 2);
  assert.equal(today.dev.windows, 1);
  assert.equal(today.dev.other, 1);
  for (const k of ['rooms', 'joins', 'wrong', 'sent', 'copied', 'expired', 'ended', 'limited']) {
    assert.ok(today[k] >= 1, k + ' counted');
  }
  assert.ok(r.json.live.rooms >= 1);
  for (const ip of SEEN_IPS) assert.ok(!r.text.includes(ip), 'no addresses in stats');
  assert.ok(!r.text.includes('127.0.0.1'));
});

test('stats survive a restart; content does not', async () => {
  const before = await call('GET', '/health');
  assert.equal(before.json.stats, true);
  const { a } = await pair();
  await call('POST', `/v1/rooms/${a.room}/items`, { token: a.token, body: ivct() });
  await sleep(400);
  await stop(A);
  const file = fs.readFileSync(path.join(A.dir, 'stats.json'), 'utf8');
  for (const ip of SEEN_IPS) assert.ok(!file.includes(ip), 'no addresses on disk');
  assert.deepEqual(fs.readdirSync(A.dir).sort(), ['stats-auth', 'stats.json'], 'nothing else written to disk');
  A = await start({ DATA_DIR: A.dir });
  call = client(A);
  assert.equal((await call('GET', '/health')).json.stats, true, 'claim kept');
  assert.equal((await call('GET', `/v1/rooms/${a.room}`, { token: a.token })).status, 404, 'rooms are memory only');
});

test('server 2: rooms end after the room time', async () => {
  const a = await newRoom(call2);
  assert.equal((await call2('GET', `/v1/rooms/${a.room}`, { token: a.token })).status, 200);
  await sleep(1800);
  assert.equal((await call2('GET', `/v1/rooms/${a.room}`, { token: a.token })).status, 404);
});

test('server 2: live room cap', async () => {
  for (let i = 0; i < 3; i++) await newRoom(call2);
  assert.equal((await call2('POST', '/v1/rooms', { body: {} })).status, 503);
  await sleep(1800);
  assert.equal((await call2('POST', '/v1/rooms', { body: {} })).status, 201, 'space again after rooms end');
});

test('server 2: wrong codes from everyone pause joining for everyone', async () => {
  for (let i = 0; i < 4; i++) await call2('POST', '/v1/join', { body: { tag: rnd(32) } });
  assert.equal((await call2('POST', '/v1/join', { body: { tag: rnd(32) } })).status, 429);
});

test('server 2: visits per network per day are capped', async () => {
  const tok = rnd(32);
  await call2('POST', '/v1/stats/claim', { body: { hash: sha(tok) } });
  for (let i = 0; i < 5; i++) await call2('POST', '/v1/hello', { body: { dev: 'mac' }, ip: 'ip-refresher' });
  const r = await call2('GET', '/v1/stats', { token: tok });
  assert.equal(r.json.days[0].visits, 2);
});

test('health shows the last auto-update result', async () => {
  const s = await start({});
  const c = client(s);
  assert.equal((await c('GET', '/health')).json.update, null, 'nothing before the first run');
  fs.writeFileSync(path.join(s.dir, 'update-status'), '2026-11-20T00:00:00Z up-to-date\n');
  assert.deepEqual((await c('GET', '/health')).json.update, { at: '2026-11-20T00:00:00Z', result: 'up-to-date' });
  fs.writeFileSync(path.join(s.dir, 'update-status'), '<script>alert(1)</script>');
  assert.equal((await c('GET', '/health')).json.update, null, 'junk is not echoed');
  await stop(s);
});

test('updater: temp file ends in .js (node --check refuses other endings), timer starts right away', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'cloud-init.yaml'), 'utf8');
  assert.ok(t.includes('TMP=$(mktemp --suffix=.js)'));
  assert.ok(!/TMP=\$\(mktemp\)/.test(t), 'old temp file name is gone');
  assert.ok(t.includes('OnActiveSec=1min'));
  assert.ok(t.includes('api2.f3.sa {'));
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'code', 'index.html'), 'utf8');
  assert.ok(html.includes('content="https://api2.f3.sa"') && html.includes("connect-src 'self' https://api2.f3.sa"), 'page points at api2');
});

test('setup script is plain ASCII (Oracle console rejects other characters)', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'cloud-init.yaml'), 'utf8');
  assert.ok(!/[^\x00-\x7F]/.test(t), 'non-ASCII character in cloud-init.yaml');
  assert.ok(!t.includes('PASTE_SERVER_CODE_HERE'), 'v2 needs nothing pasted in');
});
