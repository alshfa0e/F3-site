'use strict';
// Server tests. Run: node --test drop-server/test/server.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ORIGIN = 'https://f3.sa';
const TOKEN = crypto.randomBytes(32).toString('base64url');
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3drop-'));
const authFile = path.join(dir, 'auth');
let proc;
let base;

function ivct(n = 40) {
  return { iv: crypto.randomBytes(12).toString('base64url'), ct: crypto.randomBytes(n).toString('base64url') };
}

async function call(method, p, { token = TOKEN, body, origin = ORIGIN, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (origin) headers.Origin = origin;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, headers: r.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.writeFileSync(authFile, HASH + '\n');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', AUTH_FILE: authFile, ALLOW_ORIGIN: ORIGIN, TTL_MS: '1500', SWEEP_MS: '100', MAX_ITEMS: '5', FAIL_LIMIT: '5', MAX_BODY: '4096' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      const m = /listening on ([^:]+):(\d+)/.exec(String(d));
      if (m) resolve(`http://127.0.0.1:${m[2]}`);
    });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});

after(() => { proc.kill('SIGTERM'); });

test('health needs no login and reports ready', async () => {
  const r = await call('GET', '/health', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.ready, true);
});

test('T4: no token or a wrong token is refused (401)', async () => {
  assert.equal((await call('GET', '/v1/items', { token: null })).status, 401);
  assert.equal((await call('GET', '/v1/items', { token: crypto.randomBytes(32).toString('base64url') })).status, 401);
  assert.equal((await call('POST', '/v1/items', { token: null, body: ivct() })).status, 401);
  assert.equal((await call('DELETE', '/v1/items', { token: null })).status, 401);
});

test('other websites are refused (403) and CORS is f3.sa only', async () => {
  const r = await call('GET', '/v1/items', { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const ok = await call('GET', '/v1/items');
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

test('create, list, delete one; second delete says gone (T5/T12 server side)', async () => {
  const a = await call('POST', '/v1/items', { body: ivct() });
  assert.equal(a.status, 201);
  const list = await call('GET', '/v1/items');
  assert.ok(list.json.items.some((i) => i.id === a.json.id));
  assert.equal((await call('DELETE', '/v1/items/' + a.json.id)).status, 204);
  assert.equal((await call('DELETE', '/v1/items/' + a.json.id)).status, 404);
  const after = await call('GET', '/v1/items');
  assert.ok(!after.json.items.some((i) => i.id === a.json.id));
});

test('T15: an item nobody copies is gone after its time (TTL)', async () => {
  const a = await call('POST', '/v1/items', { body: ivct() });
  assert.equal(a.status, 201);
  assert.ok(a.json.expires - a.json.created === 1500);
  await sleep(1800);
  const list = await call('GET', '/v1/items');
  assert.ok(!list.json.items.some((i) => i.id === a.json.id));
});

test('T10: too big is refused (413); bad shape is refused (400)', async () => {
  assert.equal((await call('POST', '/v1/items', { body: ivct(5000) })).status, 413);
  assert.equal((await call('POST', '/v1/items', { body: { iv: 'x', ct: 'y' } })).status, 400);
  assert.equal((await call('POST', '/v1/items', { raw: '{not json' })).status, 400);
  assert.equal((await call('POST', '/v1/items', { body: { iv: 'a'.repeat(16), ct: 'plain text <script>' } })).status, 400);
});

test('inbox cap (409) and delete-all', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/v1/items', { body: ivct() })).status, 201);
  assert.equal((await call('POST', '/v1/items', { body: ivct() })).status, 409);
  assert.equal((await call('DELETE', '/v1/items')).status, 204);
  assert.equal((await call('GET', '/v1/items')).json.items.length, 0);
});

test('T2: the server only holds what it was given (no plaintext, no key)', async () => {
  const sent = ivct();
  const a = await call('POST', '/v1/items', { body: sent });
  const it = (await call('GET', '/v1/items')).json.items.find((i) => i.id === a.json.id);
  assert.deepEqual(Object.keys(it).sort(), ['created', 'ct', 'expires', 'id', 'iv']);
  assert.equal(it.ct, sent.ct);
  await call('DELETE', '/v1/items');
});

test('rotate: old link stops, new link works, items cleared, hash saved to disk', async () => {
  await call('POST', '/v1/items', { body: ivct() });
  const NEW = crypto.randomBytes(32).toString('base64url');
  const NEWHASH = crypto.createHash('sha256').update(NEW).digest('hex');
  assert.equal((await call('POST', '/v1/rotate', { body: { hash: 'nothex' } })).status, 400);
  assert.equal((await call('POST', '/v1/rotate', { body: { hash: NEWHASH } })).status, 204);
  assert.equal((await call('GET', '/v1/items')).status, 401);
  const r = await call('GET', '/v1/items', { token: NEW });
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 0);
  assert.equal(fs.readFileSync(authFile, 'utf8').trim(), NEWHASH);
  // rotate back for the remaining tests
  assert.equal((await call('POST', '/v1/rotate', { token: NEW, body: { hash: HASH } })).status, 204);
});

test('too many wrong tries from one place are blocked (429); other places are not affected', async () => {
  const bad = crypto.randomBytes(32).toString('base64url');
  const headers = { 'X-Forwarded-For': '203.0.113.9' };
  let last;
  for (let i = 0; i < 6; i++) {
    last = await fetch(base + '/v1/items', { headers: { ...headers, Authorization: 'Bearer ' + bad, Origin: ORIGIN } });
  }
  assert.equal(last.status, 429);
  const other = await call('GET', '/v1/items');
  assert.equal(other.status, 200, 'a different IP is not affected');
});
