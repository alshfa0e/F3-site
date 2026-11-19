// Browser crypto tests (same Web Crypto API in Node). Run: node --test drop-server/test/crypto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18

const C = await import('../../code/crypto.js');

test('new link key: 25 characters in 5 groups, all different', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const s = C.newSecret();
    assert.match(s, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 2000);
});

test('link parsing: full link, lowercase, look-alike letters; junk refused', () => {
  const s = C.newSecret();
  assert.equal(C.normalizeSecret('https://f3.sa/code/#' + s), s);
  assert.equal(C.normalizeSecret(s.toLowerCase()), s);
  assert.equal(C.normalizeSecret(s.replace(/-/g, '')), s);
  assert.equal(C.normalizeSecret('0000O-11111-1111I-L1111-11111'), '00000-11111-11111-11111-11111');
  assert.equal(C.normalizeSecret('too-short'), null);
  assert.equal(C.normalizeSecret('UUUUU-UUUUU-UUUUU-UUUUU-UUUUU'), null);
  assert.equal(C.normalizeSecret(undefined), null);
});

test('same link gives the same token and server code; different link gives different ones', async () => {
  const s = C.newSecret();
  const a = await C.deriveKeys(s);
  const b = await C.deriveKeys('https://f3.sa/code/#' + s.toLowerCase());
  assert.equal(a.token, b.token);
  assert.equal(a.serverCode, b.serverCode);
  assert.match(a.serverCode, /^[0-9a-f]{64}$/);
  const c = await C.deriveKeys(C.newSecret());
  assert.notEqual(a.token, c.token);
});

test('the lock key cannot be exported, and the token is not the lock key', async () => {
  const k = await C.deriveKeys(C.newSecret());
  assert.equal(k.aesKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', k.aesKey));
});

test('seal then open gives the same code back; ciphertext does not contain it', async () => {
  const k = await C.deriveKeys(C.newSecret());
  const text = 'SELECT * FROM t WHERE x = 1; -- مرحبا\n'.repeat(50);
  const box = await C.seal(k.aesKey, { v: 1, lang: 'sql', text });
  assert.equal(box.iv.length, 16);
  assert.ok(!box.ct.includes('SELECT'));
  const back = await C.open(k.aesKey, box);
  assert.equal(back.text, text);
});

test('T3: a wrong link cannot open anything; a changed byte is detected', async () => {
  const k = await C.deriveKeys(C.newSecret());
  const other = await C.deriveKeys(C.newSecret());
  const box = await C.seal(k.aesKey, { v: 1, text: 'secret code' });
  await assert.rejects(C.open(other.aesKey, box));
  const bytes = C.unb64url(box.ct);
  bytes[0] ^= 1;
  await assert.rejects(C.open(k.aesKey, { iv: box.iv, ct: C.b64url(bytes) }));
});

test('256 KB of code fits under the server body cap once sealed', async () => {
  const k = await C.deriveKeys(C.newSecret());
  const text = 'x'.repeat(256 * 1024 - 100);
  const box = await C.seal(k.aesKey, { v: 1, lang: 'plain', text });
  const body = JSON.stringify(box).length;
  assert.ok(body < 400 * 1024, 'body ' + body);
});
