// f3 drop: all secret work happens here, in the browser.
// The private link carries a 125-bit key after "#". The part after "#" is never
// sent to any server. From it we derive two separate things:
//   1. an AES-256-GCM key that locks and unlocks snippets (never leaves the device)
//   2. an access token the server checks (the server stores only its SHA-256)

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const KEY_CHARS = 25; // 25 x 5 bits = 125 bits
const SALT = 'f3drop-v1';
const AAD = 'f3drop-v1';
const te = new TextEncoder();
const td = new TextDecoder();

export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_CHARS));
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31]; // 256 is a multiple of 32, so this is uniform
  return group(s);
}

function group(s) {
  return s.match(/.{5}/g).join('-');
}

// Accepts a full link or just the key; returns the key in groups, or null.
export function normalizeSecret(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  s = s.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[^0-9A-Z]/g, '');
  if (s.length !== KEY_CHARS) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return group(s);
}

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

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveKeys(secret) {
  const norm = normalizeSecret(secret);
  if (!norm) throw new Error('bad_secret');
  const raw = te.encode(norm.replace(/-/g, ''));
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const salt = te.encode(SALT);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('enc') },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt']
  );
  const authBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('auth') }, base, 256);
  const token = b64url(new Uint8Array(authBits));
  const serverCode = hex(await crypto.subtle.digest('SHA-256', te.encode(token)));
  return { secret: norm, aesKey, token, serverCode };
}

export async function seal(aesKey, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(AAD) }, aesKey, te.encode(JSON.stringify(obj)));
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function open(aesKey, item) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64url(item.iv), additionalData: te.encode(AAD) },
    aesKey,
    unb64url(item.ct)
  );
  return JSON.parse(td.decode(pt));
}

export function byteLength(s) {
  return te.encode(s).length;
}
