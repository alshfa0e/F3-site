// f3 drop: all secret work happens here, in the browser.
//
// Each room has a random 256-bit key made on the first device. It never reaches the server
// in readable form. To bring the second device in, the first device makes a 4-character
// code and runs it through a slow PBKDF2 step (300,000 rounds), which gives two things:
//   1. a lookup tag the server uses to find the room (it stores only a hash of it)
//   2. a key that locks a copy of the room key for the joiner
// The code works once, for 10 minutes. Snippets are locked with AES-256-GCM and tied to
// their room, so a snippet from one room will not open in another.

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
export const CODE_CHARS = 4;
const JOIN_SALT = 'f3drop-join-v2';
const JOIN_ROUNDS = 300000;
const te = new TextEncoder();
const td = new TextDecoder();

export function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

// A fresh 4-character code. 256 is a multiple of 32, so each character is uniform.
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_CHARS));
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return s;
}

// Accepts what a person types (any case, spaces, I/L for 1, O for 0) or a link ending in #CODE.
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const hash = s.lastIndexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  s = s.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[\s-]/g, '');
  if (s.length !== CODE_CHARS) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

// Room key: raw bytes (kept on this device for the day) plus a usable, non-extractable key.
export function newRoomKeyRaw() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importRoomKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function codeKeys(code) {
  const norm = normalizeCode(code);
  if (!norm) throw new Error('bad_code');
  const base = await crypto.subtle.importKey('raw', te.encode(norm), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(JOIN_SALT), iterations: JOIN_ROUNDS }, base, 512));
  const tag = b64url(bits.slice(0, 32));
  const wrapKey = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { tag, wrapKey };
}

// First device: lock a copy of the room key under the code.
export async function wrapForCode(code, rawKey) {
  const { tag, wrapKey } = await codeKeys(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(JOIN_SALT) }, wrapKey, rawKey);
  return { tag, iv: b64url(iv), wrapped: b64url(new Uint8Array(ct)) };
}

// Second device: the tag to send when joining.
export async function joinTag(code) {
  return (await codeKeys(code)).tag;
}

// Second device: unlock the room key the server handed back.
export async function unwrapWithCode(code, box) {
  const { wrapKey } = await codeKeys(code);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64url(box.iv), additionalData: te.encode(JOIN_SALT) }, wrapKey, unb64url(box.wrapped));
  return new Uint8Array(raw);
}

const aad = (roomId) => te.encode('f3drop-v2:' + roomId);

// ---------- packing (v3): text or a file, packed smaller when that helps ----------
// Plain bytes before locking: [flag][4-byte meta length][meta JSON][body].
// flag 0 = as is, 1 = everything after the flag is gzip. Older v2 items are plain JSON ("{...").
export const MAX_UNPACKED = 64 * 1024 * 1024; // refuse to unpack more than this (protects the device)
export const canPack = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function readAll(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (limit && n > limit) { try { await reader.cancel(); } catch (_) { /* ignore */ } throw new Error('too_big'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const gzip = (bytes) => readAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
const gunzip = (bytes, limit) => readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), limit);

export async function pack(meta, body) {
  const m = te.encode(JSON.stringify(meta));
  const inner = new Uint8Array(4 + m.length + body.length);
  new DataView(inner.buffer).setUint32(0, m.length);
  inner.set(m, 4);
  inner.set(body, 4 + m.length);
  let flag = 0;
  let payload = inner;
  if (canPack) {
    const z = await gzip(inner);
    if (z.length < inner.length * 0.95) { flag = 1; payload = z; } // skip when it does not help (photos, PDFs, zips)
  }
  const out = new Uint8Array(1 + payload.length);
  out[0] = flag;
  out.set(payload, 1);
  return out;
}

export async function unpack(plain) {
  if (plain[0] === 0x7b) { // v2: JSON text item
    const o = JSON.parse(td.decode(plain));
    return { meta: { v: 2, kind: 'text', lang: o.lang }, text: String(o.text) };
  }
  let inner;
  if (plain[0] === 1) inner = await gunzip(plain.subarray(1), MAX_UNPACKED);
  else if (plain[0] === 0) inner = plain.subarray(1);
  else throw new Error('bad_format');
  if (inner.length < 4) throw new Error('bad_format');
  const len = new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0);
  if (len > inner.length - 4) throw new Error('bad_format');
  const meta = JSON.parse(td.decode(inner.subarray(4, 4 + len)));
  const body = inner.subarray(4 + len);
  if (meta.kind === 'file') return { meta, bytes: body };
  return { meta, text: td.decode(body) };
}

export async function sealBytes(key, roomId, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(roomId) }, key, bytes);
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function openBytes(key, roomId, item) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(item.iv), additionalData: aad(roomId) }, key, unb64url(item.ct));
  return new Uint8Array(pt);
}

export async function seal(key, roomId, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(roomId) }, key, te.encode(JSON.stringify(obj)));
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function open(key, roomId, item) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(item.iv), additionalData: aad(roomId) }, key, unb64url(item.ct));
  return JSON.parse(td.decode(pt));
}

export function byteLength(s) {
  return te.encode(s).length;
}
