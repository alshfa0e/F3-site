// f3 drop v2: daily rooms. Open on one device, type its 4-character code on the other.
import {
  newCode, normalizeCode, newRoomKeyRaw, importRoomKey, wrapForCode, joinTag, unwrapWithCode,
  seal, open, byteLength, b64url, unb64url, sha256hex, randomToken,
} from './crypto.js';

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('framed');
}

const API = (document.querySelector('meta[name="f3-api"]') || {}).content || 'https://api.f3.sa';
const MAX_BYTES = 256 * 1024;
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
  'statsLocked', 'statsLink', 'statsUrl', 'copyStats', 'statsBody', 'live', 'days', 'toast']) el[id] = $(id);

let room = null;          // { id, token, raw, key, expires }
let code = null;          // { value, expires } — the code this device is showing
let others = [];          // devices paired with this one, from the last poll
let othersKnown = false;  // false until the first poll of this room
let pollTimer = null;
let polling = false;
let busy = false;         // creating / joining / making a code
let clockOffset = 0;
let statsTimer = null;
const cards = new Map();  // id -> { li, timer, item, text }
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

function forgetRoom() {
  room = null;
  code = null;
  others = [];
  othersKnown = false;
  clearCards();
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

function buildCard(item, data) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = item.id;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const lang = document.createElement('span');
  lang.className = 'lang';
  lang.textContent = data ? LANG_NAMES[data.lang] || 'Plain' : 'Cannot open';
  const timer = document.createElement('span');
  timer.className = 'timer';
  timer.textContent = fmt(item.expires - now());
  meta.append(lang, timer);

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  const langId = data && LANG_NAMES[data.lang] ? data.lang : 'plain';
  codeEl.className = 'language-' + langId;
  codeEl.textContent = data ? data.text : 'This item could not be unlocked on this device.';
  pre.append(codeEl);
  if (data && langId !== 'plain' && data.text.length <= HIGHLIGHT_MAX && window.Prism && window.Prism.languages[langId]) {
    try { window.Prism.highlightElement(codeEl); } catch (_) { /* show plain */ }
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (data) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn copy';
    copy.textContent = 'Copy & delete';
    copy.addEventListener('click', () => copyAndDelete(item.id));
    actions.append(copy);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn line del';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteOnly(item.id));
  actions.append(del);
  li.append(meta, pre, actions);
  return { li, timer };
}

async function sync(list) {
  const myRoom = room;
  const live = new Set(list.map((i) => i.id));
  for (const id of [...cards.keys()]) if (!live.has(id)) removeCard(id);
  let added = false;
  for (const item of list) {
    if (cards.has(item.id) || gone.has(item.id)) continue;
    let data = null;
    try {
      data = await open(myRoom.key, myRoom.id, item);
      if (!data || typeof data.text !== 'string') data = null;
    } catch (_) { data = null; }
    if (room !== myRoom || cards.has(item.id)) continue;
    const { li, timer } = buildCard(item, data);
    cards.set(item.id, { li, timer, item, text: data ? data.text : null });
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

function copyAndDelete(id) {
  const c = cards.get(id);
  if (!c || c.text === null) return;
  copyText(c.text).then(async (ok) => {
    if (!ok) { toast('Copy was blocked. Nothing was deleted.'); return; }
    removeCard(id);
    try {
      const r = await roomApi('DELETE', '/items/' + id + '?copied=1');
      toast(r.ok || r.status === 404 ? 'Copied. Deleted on both devices.' : 'Copied. Delete failed; it expires within 5 minutes.');
    } catch (_) {
      toast('Copied. Server not reached; it expires within 5 minutes.');
    }
  });
}

async function deleteOnly(id) {
  removeCard(id);
  try {
    const r = await roomApi('DELETE', '/items/' + id);
    toast(r.ok || r.status === 404 ? 'Deleted on both devices.' : 'Delete failed; it expires within 5 minutes.');
  } catch (_) {
    toast('Server not reached; it expires within 5 minutes.');
  }
}

function updateSize() {
  const n = byteLength(el.paste.value);
  el.size.textContent = n ? (n < 1024 ? n + ' B' : Math.ceil(n / 1024) + ' KB') + (n > MAX_BYTES ? ' (max 256 KB)' : '') : '';
}

async function sendNow() {
  if (!room) return;
  const text = el.paste.value;
  if (!text.trim()) return toast('Paste something first.');
  if (byteLength(text) > MAX_BYTES) return toast('Too big. Max 256 KB.');
  el.sendBtn.disabled = true;
  try {
    const box = await seal(room.key, room.id, { v: 2, lang: el.lang.value, text });
    const r = await roomApi('POST', '/items', box);
    if (r.status === 201) {
      el.paste.value = '';
      updateSize();
      toast(others.length ? 'Sent. Gone after copy, or in 5 minutes.' : 'Sent. Pair your other device within 5 minutes to get it.');
      poll();
    } else if (r.status === 413) toast('Too big. Max 256 KB.');
    else if (r.status === 409) toast('Room full. Copy or delete some first.');
    else if (r.status === 503) toast('Server is full right now. Try again soon.');
    else if (r.status === 401 || r.status === 404) roomLost(r.status);
    else toast('Could not send. Try again.');
  } catch (_) {
    toast('Cannot reach the server.');
  } finally {
    el.sendBtn.disabled = false;
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
el.lang.addEventListener('change', () => store('f3drop.lang', el.lang.value));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && room && !el.room.hidden) poll();
});
window.addEventListener('hashchange', route);
setInterval(tick, 1000);

if (!(location.hash === '#stats' || location.hash.startsWith('#s='))) {
  api('POST', '/v1/hello', { dev: DEV }).catch(() => {}); // counted, nothing else kept
}
route();
