// f3 drop: daily rooms. Open on one device, type its 4-character code on the other.
// Text, big pastes and files up to 10 MB each (after packing).
import {
  newCode, normalizeCode, newRoomKeyRaw, importRoomKey, wrapForCode, joinTag, unwrapWithCode,
  byteLength, b64url, unb64url, sha256hex, randomToken, pack, unpack, sealBytes, openBytes,
} from './crypto.js';

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('framed');
}

const API = (document.querySelector('meta[name="f3-api"]') || {}).content || 'https://api2.f3.sa';
const MAX_PACKED = 10 * 1024 * 1024;  // per item, after packing and locking
const MAX_RAW = 64 * 1024 * 1024;     // refuse to even pack more than this (protects the phone)
const PREVIEW_CHARS = 40000;
const PREVIEW_LINES = 400;
const te = new TextEncoder();
const HIGHLIGHT_MAX = 60 * 1024;
const POLL_MS = 1500;
const STORE_ROOM = 'f3drop.room.v2';
const STORE_STATS = 'f3drop.stats';
const LANG_NAMES = {
  plain: 'Plain', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', sql: 'SQL',
  bash: 'Bash', powershell: 'PowerShell', json: 'JSON', yaml: 'YAML', markup: 'HTML / XML',
  css: 'CSS', csharp: 'C#', java: 'Java',
};
const DEV_NAMES = {
  iphone: 'iPhone', ipad: 'iPad', android: 'Android phone', windows: 'Windows PC',
  mac: 'Mac', linux: 'Linux PC', other: 'device',
};

const $ = (id) => document.getElementById(id);
const el = {};
for (const id of ['status', 'msg', 'msgText', 'retryBtn', 'room', 'pairBox', 'code', 'codeHint', 'shareBtn',
  'newCodeBtn', 'joinIn', 'joinBtn', 'pairedBox', 'pairedName', 'notMeBtn', 'paste', 'lang', 'size', 'sendBtn',
  'empty', 'list', 'roomLeft', 'newCodeBtn2', 'joinIn2', 'joinBtn2', 'endBtn', 'stats', 'statsClaim',
  'statsLocked', 'statsLink', 'statsUrl', 'copyStats', 'statsBody', 'live', 'days', 'toast', 'pasteSendBtn', 'attachBtn',
  'fileIn', 'compose']) el[id] = $(id);

let room = null;          // { id, token, raw, key, expires }
let code = null;          // { value, expires } — the code this device is showing
let others = [];          // devices paired with this one, from the last poll
let othersKnown = false;  // false until the first poll of this room
let pollTimer = null;
let polling = false;
let busy = false;         // creating / joining / making a code
let clockOffset = 0;
let statsTimer = null;
let sending = false;
const cards = new Map();  // id -> { li, timer, item, data }
const gone = new Map();   // id -> time removed here (stops a late poll re-adding it)

// ---------- helpers ----------
const now = () => Date.now() + clockOffset;

function deviceType() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}
const DEV = deviceType();

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000);
}

function setStatus(kind) {
  el.status.className = 'status ' + kind;
  el.status.textContent = kind === 'on' ? 'Connected' : kind === 'off' ? 'Offline, retrying' : '';
}

function show(view) {
  for (const v of ['msg', 'room', 'stats']) el[v].hidden = v !== view;
}

function showMsg(text, retry) {
  stopPolling();
  el.msgText.textContent = text;
  el.retryBtn.hidden = !retry;
  setStatus('');
  show('msg');
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function fmtLong(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return (m >= 60 ? Math.floor(m / 60) + ' h ' : '') + (m % 60) + ' min';
}

function copyText(text) {
  // Must start inside the tap itself (iPhone rule), so no awaits before this.
  return navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text))
    : Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'offscreen';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

function store(k, v) {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage off */ }
}
function recall(k) {
  try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; }
}

function api(method, path, body, token) {
  const opts = { method, headers: {}, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(API + path, opts);
}
const roomApi = (method, sub, body) => api(method, '/v1/rooms/' + room.id + sub, body, room.token);

function twoTap(btn, action) {
  const label = btn.textContent;
  let armed = false;
  let t = null;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Tap again to confirm';
      t = setTimeout(() => { armed = false; btn.textContent = label; }, 4000);
      return;
    }
    clearTimeout(t);
    armed = false;
    btn.textContent = label;
    action();
  });
}

// ---------- room on this device ----------
function saveRoom() {
  if (!room) return store(STORE_ROOM, null);
  store(STORE_ROOM, { id: room.id, token: room.token, key: b64url(room.raw), expires: room.expires, code });
}

async function loadRoom() {
  const s = recall(STORE_ROOM);
  if (!s || typeof s.id !== 'string' || typeof s.token !== 'string' || typeof s.key !== 'string') return null;
  if (!(s.expires > Date.now())) { store(STORE_ROOM, null); return null; }
  try {
    const raw = unb64url(s.key);
    if (raw.length !== 32) return null;
    code = s.code && s.code.expires > Date.now() && normalizeCode(s.code.value) ? s.code : null;
    return { id: s.id, token: s.token, raw, key: await importRoomKey(raw), expires: s.expires };
  } catch (_) { return null; }
}

async function setRoom(r) {
  room = r;
  others = [];
  othersKnown = false;
  clearCards();
  saveRoom();
  openRoomView();
}

function clearPaste() {
  el.paste.value = '';
  updateSize();
}

function forgetRoom() {
  room = null;
  code = null;
  others = [];
  othersKnown = false;
  clearCards();
  clearPaste(); // nothing from the old room carries into the new one
  store(STORE_ROOM, null);
}

async function createRoom() {
  if (busy) return;
  busy = true;
  showMsg('Making your room…');
  try {
    const r = await api('POST', '/v1/rooms', { dev: DEV });
    if (r.status === 429) return showMsg('Too many new rooms from this network today. Try again tomorrow.', true);
    if (r.status === 503) return showMsg('The server is full right now. Try again in a few minutes.', true);
    if (r.status !== 201) return showMsg('Could not make a room. Try again.', true);
    const d = await r.json();
    clockOffset = d.now - Date.now();
    const raw = newRoomKeyRaw();
    code = null;
    await setRoom({ id: d.room, token: d.token, raw, key: await importRoomKey(raw), expires: d.expires });
    busy = false;
    await makeCode();
  } catch (_) {
    showMsg('Cannot reach the server. Check the connection and try again.', true);
  } finally {
    busy = false;
  }
}

async function makeCode() {
  if (!room || busy) return;
  busy = true;
  el.code.textContent = '····';
  el.codeHint.textContent = 'Making a code…';
  try {
    for (let i = 0; i < 3; i++) {
      const c = newCode();
      const box = await wrapForCode(c, room.raw);
      const r = await roomApi('POST', '/code', box);
      if (r.status === 201) {
        const d = await r.json();
        code = { value: c, expires: d.expires };
        saveRoom();
        renderPair();
        return;
      }
      if (r.status === 409) continue; // another room holds this code right now; pick another
      if (r.status === 401 || r.status === 404) return roomLost(r.status);
      break;
    }
    toast('Could not make a code. Try again.');
    renderPair();
  } catch (_) {
    toast('Cannot reach the server.');
    renderPair();
  } finally {
    busy = false;
  }
}

async function joinWith(input, fromLink) {
  const c = normalizeCode(input);
  if (!c) { toast('A code is 4 letters or digits.'); return false; }
  if (busy) return false;
  busy = true;
  if (fromLink) showMsg('Joining…');
  else toast('Joining…');
  try {
    const tag = await joinTag(c);
    const r = await api('POST', '/v1/join', { tag, dev: DEV });
    if (r.status === 404) { toast('Wrong or expired code.'); return false; }
    if (r.status === 429) { toast('Too many wrong codes. Joining is paused for up to an hour.'); return false; }
    if (r.status !== 200) { toast('Could not join. Try again.'); return false; }
    const d = await r.json();
    let raw;
    try { raw = await unwrapWithCode(c, d); } catch (_) { toast('That code did not unlock the room.'); return false; }
    clockOffset = d.now - Date.now();
    const old = room;
    if (old && othersKnown && others.length === 0 && old.id !== d.room) {
      api('DELETE', '/v1/rooms/' + old.id, undefined, old.token).catch(() => {}); // free my unused room
    }
    code = null;
    busy = false;
    await setRoom({ id: d.room, token: d.token, raw, key: await importRoomKey(raw), expires: d.expires });
    toast('Joined.');
    return true;
  } catch (_) {
    toast('Cannot reach the server.');
    return false;
  } finally {
    busy = false;
  }
}

function roomLost(status) {
  forgetRoom();
  toast(status === 401 ? 'Another device took this seat in the room. Starting a new room.' : 'The room ended. Starting a new one.');
  createRoom();
}

async function endRoom(msg) {
  if (!room) return;
  try {
    const r = await roomApi('DELETE', '');
    if (!(r.status === 204 || r.status === 404 || r.status === 401)) { toast('Could not end the room. Try again.'); return; }
  } catch (_) { toast('Cannot reach the server. Nothing changed.'); return; }
  forgetRoom();
  toast(msg);
  createRoom();
}

// ---------- room view ----------
function openRoomView() {
  show('room');
  const saved = recall('f3drop.lang');
  if (saved && LANG_NAMES[saved]) el.lang.value = saved;
  updateSize();
  renderPair();
  startPolling();
}

function renderPair() {
  if (!room) return;
  const paired = others.length > 0;
  const live = code && code.expires > now();
  el.pairedBox.hidden = !paired;
  if (paired) el.pairedName.textContent = DEV_NAMES[others[0].dev] || 'device';
  el.pairBox.hidden = paired && !live;
  if (live) {
    el.code.textContent = code.value;
    el.codeHint.textContent = 'Type it on your other device at f3.sa/code · works for ' + fmt(code.expires - now()) + ', once';
    el.shareBtn.hidden = false;
  } else {
    el.code.textContent = '····';
    el.codeHint.textContent = 'Code expired. Tap New code.';
    el.shareBtn.hidden = true;
  }
  el.roomLeft.textContent = 'This room ends in ' + fmtLong(room.expires - now()) + '. Then you get a new code.';
}

function clearCards() {
  for (const { li } of cards.values()) li.remove();
  cards.clear();
  updateEmpty();
}

function updateEmpty() {
  el.empty.hidden = cards.size > 0;
}

function removeCard(id) {
  const c = cards.get(id);
  if (!c) return;
  c.li.remove();
  cards.delete(id);
  gone.set(id, Date.now());
  updateEmpty();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.ceil(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function lineCount(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n += 1;
  return n;
}

// Big text: show the start only (drawing megabytes is slow on a phone). Copy still takes all of it.
function previewOf(text) {
  if (text.length <= PREVIEW_CHARS) {
    let lines = 0;
    let i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1) { if (++lines >= PREVIEW_LINES) break; }
    if (lines < PREVIEW_LINES) return { shown: text, cut: false };
    return { shown: text.slice(0, i), cut: true };
  }
  let cutAt = text.lastIndexOf('\n', PREVIEW_CHARS);
  if (cutAt < PREVIEW_CHARS / 2) cutAt = PREVIEW_CHARS;
  const head = text.slice(0, cutAt);
  let lines = 0;
  let j = -1;
  while ((j = head.indexOf('\n', j + 1)) !== -1) { if (++lines >= PREVIEW_LINES) return { shown: head.slice(0, j), cut: true }; }
  return { shown: head, cut: true };
}

function buildCard(item, data) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = item.id;
  const isFile = !!(data && data.meta && data.meta.kind === 'file');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('span');
  label.className = 'lang';
  if (!data) label.textContent = 'Cannot open';
  else if (isFile) label.textContent = 'File · ' + fmtBytes(data.bytes.length);
  else label.textContent = (LANG_NAMES[data.meta.lang] || 'Plain') + (data.text.length > 20000 ? ' · ' + fmtBytes(byteLength(data.text)) : '');
  const timer = document.createElement('span');
  timer.className = 'timer';
  timer.textContent = fmt(item.expires - now());
  meta.append(label, timer);
  li.append(meta);

  if (isFile) {
    const box = document.createElement('div');
    box.className = 'file';
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = data.meta.name || 'file';
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = (data.meta.type || 'unknown type') + ' · ' + fmtBytes(data.bytes.length);
    box.append(name, sub);
    li.append(box);
  } else {
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    const langId = data && LANG_NAMES[data.meta.lang] ? data.meta.lang : 'plain';
    codeEl.className = 'language-' + langId;
    if (!data) {
      codeEl.textContent = 'This item could not be unlocked on this device.';
      pre.append(codeEl);
      li.append(pre);
    } else {
      const p = previewOf(data.text);
      codeEl.textContent = p.shown;
      pre.append(codeEl);
      if (langId !== 'plain' && p.shown.length <= HIGHLIGHT_MAX && window.Prism && window.Prism.languages[langId]) {
        try { window.Prism.highlightElement(codeEl); } catch (_) { /* show plain */ }
      }
      li.append(pre);
      if (p.cut) {
        const more = document.createElement('p');
        more.className = 'muted more';
        more.textContent = 'Showing the start only. All ' + lineCount(data.text).toLocaleString('en') + ' lines (' + fmtBytes(byteLength(data.text)) + ') are copied.';
        li.append(more);
      }
    }
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (data) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn copy';
    go.textContent = isFile ? 'Save & delete' : 'Copy & delete';
    go.addEventListener('click', () => (isFile ? saveAndDelete(item.id) : copyAndDelete(item.id)));
    actions.append(go);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn line del';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteOnly(item.id));
  actions.append(del);
  li.append(actions);
  return { li, timer };
}

async function fetchItem(myRoom, id) {
  const r = await api('GET', '/v1/rooms/' + myRoom.id + '/items/' + id, undefined, myRoom.token);
  if (!r.ok) return null;
  const box = await r.json();
  try { return await unpack(await openBytes(myRoom.key, myRoom.id, box)); } catch (_) { return false; }
}

async function sync(list) {
  const myRoom = room;
  const live = new Set(list.map((i) => i.id));
  for (const [id, c] of [...cards]) if (!live.has(id) && !c.saved) removeCard(id); // saved files stay until their time is up
  let added = false;
  for (const item of list) {
    if (cards.has(item.id) || gone.has(item.id)) continue;
    const data = await fetchItem(myRoom, item.id);
    if (data === null) continue; // gone meanwhile; the next poll tidies up
    if (room !== myRoom || cards.has(item.id) || gone.has(item.id)) continue;
    const ok = data && data.meta && (typeof data.text === 'string' || data.bytes);
    const { li, timer } = buildCard(item, ok ? data : null);
    cards.set(item.id, { li, timer, item, data: ok ? data : null });
    added = true;
  }
  if (added) for (const item of list) { const c = cards.get(item.id); if (c) el.list.append(c.li); }
  const t = Date.now();
  for (const [id, at] of gone) if (t - at > 10 * 60 * 1000) gone.delete(id);
  updateEmpty();
}

async function poll() {
  if (polling || !room) return;
  polling = true;
  const myRoom = room;
  try {
    const r = await roomApi('GET', '');
    if (room !== myRoom) return;
    if (r.status === 401 || r.status === 404) { stopPolling(); roomLost(r.status); return; }
    if (!r.ok) { setStatus('off'); return; }
    const d = await r.json();
    if (room !== myRoom) return;
    clockOffset = d.now - Date.now();
    const before = others.length;
    others = d.others || [];
    if (others.length > 0 && before === 0 && code) {
      code = null; // the code was used
      saveRoom();
    }
    if (othersKnown && others.length > before) toast('Paired with ' + (DEV_NAMES[others[0].dev] || 'a device') + '.');
    if (code && !(d.code && d.code.mine)) { code = null; saveRoom(); }
    othersKnown = true;
    renderPair();
    await sync(d.items || []);
    setStatus('on');
  } catch (_) {
    setStatus('off');
  } finally {
    polling = false;
  }
}

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function tick() {
  for (const [id, c] of cards) {
    const ms = c.item.expires - now();
    if (ms <= 0) removeCard(id);
    else c.timer.textContent = fmt(ms);
  }
  if (room && !el.room.hidden) {
    if (room.expires <= now()) { stopPolling(); roomLost(404); return; }
    renderPair();
  }
}

async function deleteOnServer(id, how) {
  try {
    const r = await roomApi('DELETE', '/items/' + id + (how ? '?copied=1' : ''));
    return r.ok || r.status === 404;
  } catch (_) { return false; }
}

function copyAndDelete(id) {
  const c = cards.get(id);
  if (!c || !c.data || typeof c.data.text !== 'string') return;
  copyText(c.data.text).then(async (ok) => {
    if (!ok) { toast('Copy was blocked. Nothing was deleted.'); return; }
    removeCard(id);
    toast((await deleteOnServer(id, 'copied')) ? 'Copied. Deleted on both devices.' : 'Copied. Delete failed; it expires within 5 minutes.');
  });
}

// Files: download, then delete on both devices. The file stays in this page's memory until its
// 5 minutes are up, so "Save again" works if the phone's save sheet was dismissed.
function saveAndDelete(id) {
  const c = cards.get(id);
  if (!c || !c.data || !c.data.bytes) return;
  const { meta, bytes } = c.data;
  const blob = new Blob([bytes], { type: meta.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (meta.name || 'file').slice(0, 200);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  if (c.saved) return toast('Saved again.');
  c.saved = true;
  const btn = c.li.querySelector('.copy');
  if (btn) btn.textContent = 'Save again';
  const del = c.li.querySelector('.del');
  if (del) del.remove();
  c.li.classList.add('done');
  deleteOnServer(id, 'copied').then((ok) => {
    gone.set(id, Date.now());
    toast(ok ? 'Saved. Deleted on both devices.' : 'Saved. Delete failed; it expires within 5 minutes.');
  });
}

async function deleteOnly(id) {
  removeCard(id);
  toast((await deleteOnServer(id)) ? 'Deleted on both devices.' : 'Delete failed; it expires within 5 minutes.');
}

function updateSize() {
  const n = byteLength(el.paste.value);
  el.size.textContent = n ? fmtBytes(n) : '';
}

function setSending(on, label) {
  sending = on;
  for (const b of [el.sendBtn, el.pasteSendBtn, el.attachBtn]) b.disabled = on;
  el.sendBtn.textContent = on ? (label || 'Sending…') : 'Send';
}

// Pack, lock and send one item. Returns true when the server took it.
async function sendPacked(meta, body, what) {
  if (!room) return false;
  if (body.length > MAX_RAW) { toast('Too big: ' + fmtBytes(body.length) + '. Max 10 MB after packing.'); return false; }
  setSending(true, 'Packing…');
  try {
    const packed = await pack(meta, body);
    if (packed.length + 16 > MAX_PACKED) {
      toast('Too big: ' + fmtBytes(packed.length) + ' after packing. Max 10 MB.');
      return false;
    }
    setSending(true, 'Sending ' + fmtBytes(packed.length) + '…');
    const box = await sealBytes(room.key, room.id, packed);
    const r = await roomApi('POST', '/items', box);
    if (r.status === 201) {
      const saved = body.length > packed.length * 1.5 ? ' (packed ' + fmtBytes(body.length) + ' → ' + fmtBytes(packed.length) + ')' : '';
      toast((others.length ? what + ' sent' : what + ' sent. Pair your other device within 5 minutes to get it') + saved + '.');
      poll();
      return true;
    }
    if (r.status === 413) toast('Too big for the server. Max 10 MB after packing.');
    else if (r.status === 409) toast('Room full. Copy, save or delete some first.');
    else if (r.status === 503) toast('Server is full right now. Try again soon.');
    else if (r.status === 401 || r.status === 404) roomLost(r.status);
    else toast('Could not send. Try again.');
    return false;
  } catch (_) {
    toast('Cannot reach the server.');
    return false;
  } finally {
    setSending(false);
  }
}

async function sendNow() {
  const text = el.paste.value;
  if (!text.trim()) return toast('Paste something first.');
  const ok = await sendPacked({ v: 3, kind: 'text', lang: el.lang.value }, te.encode(text), 'Sent');
  if (ok) { el.paste.value = ''; updateSize(); }
}

// Reads the clipboard directly, so a huge paste never has to be drawn in the box.
async function pasteAndSend() {
  if (sending) return;
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (_) {
    return toast('This browser blocked reading the clipboard. Paste into the box instead.');
  }
  if (!text || !text.trim()) return toast('The clipboard is empty.');
  await sendPacked({ v: 3, kind: 'text', lang: el.lang.value }, te.encode(text), fmtBytes(byteLength(text)));
}

async function sendFiles(files) {
  for (const f of files) {
    if (f.size > MAX_RAW) { toast(f.name + ' is too big (' + fmtBytes(f.size) + '). Max 10 MB.'); continue; }
    let bytes;
    try { bytes = new Uint8Array(await f.arrayBuffer()); } catch (_) { toast('Could not read ' + f.name + '.'); continue; }
    await sendPacked({ v: 3, kind: 'file', name: String(f.name || 'file').slice(0, 200), type: String(f.type || '').slice(0, 100), size: f.size }, bytes, f.name);
  }
}

// ---------- stats ----------
function statsLinkFor(tok) {
  return location.origin + location.pathname + '#s=' + tok;
}

async function showStats(hash) {
  stopPolling();
  show('stats');
  setStatus('');
  for (const id of ['statsClaim', 'statsLocked', 'statsLink', 'statsBody']) el[id].hidden = true;
  if (hash.startsWith('s=')) {
    const tok = hash.slice(2);
    if (/^[A-Za-z0-9_-]{43}$/.test(tok)) store(STORE_STATS, tok);
    history.replaceState(null, '', location.pathname + '#stats');
  }
  const tok = recall(STORE_STATS);
  if (typeof tok === 'string') return loadStats(tok);
  try {
    const h = await (await api('GET', '/health')).json();
    if (h.stats) el.statsLocked.hidden = false;
    else el.statsClaim.hidden = false;
  } catch (_) {
    el.statsLocked.hidden = false;
    el.statsLocked.textContent = 'Cannot reach the server.';
  }
}

async function loadStats(tok) {
  clearInterval(statsTimer);
  try {
    const r = await api('GET', '/v1/stats', undefined, tok);
    if (r.status === 401) {
      store(STORE_STATS, null);
      el.statsBody.hidden = true;
      el.statsLocked.hidden = false;
      el.statsLocked.textContent = 'This stats link does not work. Open the one you saved.';
      return;
    }
    if (!r.ok) throw new Error('bad');
    renderStats(await r.json());
    statsTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && !el.stats.hidden) loadStats(tok);
    }, 10000);
  } catch (_) {
    el.statsLocked.hidden = false;
    el.statsLocked.textContent = 'Cannot reach the server.';
  }
}

const n = (v, one, many) => v + ' ' + (v === 1 ? one : many || one + 's');

function renderStats(d) {
  el.statsBody.hidden = false;
  el.statsLocked.hidden = true;
  el.live.textContent = 'Now: ' + n(d.live.rooms, 'room') + ' open · ' + d.live.paired + ' paired · ' + n(d.live.items, 'item') + ' waiting';
  el.days.textContent = '';
  if (!d.days.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No visits yet.';
    el.days.append(li);
  }
  for (const day of d.days) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    const dt = new Date(day.date + 'T12:00:00Z');
    b.textContent = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const devs = Object.entries(day.dev || {}).sort((a, c) => c[1] - a[1]).map(([k, v]) => (DEV_NAMES[k] || k) + ' ' + v).join(', ');
    const p1 = document.createElement('div');
    p1.textContent = n(day.visits, 'visit') + (devs ? ' (' + devs + ')' : '');
    const p2 = document.createElement('div');
    p2.className = 'muted';
    p2.textContent = [n(day.rooms, 'room'), n(day.joins, 'join'), n(day.wrong, 'wrong code'), day.sent + ' sent',
      day.copied + ' copied', day.expired + ' expired', day.ended + ' ended', day.limited + ' blocked'].join(' · ');
    li.append(b, p1, p2);
    el.days.append(li);
  }
}

el.claimBtn = $('claimBtn');
el.claimBtn.addEventListener('click', async () => {
  el.claimBtn.disabled = true;
  try {
    const tok = randomToken();
    const r = await api('POST', '/v1/stats/claim', { hash: await sha256hex(tok) });
    if (r.status === 201) {
      store(STORE_STATS, tok);
      el.statsClaim.hidden = true;
      el.statsLink.hidden = false;
      el.statsUrl.textContent = statsLinkFor(tok);
      loadStats(tok);
    } else if (r.status === 409) {
      el.statsClaim.hidden = true;
      el.statsLocked.hidden = false;
      el.statsLocked.textContent = 'Stats were already set up. Open the link you saved.';
    } else toast('Could not set up stats. Try again.');
  } catch (_) {
    toast('Cannot reach the server.');
  } finally {
    el.claimBtn.disabled = false;
  }
});
el.copyStats.addEventListener('click', () => {
  copyText(el.statsUrl.textContent).then((ok) => toast(ok ? 'Link copied. Save it as a bookmark.' : 'Copy was blocked.'));
});

// ---------- theme: Auto (follows the device) -> Light -> Dark ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_NAMES = { auto: 'Auto', light: 'Light', dark: 'Dark' };
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  $('themeBtn').textContent = THEME_NAMES[t] || 'Auto';
  $('themeBtn').setAttribute('aria-label', 'Theme: ' + (THEME_NAMES[t] || 'Auto') + '. Tap to change.');
}
let theme = 'auto';
try { theme = THEMES.includes(localStorage.getItem('f3drop.theme')) ? localStorage.getItem('f3drop.theme') : 'auto'; } catch (_) { /* storage off */ }
applyTheme(theme);
$('themeBtn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem('f3drop.theme', theme); } catch (_) { /* storage off */ }
  applyTheme(theme);
  toast('Theme: ' + THEME_NAMES[theme] + (theme === 'auto' ? ' (follows this device)' : ''));
});

// ---------- start ----------
async function start(joinCode) {
  if (!room) room = await loadRoom();
  if (joinCode) {
    const ok = await joinWith(joinCode, true);
    if (ok) return;
    if (room) return openRoomView();
    return createRoom();
  }
  if (room) return openRoomView();
  return createRoom();
}

function route() {
  const h = location.hash.slice(1);
  if (h === 'stats' || h.startsWith('s=')) return showStats(h);
  clearInterval(statsTimer);
  const c = h.length <= 9 ? normalizeCode(h) : null;
  if (h) history.replaceState(null, '', location.pathname); // keep codes out of the address bar and history
  return start(c);
}

el.retryBtn.addEventListener('click', () => { el.retryBtn.hidden = true; start(null); });
el.newCodeBtn.addEventListener('click', makeCode);
el.newCodeBtn2.addEventListener('click', () => { makeCode(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
el.shareBtn.addEventListener('click', () => {
  if (!code) return;
  const link = location.origin + location.pathname + '#' + code.value;
  if (navigator.share) {
    navigator.share({ title: 'Drop code', url: link }).catch(() => {});
  } else {
    copyText(link).then((ok) => toast(ok ? 'Link copied.' : 'Copy was blocked.'));
  }
});
el.joinBtn.addEventListener('click', async () => { if (await joinWith(el.joinIn.value)) el.joinIn.value = ''; });
el.joinIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinBtn.click(); });
el.joinBtn2.addEventListener('click', async () => { if (await joinWith(el.joinIn2.value)) el.joinIn2.value = ''; });
el.joinIn2.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinBtn2.click(); });
twoTap(el.notMeBtn, () => endRoom('Room ended. The other device is out.'));
twoTap(el.endBtn, () => endRoom('Room ended. Here is a new one.'));

el.paste.addEventListener('input', updateSize);
el.paste.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendNow(); }
});
el.sendBtn.addEventListener('click', sendNow);
el.pasteSendBtn.addEventListener('click', pasteAndSend);
el.attachBtn.addEventListener('click', () => el.fileIn.click());
el.fileIn.addEventListener('change', () => {
  const files = [...el.fileIn.files];
  el.fileIn.value = '';
  if (files.length) sendFiles(files);
});
el.compose.addEventListener('dragover', (e) => { e.preventDefault(); el.compose.classList.add('drop'); });
el.compose.addEventListener('dragleave', () => el.compose.classList.remove('drop'));
el.compose.addEventListener('drop', (e) => {
  e.preventDefault();
  el.compose.classList.remove('drop');
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (files.length) sendFiles(files);
});
el.lang.addEventListener('change', () => store('f3drop.lang', el.lang.value));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && room && !el.room.hidden) poll();
});
window.addEventListener('hashchange', route);
setInterval(tick, 1000);

el.paste.value = ''; // browsers may restore form text after a reload; never bring old code back
if (!(location.hash === '#stats' || location.hash.startsWith('#s='))) {
  api('POST', '/v1/hello', { dev: DEV }).catch(() => {}); // counted, nothing else kept
}
route();
