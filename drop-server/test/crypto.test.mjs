// Browser crypto tests (same Web Crypto API in Node). Run: node --test drop-server/test/crypto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18

const C = await import('../../code/crypto.js');

test('codes: 4 characters from the safe alphabet, spread evenly', () => {
  const counts = new Map();
  for (let i = 0; i < 20000; i++) {
    const c = C.newCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}$/);
    for (const ch of c) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  assert.equal(counts.size, 32);
  for (const n of counts.values()) assert.ok(n > 2000 && n < 3000, 'uneven: ' + n);
});

test('typing a code: any case, spaces, look-alikes, or a link all work; junk refused', () => {
  assert.equal(C.normalizeCode('k7qh'), 'K7QH');
  assert.equal(C.normalizeCode(' K7 QH '), 'K7QH');
  assert.equal(C.normalizeCode('oi1l'), '0111');
  assert.equal(C.normalizeCode('https://f3.sa/code/#k7qh'), 'K7QH');
  for (const bad of ['', 'K7Q', 'K7QHX', 'KUQH', 'K7Q!', null, 42, 'stats', 's=abc']) assert.equal(C.normalizeCode(bad), null, String(bad));
});

test('join: same code gives the same tag on both devices; unwrap returns the room key', async () => {
  const raw = C.newRoomKeyRaw();
  const code = C.newCode();
  const box = await C.wrapForCode(code, raw);
  assert.match(box.tag, /^[A-Za-z0-9_-]{43}$/);
  assert.match(box.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(await C.joinTag(code.toLowerCase()), box.tag);
  const back = await C.unwrapWithCode(code, box);
  assert.deepEqual([...back], [...raw]);
});

test('join: a different code gives a different tag and cannot unlock', async () => {
  const raw = C.newRoomKeyRaw();
  const box = await C.wrapForCode('K7QH', raw);
  assert.notEqual(await C.joinTag('K7QJ'), box.tag);
  await assert.rejects(C.unwrapWithCode('K7QJ', box));
});

test('join: the tag does not reveal the code or the key', async () => {
  const raw = C.newRoomKeyRaw();
  const box = await C.wrapForCode('K7QH', raw);
  const all = JSON.stringify(box);
  assert.ok(!all.includes('K7QH'));
  assert.ok(!all.includes(C.b64url(raw)));
});

test('snippets: lock and unlock in the same room', async () => {
  const key = await C.importRoomKey(C.newRoomKeyRaw());
  const box = await C.seal(key, 'room-one-1234567', { v: 2, lang: 'python', text: 'print("hi")' });
  assert.ok(!JSON.stringify(box).includes('print'));
  const out = await C.open(key, 'room-one-1234567', box);
  assert.equal(out.text, 'print("hi")');
});

test('snippets: will not open in another room or with another key, or if changed', async () => {
  const raw = C.newRoomKeyRaw();
  const key = await C.importRoomKey(raw);
  const box = await C.seal(key, 'room-one-1234567', { text: 'x' });
  await assert.rejects(C.open(key, 'room-two-1234567', box));
  await assert.rejects(C.open(await C.importRoomKey(C.newRoomKeyRaw()), 'room-one-1234567', box));
  const bad = { ...box, ct: (box.ct[0] === 'A' ? 'B' : 'A') + box.ct.slice(1) };
  await assert.rejects(C.open(key, 'room-one-1234567', bad));
});

test('room key in use cannot be exported', async () => {
  const key = await C.importRoomKey(C.newRoomKeyRaw());
  await assert.rejects(crypto.subtle.exportKey('raw', key));
});

test('stats token and hash', async () => {
  const t = C.randomToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.match(await C.sha256hex(t), /^[0-9a-f]{64}$/);
  assert.notEqual(C.randomToken(), t);
});
