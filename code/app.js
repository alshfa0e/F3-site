// f3 drop: private, self-deleting code inbox between your own devices.
import { newSecret, normalizeSecret, deriveKeys, seal, open, byteLength } from './crypto.js';

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('framed');
}

const API = (document.querySelector('meta[name="f3-api"]') || {}).content || 'https://api.f3.sa';
const MAX_BYTES = 256 * 1024;
const HIGHLIGHT_MAX = 60 * 1024;
const POLL_MS = 1500;
const LANG_NAMES = {
  plain: 'Plain', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', sql: 'SQL',
  bash: 'Bash', powershell: 'PowerShell', json: 'JSON', yaml: 'YAML', markup: 'HTML / XML',
  css: 'CSS', csharp: 'C#', java: 'Java',
};

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), start: $('start'), startMsg: $('startMsg'), linkIn: $('linkIn'), openBtn: $('openBtn'),
  createBtn: $('createBtn'), setup: $('setup'), setupTitle: $('setupTitle'), newLink: $('newLink'),
  copyLink: $('copyLink'), newCode: $('newCode'), copySetup: $('copySetup'), goNew: $('goNew'),
  inbox: $('inbox'), paste: $('paste'), lang: $('lang'), size: $('size'), sendBtn: $('sendBtn'),
  empty: $('empty'), list: $('list'), wipeBtn: $('wipeBtn'), rotateBtn: $('rotateBtn'),
  setupAgain: $('setupAgain'), toast: $('toast'), readyNote: $('readyNote'), firstBox: $('firstBox'),
  shareBtn: $('shareBtn'),
};
const BAD_LINK_MSG = 'This link is not the one your server knows. Open the link you saved during setup (or the newest one, if you made a new link in Settings).';

let keys = null;          // { secret, aesKey, token, serverCode } for the open link
let pendingKeys = null;   // keys shown on the setup screen
let pollTimer = null;
let polling = false;
let clockOffset = 0;      // server time minus device time
let setupTemplate = null; // cloud-init template, fetched ahead so copy works on iPhone
const cards = new Map();  // id -> { li, item, text, lang }
const gone = new Map();   // id -> time we removed it here (stops a late poll from re-adding it)

// ---------- small helpers ----------
let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function setStatus(kind) {
  el.status.className = 'status ' + kind;
  el.status.textContent = kind === 'on' ? 'Connected' : kind === 'off' ? 'Offline, retrying' : kind === 'bad' ? 'Link not valid' : '';
}

function show(view) {
  for (const v of ['start', 'setup', 'inbox']) el[v].hidden = v !== view;
}

function linkFor(secret) {
  return location.origin + location.pathname + '#' + secret;
}

function copyText(text) {
  // Must run inside the tap itself (iPhone rule), so no awaits before this.
  const viaApi = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text))
    : Promise.resolve(fallbackCopy(text));
  return viaApi;
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

function rememberLang(v) {
  try { localStorage.setItem('f3drop.lang', v); } catch (_) { /* storage may be off */ }
}
function recallLang() {
  try { return localStorage.getItem('f3drop.lang'); } catch (_) { return null; }
}

function api(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + keys.token },
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(API + path, opts);
}

function twoTap(btn, label, action) {
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

// ---------- setup template ----------
function loadTemplate() {
  if (setupTemplate) return;
  fetch(new URL('../drop-server/cloud-init.yaml', location.href), { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : null))
    .then((t) => { if (t && t.includes('PASTE_SERVER_CODE_HERE')) setupTemplate = t; })
    .catch(() => {});
}

function copySetupScript(serverCode) {
  if (!setupTemplate) {
    toast('Setup script not loaded yet. Try again in a moment.');
    loadTemplate();
    return;
  }
  copyText(setupTemplate.replace('PASTE_SERVER_CODE_HERE', serverCode)).then((ok) => {
    toast(ok ? 'Setup script copied.' : 'Copy was blocked by the browser.');
  });
}

// ---------- views ----------
function showStart(msg) {
  stopPolling();
  keys = null;
  clearCards();
  setStatus('');
  el.startMsg.textContent = msg || 'Open your private link to see your inbox.';
  el.readyNote.hidden = true;
  el.firstBox.hidden = true;
  show('start');
  checkServerReady();
}

// Once the server holds a link, a new link made here cannot work, so hide "Create".
// "#setup" in the address shows it anyway (for building a new server).
function checkServerReady() {
  const forceSetup = location.hash === '#setup';
  fetch(API + '/health', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((h) => {
      if (keys) return;
      const ready = !!(h && h.ready);
      el.readyNote.hidden = !ready || forceSetup;
      el.firstBox.hidden = ready && !forceSetup;
      if (forceSetup) el.firstBox.open = true;
    });
}

function showSetup(k, rotated) {
  stopPolling();
  pendingKeys = k;
  el.setupTitle.textContent = rotated ? 'Your new private link' : 'Your private link';
  el.newLink.textContent = linkFor(k.secret);
  el.newCode.textContent = k.serverCode;
  loadTemplate();
  show('setup');
}

async function openLink(secret) {
  let k;
  try { k = await deriveKeys(secret); } catch (_) { return showStart('That is not a valid link.'); }
  keys = k;
  clearCards();
  show('inbox');
  const saved = recallLang();
  if (saved && LANG_NAMES[saved]) el.lang.value = saved;
  updateSize();
  startPolling();
}

function route() {
  const s = normalizeSecret(location.hash);
  if (s) openLink(s);
  else showStart();
}

// ---------- inbox ----------
function clearCards() {
  for (const { li } of cards.values()) li.remove();
  cards.clear();
  updateEmpty();
}

function updateEmpty() {
  el.empty.hidden = cards.size > 0;
}

function remaining(expires) {
  return expires - (Date.now() + clockOffset);
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
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
  timer.textContent = fmt(remaining(item.expires));
  meta.append(lang, timer);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  const langId = data && LANG_NAMES[data.lang] ? data.lang : 'plain';
  code.className = 'language-' + langId;
  code.textContent = data ? data.text : 'This item was locked with a different link.';
  pre.append(code);
  if (data && langId !== 'plain' && data.text.length <= HIGHLIGHT_MAX && window.Prism && window.Prism.languages[langId]) {
    try { window.Prism.highlightElement(code); } catch (_) { /* show plain */ }
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
  const live = new Set(list.map((i) => i.id));
  for (const id of [...cards.keys()]) if (!live.has(id)) removeCard(id);
  let added = false;
  for (const item of list) {
    if (cards.has(item.id) || gone.has(item.id)) continue;
    let data = null;
    try {
      data = await open(keys.aesKey, item);
      if (!data || typeof data.text !== 'string') data = null;
    } catch (_) { data = null; }
    if (!keys || cards.has(item.id)) continue;
    const { li, timer } = buildCard(item, data);
    cards.set(item.id, { li, timer, item, text: data ? data.text : null });
    added = true;
  }
  if (added) {
    for (const item of list) {
      const c = cards.get(item.id);
      if (c) el.list.append(c.li);
    }
  }
  const now = Date.now();
  for (const [id, t] of gone) if (now - t > 10 * 60 * 1000) gone.delete(id);
  updateEmpty();
}

async function poll() {
  if (polling || !keys) return;
  polling = true;
  const myKeys = keys;
  try {
    const r = await api('GET', '/v1/items');
    if (keys !== myKeys) return;
    if (r.status === 401) {
      setStatus('bad');
      showStart(BAD_LINK_MSG);
      return;
    }
    if (r.status === 429) { setStatus('off'); return; }
    if (!r.ok) { setStatus('off'); return; }
    const data = await r.json();
    clockOffset = data.now - Date.now();
    await sync(data.items || []);
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
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') poll();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function tick() {
  for (const [id, c] of cards) {
    const ms = remaining(c.item.expires);
    if (ms <= 0) removeCard(id);
    else c.timer.textContent = fmt(ms);
  }
}

function copyAndDelete(id) {
  const c = cards.get(id);
  if (!c || c.text === null) return;
  copyText(c.text).then(async (ok) => {
    if (!ok) {
      toast('Copy was blocked. Nothing was deleted.');
      return;
    }
    removeCard(id);
    try {
      const r = await api('DELETE', '/v1/items/' + id);
      toast(r.ok || r.status === 404 ? 'Copied. Deleted on both devices.' : 'Copied. Delete failed; it expires within 5 minutes.');
    } catch (_) {
      toast('Copied. Server not reached; it expires within 5 minutes.');
    }
  });
}

async function deleteOnly(id) {
  removeCard(id);
  try {
    const r = await api('DELETE', '/v1/items/' + id);
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
  const text = el.paste.value;
  if (!text.trim()) return toast('Paste something first.');
  if (byteLength(text) > MAX_BYTES) return toast('Too big. Max 256 KB.');
  el.sendBtn.disabled = true;
  try {
    const box = await seal(keys.aesKey, { v: 1, lang: el.lang.value, text });
    const r = await api('POST', '/v1/items', box);
    if (r.status === 201) {
      el.paste.value = '';
      updateSize();
      toast('Sent. Gone after copy, or in 5 minutes.');
      poll();
    } else if (r.status === 413) toast('Too big. Max 256 KB.');
    else if (r.status === 409) toast('Inbox full. Copy or delete some first.');
    else if (r.status === 401) showStart(BAD_LINK_MSG);
    else toast('Could not send. Try again.');
  } catch (_) {
    toast('Cannot reach the server.');
  } finally {
    el.sendBtn.disabled = false;
  }
}

// ---------- wiring ----------
el.openBtn.addEventListener('click', () => {
  const s = normalizeSecret(el.linkIn.value);
  if (!s) return toast('That is not a valid link or key.');
  el.linkIn.value = '';
  location.hash = s;
});
el.linkIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.openBtn.click(); });

el.createBtn.addEventListener('click', async () => {
  showSetup(await deriveKeys(newSecret()), false);
});
el.copyLink.addEventListener('click', () => {
  if (!pendingKeys) return;
  copyText(linkFor(pendingKeys.secret)).then((ok) => toast(ok ? 'Link copied. Save it as a bookmark.' : 'Copy was blocked.'));
});
el.copySetup.addEventListener('click', () => { if (pendingKeys) copySetupScript(pendingKeys.serverCode); });
el.goNew.addEventListener('click', () => {
  if (!pendingKeys) return;
  const s = pendingKeys.secret;
  pendingKeys = null;
  if (normalizeSecret(location.hash) === s) route();
  else location.hash = s;
});

el.paste.addEventListener('input', updateSize);
el.paste.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendNow(); }
});
el.sendBtn.addEventListener('click', sendNow);
el.lang.addEventListener('change', () => rememberLang(el.lang.value));

twoTap(el.wipeBtn, 'Delete everything now', async () => {
  try {
    const r = await api('DELETE', '/v1/items');
    if (r.ok) { for (const id of [...cards.keys()]) removeCard(id); toast('Everything deleted.'); }
    else toast('Could not delete. Try again.');
  } catch (_) { toast('Cannot reach the server.'); }
});

twoTap(el.rotateBtn, 'Make a new link (old one stops working)', async () => {
  try {
    const k = await deriveKeys(newSecret());
    const r = await api('POST', '/v1/rotate', { hash: k.serverCode });
    if (r.status === 204) showSetup(k, true);
    else toast('Could not make a new link. Nothing changed.');
  } catch (_) { toast('Cannot reach the server. Nothing changed.'); }
});

el.setupAgain.addEventListener('click', () => { if (keys) copySetupScript(keys.serverCode); });

// Hand the link to another of your devices. On iPhone and Mac the share sheet offers AirDrop.
el.shareBtn.addEventListener('click', () => {
  if (!keys) return;
  const link = linkFor(keys.secret);
  if (navigator.share) {
    navigator.share({ title: 'Drop', url: link }).catch(() => {});
    return;
  }
  copyText(link).then((ok) => toast(ok ? 'Link copied. Paste it on your other device, then bookmark it.' : 'Copy was blocked.'));
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && keys) poll();
});
window.addEventListener('hashchange', route);
setInterval(tick, 1000);
loadTemplate();
route();
