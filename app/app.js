/* Store Manager PWA — offline-first POS, stock, credit and dual-currency accounting.
 * Talks to the Apps Script backend (Api.gs). No build step, no libraries.
 */
'use strict';

const APP_VERSION = '1.6.0';
const PIN_ROUNDS_DEFAULT = 100;
const ICON_SRC = (typeof window !== 'undefined' && window.SM_ICON) || 'icons/icon-192.png';
const AUTO_SYNC_MS = 120000;   // push + pull every 2 minutes while the app is open
const PUSH_BATCH = 50;
// Running inside the Apps Script web app (App.html)? Then talk to the server via google.script.run.
const GAS = typeof google !== 'undefined' && google.script && google.script.run;

/* =====================================================================
 * Storage (IndexedDB key/value)
 * ===================================================================== */
/* Several copies of this app can live on one web address (e.g. two GitHub Pages sites on <you>.github.io).
 * The first copy keeps the original storage names (so phones already set up keep working);
 * any other copy gets its own, so they never share a device login or unsynced sales. */
const APP_NS = (() => {
  if (GAS || window.Capacitor) return '';
  const dir = location.pathname.replace(/[^/]*$/, '');
  try {
    let owner = localStorage.getItem('sm-owner');
    if (!owner) { localStorage.setItem('sm-owner', dir); owner = dir; }
    return owner === dir ? '' : dir;
  } catch (e) { return ''; }
})();
const lsKey = (k) => (APP_NS ? APP_NS + '|' : '') + k;
const KV = (() => {
  let dbp;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('store-manager' + (APP_NS ? ':' + APP_NS : ''), 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  };
  // Fallback when IndexedDB is unavailable (some embedded / private browsing contexts): localStorage, then memory.
  const mem = {};
  const ls = {
    get: async (k) => { try { const v = localStorage.getItem(lsKey('sm:' + k)); return v === null ? undefined : JSON.parse(v); } catch (e) { return mem[k]; } },
    set: async (k, v) => { try { localStorage.setItem(lsKey('sm:' + k), JSON.stringify(v)); } catch (e) { mem[k] = v; } },
    del: async (k) => { try { localStorage.removeItem(lsKey('sm:' + k)); } catch (e) { delete mem[k]; } }
  };
  let useLs = typeof indexedDB === 'undefined';
  const wrap = (name, fn) => async (k, v) => {
    if (useLs) return ls[name](k, v);
    try { return await fn(k, v); } catch (e) { useLs = true; return ls[name](k, v); }
  };
  return {
    get: wrap('get', (k) => tx('readonly', (s) => s.get(k))),
    set: wrap('set', (k, v) => tx('readwrite', (s) => s.put(v, k))),
    del: wrap('del', (k) => tx('readwrite', (s) => s.delete(k)))
  };
})();

/* =====================================================================
 * State
 * ===================================================================== */
const S = {
  cfg: null,        // { url, deviceId, deviceKey, deviceName }
  snap: null,       // last pull from the server
  queue: [],        // [{ rec, status: pending|sent|failed, error, createdAt }]
  journal: [],      // records created on this device (last 500), for history, receipts, shift totals
  session: null,    // { user, permissions, role, token, tokenExp }
  shift: null,      // open shift on this device
  counter: 0,       // receipt counter
  view: 'pos',
  cart: { lines: [], discountUSD: 0, customerId: '' },
  ui: { cat: 'All', q: '', showCart: false, adminTab: null, reportPeriod: 'today', reportStore: 'mine' },
  syncing: false,
  lastSync: null,
  lastError: '',
  admin: null       // cached adminData
};

const persist = {
  queue: () => KV.set('queue', S.queue),
  journal: () => KV.set('journal', S.journal.slice(-500)),
  snap: () => KV.set('snap', S.snap),
  session: () => KV.set('session', S.session),
  misc: () => KV.set('misc', { counter: S.counter, shift: S.shift, lastSync: S.lastSync })
};

/* =====================================================================
 * Helpers
 * ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const nowISO = () => new Date().toISOString();

/* ---------- icons (inline SVG, stroke style) ---------- */
const ICONS = {
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.5 11.6a1.8 1.8 0 0 0 1.8 1.4h8.3a1.8 1.8 0 0 0 1.8-1.4L21 7.5H6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  truck: '<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  wallet: '<rect x="2.5" y="6" width="19" height="14" rx="2.5"/><path d="M2.5 10.5h19M16 15h2.5M5.5 6l9.5-3 1.2 3"/>',
  users: '<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.6 3.6 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7.5 16v-3M12 16V9M16.5 16V6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8M4 13a8 8 0 0 0 14.3 4.6L20 16"/><path d="M4 3.5V8h4.5M20 20.5V16h-4.5"/>',
  logout: '<path d="M9 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3H9"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>', arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4h6v3"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="2.5" y="9" width="19" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  store: '<path d="M3 9.5 4.5 4h15L21 9.5M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M4.5 12.5V20h15v-7.5"/><path d="M9.5 20v-5h5v5"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2zM4 19.5A2 2 0 0 0 6 21.5h14"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.5 8.5 0 1 1 21 11.5z"/>',
  bag: '<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17.5v.5"/>'
};
const icon = (name, size) => `<svg class="i ${size || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const fmtUSD = (n) => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtLRD = (n) => 'L$' + Math.round(num(n)).toLocaleString('en-US');
const fmtCur = (n, c) => (c === 'USD' ? fmtUSD(n) : fmtLRD(n));
const fmtQty = (q) => (Math.round(num(q) * 100) / 100).toLocaleString('en-US');
const fmtDate = (d) => { const x = new Date(d); return isNaN(x) ? '' : x.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const rate = () => num(S.snap && S.snap.rate) || 1;
const toUSD = (amt, cur) => (cur === 'USD' ? num(amt) : num(amt) / rate());
const toLRD = (amt, cur) => (cur === 'LRD' ? num(amt) : num(amt) * rate());
const setting = (k) => { const r = (S.snap && S.snap.settings || []).find((x) => x.Key === k); return r ? r.Value : undefined; };
const bool = (v) => v === true || String(v).toUpperCase() === 'TRUE';
/** Parts of the app the owner can switch off (Admin → Features). On unless switched off. */
const feature = (k) => { const v = setting('Feature_' + k); return !(v === false || String(v).toUpperCase() === 'FALSE'); };
const store = () => (S.snap && S.snap.store) || { Name: 'Store', Code: '', Type: 'SHOP' };
const storeName = (id) => { if (id === 'HQ') return 'Head Office'; const s = (S.snap.stores || []).find((x) => x.StoreID === id); return s ? s.Name : id; };
const can = (p) => !!S.session && (S.session.permissions[0] === '*' || S.session.permissions.indexOf(p) >= 0);
const canAny = (...ps) => ps.some(can);
const isOwner = () => S.session && S.session.role && S.session.role.RoleID === 'OWNER';
const productById = (id) => (S.snap.products || []).find((p) => p.ProductID === id);
const userName = (id) => { const u = (S.snap.users || []).find((x) => x.UserID === id); return u ? u.FullName : id; };
const isYard = (p) => /yard|metre|meter|kg|litre|liter/i.test(p.Unit || '');

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPin(pin, salt) {
  let h = String(pin);
  const rounds = num(S.snap && S.snap.pinRounds) || PIN_ROUNDS_DEFAULT;
  for (let i = 0; i < rounds; i++) h = await sha256hex(salt + ':' + h);
  return h;
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3000);
}

/* =====================================================================
 * API
 * ===================================================================== */
function gasCall(payload) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((txt) => { try { resolve(JSON.parse(txt)); } catch (e) { reject(Object.assign(new Error('Unexpected server reply'), { code: 'BAD_REPLY' })); } })
      .withFailureHandler((err) => reject(Object.assign(new Error(navigator.onLine ? 'Server error: ' + (err && err.message || err) : 'Cannot reach the server — check the internet connection'), { code: navigator.onLine ? 'SERVER' : 'NETWORK' })))
      .apiCall(JSON.stringify(payload));
  });
}

async function api(action, body = {}, opts = {}) {
  if (GAS) {
    const payload = Object.assign({ action }, body);
    if (S.cfg && S.cfg.deviceId) { payload.deviceId = S.cfg.deviceId; payload.deviceKey = S.cfg.deviceKey; }
    if (opts.token) payload.token = S.session && S.session.token;
    const j = await gasCall(payload);
    if (!j.ok) throw Object.assign(new Error(j.message || j.error), { code: j.error });
    return j;
  }
  const url = (opts.url || (S.cfg && S.cfg.url) || '').trim();
  if (!url) throw Object.assign(new Error('No server address set'), { code: 'NO_URL' });
  const payload = Object.assign({ action }, body);
  if (S.cfg && S.cfg.deviceId) { payload.deviceId = S.cfg.deviceId; payload.deviceKey = S.cfg.deviceKey; }
  if (opts.token) payload.token = S.session && S.session.token;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    throw Object.assign(new Error('Cannot reach the server — check the internet connection'), { code: 'NETWORK' });
  } finally { clearTimeout(t); }
  let j;
  try { j = await res.json(); } catch (e) { throw Object.assign(new Error('Server sent an unexpected reply (is the URL the /exec web app address?)'), { code: 'BAD_REPLY' }); }
  if (!j.ok) throw Object.assign(new Error(j.message || j.error), { code: j.error });
  return j;
}

/* online admin call with token; re-login hint when expired */
async function adminCall(action, body) {
  if (!S.session.token || Date.now() > S.session.tokenExp) {
    throw Object.assign(new Error('Online session needed — log out and log in again while connected'), { code: 'AUTH' });
  }
  try { return await api(action, body, { token: true }); }
  catch (e) {
    if (e.code === 'AUTH' || e.code === 'AUTH_EXPIRED') { S.session.token = ''; persist.session(); }
    throw e;
  }
}

/* =====================================================================
 * Offline queue & sync
 * ===================================================================== */
function enqueue(type, data) {
  const rec = Object.assign({ id: uuid(), type, userId: S.session.user.UserID, timestamp: nowISO(), rate: rate() }, data);
  S.queue.push({ rec, status: 'pending', createdAt: rec.timestamp });
  S.journal.push(rec);
  persist.queue(); persist.journal();
  scheduleSync(2500);
  return rec;
}

let syncTimer = null;
function scheduleSync(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(false), ms);
}

async function sync(manual) {
  if (!S.cfg || S.syncing) return;
  S.syncing = true; renderStatus();
  try {
    const pending = S.queue.filter((q) => q.status === 'pending');
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH);
      const res = await api('push', { records: batch.map((q) => q.rec) });
      const ok = new Set(res.accepted.concat(res.duplicates));
      const rej = {}; res.rejected.forEach((r) => { rej[r.id] = r; });
      batch.forEach((q) => {
        if (ok.has(q.rec.id)) q.status = 'sent';
        else if (rej[q.rec.id]) { q.status = 'failed'; q.error = rej[q.rec.id].message; }
      });
      await persist.queue();
      if (res.rejected.length) toast(res.rejected.length + ' record(s) were rejected by the server — see Sync', 'bad');
    }
    const snap = await api('pull');
    S.snap = snap;
    S.queue = S.queue.filter((q) => q.status === 'pending' || q.status === 'failed');
    S.lastSync = nowISO(); S.lastError = '';
    await Promise.all([persist.snap(), persist.queue(), persist.misc()]);
    // current user removed or blocked?
    if (S.session && !(snap.users || []).some((u) => u.UserID === S.session.user.UserID && u.Status === 'ACTIVE')) {
      toast('Your account is no longer active on this store', 'bad');
      logout();
    }
    if (manual) toast('Synced', 'ok');
  } catch (e) {
    S.lastError = e.message;
    if (e.code === 'DEVICE_BLOCKED' || e.code === 'DEVICE_AUTH' || e.code === 'STORE_CLOSED') toast(e.message, 'bad');
    else if (manual) toast(e.message, 'bad');
  } finally {
    S.syncing = false;
    render();
  }
}

/* Local view = last server snapshot + effect of records not yet included in it */
function liveRecords() { return S.queue.filter((q) => q.status === 'pending' || q.status === 'sent').map((q) => q.rec); }

function stockMap() {
  const m = {};
  (S.snap.stock || []).forEach((s) => { m[s.ProductID] = num(s.Qty); });
  const my = store().StoreID;
  const add = (pid, q) => { m[pid] = (m[pid] || 0) + q; };
  liveRecords().forEach((r) => {
    if (r.type === 'sale') r.items.forEach((i) => add(i.productId, -num(i.qty)));
    if (r.type === 'stockIntake') r.items.forEach((i) => add(i.productId, num(i.qty)));
    if (r.type === 'stockAdjust') r.items.forEach((i) => add(i.productId, num(i.qty)));
    if (r.type === 'transfer' && r.mode === 'SEND' && r.fromStoreId === my) r.items.forEach((i) => add(i.productId, -num(i.qty)));
    if (r.type === 'transferAction' && (r.action === 'DISPATCH' || r.action === 'RECEIVE')) {
      (r._items || []).forEach((i) => add(i.productId, r.action === 'DISPATCH' ? -num(i.qty) : num(i.qty)));
    }
  });
  return m;
}

function customers() {
  const list = (S.snap.customers || []).map((c) => Object.assign({}, c));
  const byId = {}; list.forEach((c) => { byId[c.CustomerID] = c; });
  liveRecords().forEach((r) => {
    if (r.type === 'customer' && !byId[r.id]) {
      const c = { CustomerID: r.id, Name: r.name, Phone: r.phone || '', Notes: r.notes || '', CreditLimitUSD: r.creditLimitUSD || 0, BalanceUSD: 0, _pending: true };
      list.push(c); byId[c.CustomerID] = c;
    }
  });
  liveRecords().forEach((r) => {
    if (r.type === 'sale' && r.customerId && byId[r.customerId]) {
      r.payments.filter((p) => p.method === 'CREDIT').forEach((p) => { byId[r.customerId].BalanceUSD += toUSDAt(p.amount, p.currency, r.rate); });
    }
    if (r.type === 'customerPayment' && byId[r.customerId]) byId[r.customerId].BalanceUSD -= toUSDAt(r.amount, r.currency, r.rate);
  });
  return list.sort((a, b) => a.Name.localeCompare(b.Name));
}
const toUSDAt = (amt, cur, rt) => (cur === 'USD' ? num(amt) : num(amt) / num(rt || rate()));

function transfers() {
  const list = (S.snap.transfers || []).map((t) => Object.assign({}, t, {
    items: (S.snap.transferItems || []).filter((i) => i.TransferID === t.TransferID).map((i) => Object.assign({}, i))
  }));
  const byId = {}; list.forEach((t) => { byId[t.TransferID] = t; });
  liveRecords().forEach((r) => {
    if (r.type === 'transfer' && !byId[r.id]) {
      const t = { TransferID: r.id, CreatedAt: r.timestamp, FromStoreID: r.fromStoreId, ToStoreID: r.toStoreId, Note: r.note,
        Status: r.mode === 'SEND' ? 'DISPATCHED' : (bool(setting('TransferApproval')) ? 'REQUESTED' : 'APPROVED'), _pending: true,
        items: r.items.map((i) => ({ ProductID: i.productId, QtyRequested: i.qty, QtySent: r.mode === 'SEND' ? i.qty : '' })) };
      list.unshift(t); byId[t.TransferID] = t;
    }
    if (r.type === 'transferAction' && byId[r.transferId]) {
      const t = byId[r.transferId];
      t.Status = { APPROVE: 'APPROVED', DISPATCH: 'DISPATCHED', RECEIVE: 'RECEIVED', CANCEL: 'CANCELLED' }[r.action] || t.Status;
      if (r.action === 'DISPATCH') (r._items || []).forEach((i) => { const it = t.items.find((x) => x.ProductID === i.productId); if (it) it.QtySent = i.qty; });
      if (r.action === 'RECEIVE') (r._items || []).forEach((i) => { const it = t.items.find((x) => x.ProductID === i.productId); if (it) it.QtyReceived = i.qty; });
      t._pending = true;
    }
  });
  const open = { REQUESTED: 0, APPROVED: 0, DISPATCHED: 0 };
  return list.sort((a, b) => ((a.Status in open ? 0 : 1) - (b.Status in open ? 0 : 1)) || String(b.CreatedAt).localeCompare(String(a.CreatedAt)));
}

/* =====================================================================
 * Boot
 * ===================================================================== */
async function boot() {
  S.cfg = await KV.get('cfg');
  S.snap = await KV.get('snap');
  S.queue = (await KV.get('queue')) || [];
  S.journal = (await KV.get('journal')) || [];
  const misc = (await KV.get('misc')) || {};
  S.counter = misc.counter || 0; S.shift = misc.shift || null; S.lastSync = misc.lastSync || null;
  const sess = await KV.get('session');
  if (sess && sess.expiresAt > Date.now() && S.snap) S.session = sess;
  if (S.session) S.view = defaultView();
  render();
  if (S.cfg) sync(false);
  setInterval(() => { if (S.cfg && navigator.onLine) sync(false); }, AUTO_SYNC_MS);
  window.addEventListener('online', () => { renderStatus(); sync(false); });
  window.addEventListener('offline', renderStatus);
  if (!GAS && !window.Capacitor && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const ready = () => { if (reg.waiting && navigator.serviceWorker.controller && !S.updateReady) { S.updateReady = reg; render(); } };
      ready();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') ready(); });
      });
      const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
      setInterval(check, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.updating) { S.updating = false; location.reload(); } });
  }
}

function defaultView() {
  if (store().Type === 'SHOP' && can('POS_SELL')) return 'pos';
  if (store().Type === 'HQ') return canAny('REPORTS_ALL', 'REPORTS_STORE') ? 'reports' : 'admin';
  return 'stock';
}

/* =====================================================================
 * Rendering
 * ===================================================================== */
let rendering = false;
function render() {
  // a field losing focus while the screen is being redrawn can ask for another redraw: do it right after
  if (rendering) { setTimeout(render, 0); return; }
  rendering = true;
  try { renderNow(); } finally { rendering = false; }
}
function renderNow() {
  applyTheme();
  const app = $('#app');
  const active = document.activeElement;
  const keepId = active && active.id;
  const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  // remember where each scrolling area was, so updating the screen doesn't make it jump
  const scrolls = ['.main', '#cart-panel', '.cart-lines'].map((q) => { const e = $(q); return e ? [q, e.scrollTop] : null; }).filter(Boolean);
  if (!S.cfg || !S.snap) app.innerHTML = viewDeviceSetup();
  else if (!S.session) app.innerHTML = viewLogin();
  else app.innerHTML = viewShell();
  if (keepId) {
    const el = document.getElementById(keepId);
    if (el) { el.focus(); try { if (caret !== null) el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
  }
  scrolls.forEach(([q, top]) => { const e = $(q); if (e) e.scrollTop = top; });
  S.ui.sheetAnim = false;
}

function renderStatus() {
  const el = $('#sync-chip');
  if (el) el.outerHTML = syncChip();
}

function syncChip() {
  const pend = S.queue.filter((q) => q.status === 'pending').length;
  const failed = S.queue.filter((q) => q.status === 'failed').length;
  const online = navigator.onLine;
  let cls = 'pill', text;
  if (S.syncing) { cls += ' busy'; text = 'Syncing…'; }
  else if (!online) { cls += ' off'; text = 'Offline' + (pend ? ' · ' + pend : ''); }
  else if (failed) { cls += ' off'; text = failed + ' failed'; }
  else if (pend) { cls += ' pending'; text = pend + ' to sync'; }
  else { cls += ' synced-ok'; text = 'Synced'; }
  return `<button id="sync-chip" class="${cls}" data-act="go" data-view="sync" title="Sync status"><span class="dot"></span><span class="lbl">${text}</span></button>`;
}

/* ---------- theme ---------- */
const SWATCH_GROUPS = [
  ['Pinks & reds', ['#D1217E', '#EC4899', '#DB2777', '#BE185D', '#E11D48', '#BE123C', '#DC2626', '#991B1B']],
  ['Oranges & golds', ['#EA580C', '#F97316', '#D97706', '#CA8A04', '#B45309', '#A16207', '#92400E', '#C2410C']],
  ['Greens', ['#15803D', '#16A34A', '#059669', '#047857', '#4D7C0F', '#65A30D', '#166534', '#14532D']],
  ['Teals & blues', ['#0F766E', '#0D9488', '#0891B2', '#00AEEF', '#0284C7', '#2563EB', '#1D4ED8', '#1E3A8A']],
  ['Purples', ['#7C3AED', '#6D28D9', '#9333EA', '#A21CAF', '#C026D3', '#4F46E5', '#4338CA', '#581C87']],
  ['Neutrals', ['#111827', '#1F2937', '#374151', '#475569', '#57534E', '#78716C', '#0F4C5C', '#3F3F46']]
];
const SWATCHES = SWATCH_GROUPS.reduce((a, g) => a.concat(g[1]), []);
const CAT_COLORS = [['#e0f2fe', '#0369a1'], ['#fce7f3', '#be185d'], ['#ede9fe', '#6d28d9'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#ffe4e6', '#be123c'], ['#e0e7ff', '#4338ca'], ['#ccfbf1', '#0f766e']];
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
function mix(c1, c2, t) { return rgbToHex(c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t); }
const BRAND = Object.assign({ name: 'Store Manager', color: '#0F766E' }, window.SM_BRAND || {});
function themeColor() { return (S.snap && store().Color) || setting('ThemeColor') || BRAND.color; }
function applyTheme() {
  let mode = 'auto';
  try { mode = localStorage.getItem(lsKey('sm-mode')) || 'auto'; } catch (e) { /* ignore */ }
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const rgb = hexToRgb(themeColor()) || [15, 118, 110];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  root.style.setProperty('--brand', rgbToHex(...rgb));
  root.style.setProperty('--brand-ink', mix(rgb, [0, 0, 0], dark ? -0.15 : 0.22));
  root.style.setProperty('--brand-soft', dark ? mix(rgb, [22, 27, 34], 0.72) : mix(rgb, [255, 255, 255], 0.88));
  root.style.setProperty('--brand-tint', dark ? mix(rgb, [22, 27, 34], 0.85) : mix(rgb, [255, 255, 255], 0.95));
  root.style.setProperty('--on-brand', lum > 0.62 ? '#111827' : '#ffffff');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', rgbToHex(...rgb));
}
function catColor(cat) {
  let h = 0; String(cat || '').split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
  return CAT_COLORS[h % CAT_COLORS.length];
}
const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/* ---------- install the app / update it ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (typeof render === 'function' && S && !S.session) render(); });
window.addEventListener('appinstalled', () => { installEvt = null; toast(BRAND.name + ' is installed — open it from your home screen', 'ok'); if (!S.session) render(); });
const isInstalled = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true || !!window.Capacitor;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function installCard(always) {
  if (GAS || isInstalled() || location.protocol === 'file:') return '';
  if (!always) { try { if (Date.now() - Number(localStorage.getItem(lsKey('sm-install-later')) || 0) < 3 * 864e5) return ''; } catch (e) { /* ignore */ } }
  const later = always ? '' : '<button class="btn ghost sm" data-act="install-later">Not now</button>';
  if (installEvt) return `<div class="install-card"><div class="ic">${icon('download')}</div><div class="grow"><b>Install ${esc(BRAND.name)}</b>
      <div class="small">Opens like a normal app and works without internet. Your other apps are not touched.</div></div>
      <button class="btn primary sm" data-act="install-app">Install</button>${later}</div>`;
  if (isIOS()) return `<div class="install-card"><div class="ic">${icon('download')}</div><div class="grow"><b>Install ${esc(BRAND.name)}</b>
      <div class="small">In Safari tap <b>Share</b> ${icon('share', 'sm')} then <b>Add to Home Screen</b>.</div></div>${later}</div>`;
  return always ? `<div class="install-card"><div class="ic">${icon('download')}</div><div class="grow"><b>Install ${esc(BRAND.name)}</b>
      <div class="small">Open this page in Chrome, then menu ⋮ → <b>Install app</b> (or <b>Add to Home screen</b>). On a laptop use the install icon in the address bar.</div></div></div>` : '';
}
function updateBanner() {
  if (!S.updateReady) return '';
  return `<div class="update-card"><div class="ic">${icon('sync')}</div><div class="grow"><b>A new version of the app is ready</b>
    <div class="small">Takes a few seconds. Your sales and data stay safe.</div></div>
    <button class="btn primary sm" data-act="app-update">Update now</button></div>`;
}
// the phone's Back button closes the cart sheet instead of leaving the app
window.addEventListener('popstate', () => { if (S.ui && S.ui.showCart) { S.ui.showCart = false; render(); } });
const INSTALL_ACTS = {
  'install-app': async () => {
    if (!installEvt) return;
    const e = installEvt; installEvt = null;
    e.prompt();
    try { const c = await e.userChoice; if (c && c.outcome !== 'accepted') installEvt = e; } catch (x) { /* ignore */ }
    render();
  },
  'install-later': () => { try { localStorage.setItem(lsKey('sm-install-later'), String(Date.now())); } catch (e) { /* ignore */ } render(); },
  'app-update': () => {
    if (S.cart && S.cart.lines && S.cart.lines.length) { toast('Finish or clear the current sale first, then update', 'bad'); return; }
    const reg = S.updateReady; if (!reg) return;
    S.updating = true;
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => location.reload(), 4000);
  }
};

/* ---------- device setup ---------- */
function viewDeviceSetup() {
  const params = new URLSearchParams(location.search);
  let saved = ''; try { saved = localStorage.getItem(lsKey('sm-url')) || ''; } catch (e) { /* ignore */ }
  const url = (S.cfg && S.cfg.url) || params.get('api') || saved || window.SM_DEFAULT_API || '';
  return `<div class="auth-wrap"><div class="auth">
    <div class="auth-head"><div class="logo">${icon('store', 'lg')}</div><div><div class="k">${esc(BRAND.name)}</div><h2>Connect this device</h2></div></div>
    ${updateBanner()}${installCard()}
    <form data-form="register" class="auth-body">
      ${GAS ? '' : `<div class="field"><label for="f-url">Server address</label>
        <input id="f-url" name="url" type="url" required placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}"></div>`}
      <div class="field"><label for="f-code">Setup code</label>
        <input id="f-code" name="code" type="text" required autocomplete="off" placeholder="e.g. K7Q2M9XD" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;font-size:1.15rem;text-align:center"></div>
      <div class="field"><label for="f-name">Device name</label>
        <input id="f-name" name="name" type="text" required placeholder="e.g. Waterside Till 1"></div>
      <button class="btn primary block big" type="submit">Connect device ${icon('arrow')}</button>
      <p class="muted small" style="margin:1rem 0 0">Ask the owner or a manager for a setup code. In the Google Sheet: <b>Store Manager → Create device setup code</b>, or in this app: <b>Admin → Devices</b>. Each code works once.</p>
    </form>
  </div></div>`;
}

/* ---------- login ---------- */
let pinEntry = '';
let loginUser = null;
function viewLogin() {
  const users = (S.snap.users || []).filter((u) => u.Status === 'ACTIVE');
  const roles = {}; (S.snap.roles || []).forEach((r) => { roles[r.RoleID] = r.RoleName; });
  const sel = users.find((u) => u.UserID === loginUser);
  const dots = Math.max(4, pinEntry.length);
  return `<div class="auth-wrap"><div class="auth">
    <div class="auth-head"><div class="logo">${esc(initials(store().Name))}</div>
      <div class="grow"><div class="k">${esc(setting('BusinessName') || BRAND.name)}</div><h2>${esc(store().Name)}</h2></div></div>
    ${updateBanner()}${installCard()}
    <div class="auth-body">
      ${!sel ? `<label>Who is working?</label><div class="users">
        ${users.map((u) => `<button class="user-tile" data-act="pick-user" data-id="${esc(u.UserID)}"><span class="avatar">${esc(initials(u.FullName))}</span>
          <span><b>${esc(u.FullName)}</b><span class="r">${esc(roles[u.RoleID] || u.RoleID)}</span></span></button>`).join('') || '<div class="muted">No users for this store yet.</div>'}
      </div>` : `
      <div class="row between"><div class="row"><span class="avatar" style="width:40px;height:40px">${esc(initials(sel.FullName))}</span>
        <div><b>${esc(sel.FullName)}</b><div class="muted small">${esc(roles[sel.RoleID] || '')}</div></div></div>
        <button class="btn ghost sm" data-act="pick-user" data-id="">Change</button></div>
      <div class="pin-dots">${Array.from({ length: dots }, (_, i) => `<span class="${i < pinEntry.length ? 'on' : ''}"></span>`).join('')}</div>
      <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⏎'].map((k) =>
        `<button data-act="pin" data-k="${k}" class="${k === '⏎' ? 'go' : k === 'C' ? 'clr' : ''}">${k === '⏎' ? icon('arrow', 'lg') : k === 'C' ? 'Clear' : k}</button>`).join('')}</div>`}
    </div>
    <div class="auth-foot"><span>${syncChip().replace('data-act="go" data-view="sync"', 'data-act="sync-now"')}</span>
      <span>${esc(S.cfg.deviceName || '')} · v${APP_VERSION}</span>
      <button class="btn ghost sm" data-act="reset-device">Disconnect</button></div>
  </div></div>`;
}

async function doLogin() {
  const u = (S.snap.users || []).find((x) => x.UserID === loginUser);
  if (!u) return;
  const pin = pinEntry;
  pinEntry = '';
  let session = null;
  if (navigator.onLine) {
    try {
      const r = await api('login', { username: u.Username, pin });
      session = { user: r.user, permissions: r.permissions, role: r.role, token: r.token, tokenExp: Date.now() + r.tokenHours * 3600e3 - 60e3 };
    } catch (e) {
      if (e.code !== 'NETWORK' && e.code !== 'BAD_REPLY') { toast(e.message, 'bad'); render(); return; }
    }
  }
  if (!session) {
    const h = await hashPin(pin, u.PinSalt);
    if (h !== u.PinHash) { toast('Wrong PIN', 'bad'); render(); return; }
    const role = (S.snap.roles || []).find((r) => r.RoleID === u.RoleID) || {};
    session = { user: u, permissions: String(u.Permissions || '').split(',').filter(Boolean), role, token: '', tokenExp: 0 };
    toast('Logged in offline — reports and admin need internet', '');
  }
  session.expiresAt = Date.now() + 14 * 3600e3;
  S.session = session;
  loginUser = null;
  S.view = defaultView();
  S.admin = null;
  await persist.session();
  reportCache = null;
  render();
  if (S.view === 'reports' && S.session.token) loadReport();
}

function logout() {
  S.session = null; S.cart = { lines: [], discountUSD: 0, customerId: '' }; S.admin = null;
  KV.del('session');
  render();
}

/* ---------- shell ---------- */
function navItems() {
  const shop = store().Type === 'SHOP';
  const items = [];
  if (shop && can('POS_SELL')) items.push(['pos', 'cart', 'Sell']);
  if (shop && feature('OnlineShop') && can('ORDERS_MANAGE') && (bool(store().OnlineShop) || (S.snap.orders || []).length)) { const n = newOrderCount(); items.push(['orders', 'bag', 'Orders' + (n ? ' · ' + n : '')]); }
  if (store().Type !== 'HQ') items.push(['stock', 'box', 'Stock']);
  if (feature('MultiStore') && canAny('TRANSFER_REQUEST', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIVE', 'TRANSFER_APPROVE')) items.push(['transfers', 'truck', 'Transfers']);
  if (feature('Money') && store().Type !== 'HQ' && canAny('EXPENSE_RECORD', 'INCOME_RECORD')) items.push(['money', 'wallet', 'Money']);
  if (feature('Credit') && canAny('CREDIT_SALE', 'CREDIT_COLLECT', 'CUSTOMER_MANAGE')) items.push(['customers', 'users', 'Customers']);
  if (feature('Contracts') && can('CONTRACT_MANAGE')) items.push(['contracts', 'file', 'Quotes & invoices']);
  if (shop && canAny('POS_SELL', 'REPORTS_STORE')) items.push(['receipts', 'receipt', 'Receipts']);
  if (shop && feature('Shifts') && can('SHIFT_OPEN_CLOSE')) items.push(['shift', 'clock', 'Shift']);
  if (canAny('REPORTS_STORE', 'REPORTS_ALL')) items.push(['reports', 'chart', 'Reports']);
  if (canAny('STORE_MANAGE', 'USER_MANAGE', 'DEVICE_MANAGE', 'PRODUCT_MANAGE', 'SETTINGS_MANAGE', 'RATE_SET_GLOBAL', 'RATE_SET_STORE', 'PRICE_MANAGE', 'SHOP_MANAGE', 'FEATURES_MANAGE')) items.push(['admin', 'sliders', 'Admin']);
  items.push(['sync', 'sync', 'Sync']);
  return items;
}

function brandLogo(st) {
  const u = setting('ShopLogoURL');
  if (!u) return esc(initials(st.Name));
  const src = /lh3\.googleusercontent\.com\/d\/[\w-]+$/.test(u) ? u + '=w120' : u;
  return `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${esc(initials(st.Name)).replace(/'/g, '')}'))">`;
}
function viewShell() {
  const items = navItems();
  if (!items.some((i) => i[0] === S.view)) S.view = items[0][0];
  const st = store();
  const u = S.session.user;
  const views = { pos: viewPOS, stock: viewStock, transfers: viewTransfers, money: viewMoney, customers: viewCustomers,
    shift: viewShift, reports: viewReports, admin: viewAdmin, sync: viewSync, orders: viewOrders, contracts: viewContracts, receipts: viewReceipts };
  const typeLabel = st.Type === 'WAREHOUSE' ? 'Warehouse' : st.Type === 'HQ' ? 'Head office' : 'Shop';
  return `<div class="shell">
    <header class="topbar">
      <div class="store-id"><div class="logo">${brandLogo(st)}</div>
        <div class="t"><div class="n">${esc(st.Name)}</div><div class="b">${esc(setting('BusinessName') || '')} · ${typeLabel}</div></div></div>
      <button class="pill rate-pill" data-act="go" data-view="${can('RATE_SET_GLOBAL') || can('RATE_SET_STORE') ? 'admin' : S.view}" title="Exchange rate">${icon('swap', 'sm')}<span class="hide-sm">1 USD =</span> ${rate()}<span class="hide-sm"> LRD</span></button>
      ${syncChip()}
      <button class="me" data-act="logout" title="Log out"><span class="avatar">${esc(initials(u.FullName))}</span>
        <span class="who">${esc(u.FullName.split(' ')[0])}<span>${feature('Staff') ? esc((S.session.role && S.session.role.RoleName) || '') : ''}</span></span>${icon('logout', 'sm')}</button>
    </header>
    <nav class="nav">
      <div class="brandmark"><div class="logo">${brandLogo(st)}</div><div><div class="n">${esc(st.Name)}</div><div class="b">${esc(setting('BusinessName') || '')}</div></div></div>
      ${(() => {
        // on phones: the 4 most-used screens + "More"; laptops/tablets show everything in the side bar
        const RANK = { pos: 1, orders: 2, stock: 3, money: 4, reports: 5, contracts: 6, customers: 7, receipts: 8, transfers: 9, shift: 10, admin: 11, sync: 12 };
        const main = items.length > 5 ? items.slice().sort((a, b) => (RANK[a[0]] || 50) - (RANK[b[0]] || 50)).slice(0, 4).map((i) => i[0]) : items.map((i) => i[0]);
        const extraOn = main.indexOf(S.view) < 0;
        return items.map((i) => `<button class="${S.view === i[0] ? 'on' : ''} ${main.indexOf(i[0]) < 0 ? 'xtra' : ''}" data-act="go" data-view="${i[0]}">${icon(i[1])}<span>${i[2]}</span></button>`).join('') +
          (items.length > 5 ? `<button class="more-btn ${extraOn ? 'on' : ''}" data-act="nav-more">${icon('menu')}<span>More</span></button>` : '');
      })()}
      <div class="navfoot">${esc(S.cfg.deviceName || '')}<br>${esc(BRAND.name)} · v${APP_VERSION}</div>
    </nav>
    <main class="main"><div class="page">${updateBanner()}${featureBanner()}${views[S.view]()}</div></main>
  </div>`;
}

/* =====================================================================
 * POS
 * ===================================================================== */
function sellable() {
  return (S.snap.products || []).filter((p) => p.Sells !== false);
}

function viewPOS() {
  const cats = ['All'].concat(Array.from(new Set(sellable().map((p) => p.Category).filter(Boolean))));
  const t = cartTotals();
  const n = S.cart.lines.length;
  return `<div class="pos">
    <section>
      <div class="searchbox">${icon('search')}<input id="pos-search" type="text" placeholder="Search products, SKU or barcode" value="${esc(S.ui.q)}" data-input="pos-search" autocomplete="off"></div>
      <div class="chips">${cats.map((c) => `<button class="chip-f ${S.ui.cat === c ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div id="pos-grid">${posGrid()}</div>
      ${n && !S.ui.showCart ? `<div class="cartbar"><span class="count">${n}</span><button class="btn accent big" data-act="show-cart">Review sale · ${fmtUSD(t.total)}</button></div>` : ''}
    </section>
    ${S.ui.showCart ? `<div class="cart-backdrop ${S.ui.sheetAnim ? 'anim' : ''}" data-act="hide-cart"></div>` : ''}
    <aside class="cart-panel ${S.ui.showCart ? 'sheet-open' + (S.ui.sheetAnim ? ' anim' : '') : 'mobile-hidden'}" id="cart-panel">${cartPanel()}</aside>
  </div>`;
}

function posGrid() {
  const q = S.ui.q.trim().toLowerCase();
  const stock = stockMap();
  const allowNeg = bool(setting('AllowNegativeStock'));
  const inCart = {}; S.cart.lines.forEach((l) => { inCart[l.productId] = l.qty; });
  const list = sellable().filter((p) => (S.ui.cat === 'All' || p.Category === S.ui.cat) &&
    (!q || (p.Name + ' ' + p.SKU + ' ' + p.Barcode).toLowerCase().indexOf(q) >= 0));
  if (!list.length) return `<div class="card empty">${icon('search')}No products match “${esc(S.ui.q)}”.</div>`;
  // products that are sold out go to the end of the list
  const inStock = list.filter((p) => (stock[p.ProductID] || 0) > 0);
  const soldOut = list.filter((p) => (stock[p.ProductID] || 0) <= 0);
  const ordered = inStock.concat(soldOut);
  return `<div class="products">${ordered.map((p, k) => {
    const qty = stock[p.ProductID] || 0;
    const low = qty <= num(p.ReorderLevel);
    const badge = qty <= 0 ? 'bad' : low ? 'warn' : 'ok';
    const cc = catColor(p.Name);
    const img = p.ImageURL ? (/lh3\.googleusercontent\.com\/d\/[\w-]+$/.test(p.ImageURL) ? p.ImageURL + '=w300' : p.ImageURL) : '';
    const sale = num(p.RegularPrice) > num(p.SellingPrice);
    const out = qty <= 0;
    return `${out && k === inStock.length && inStock.length ? '<div class="soldout-head">Sold out</div>' : ''}<button class="prod ${out ? 'out' : ''}" data-act="add" data-id="${esc(p.ProductID)}" ${out && !allowNeg ? 'disabled' : ''}>
      <span class="thumb" style="--c1:${cc[0]};--c2:${cc[1]}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<b>${esc(initials(p.Name))}</b>
        ${inCart[p.ProductID] ? `<span class="incart">${fmtQty(inCart[p.ProductID])}</span>` : out && !allowNeg ? '' : `<span class="addplus">${icon('plus', 'sm')}</span>`}
        ${sale && !out ? '<span class="salepill">Sale</span>' : ''}${out ? '<span class="outpill">Sold out</span>' : ''}</span>
      <span class="n">${esc(p.Name)}</span>
      <span class="foot"><span class="p">${fmtCur(p.SellingPrice, p.PriceCurrency)}${sale ? ` <s>${fmtCur(p.RegularPrice, p.PriceCurrency)}</s>` : ''}</span>
      <span class="stk ${badge}">${out ? 'None left' : fmtQty(qty) + ' ' + esc(p.Unit || '')}</span></span></button>`;
  }).join('')}</div>`;
}

function lineUSD(l) { return toUSD(l.unitPrice * l.qty, l.priceCurrency); }
function cartTotals() {
  const sub = S.cart.lines.reduce((t, l) => t + lineUSD(l), 0);
  const disc = Math.min(num(S.cart.discountUSD), sub);
  const total = Math.max(0, sub - disc);
  return { sub, disc, total, totalLRD: total * rate() };
}

function cartPanel() {
  const t = cartTotals();
  const cust = S.cart.customerId ? customers().find((c) => c.CustomerID === S.cart.customerId) : null;
  return `<div class="card">
    <div class="cart-head"><h3>Current sale</h3>
      <span class="row">${S.cart.lines.length ? `<button class="btn ghost sm" data-act="clear-cart">${icon('trash', 'sm')} Clear</button>` : ''}
      <button class="btn ghost icon sm sheet-x" data-act="hide-cart" title="Back to products" style="display:${S.ui.showCart ? 'inline-flex' : 'none'}">${icon('x')}</button></span></div>
    ${S.ui.showCart ? `<button class="sheet-more" data-act="hide-cart">${icon('plus', 'sm')} Add more products</button>` : ''}
    ${S.cart.orderId ? `<div class="order-banner">${icon('bag', 'sm')} <span>Online order <b>${esc(S.cart.orderNo)}</b>${S.cart.orderFee && S.cart.orderFee.fee ? ` · collect delivery fee <b>${fmtCur(S.cart.orderFee.fee, S.cart.orderFee.currency)}</b> too (recorded automatically)` : ''}</span></div>` : ''}
    <div class="cart-lines">${S.cart.lines.length ? S.cart.lines.map((l, i) => `<div class="cart-line">
        <div><div class="n">${esc(l.name)}</div><div class="muted small">${fmtCur(l.unitPrice, l.priceCurrency)} / ${esc(l.unit || 'unit')}</div></div>
        <div class="right"><b class="num">${fmtCur(l.unitPrice * l.qty, l.priceCurrency)}</b></div>
        <div class="qty"><button data-act="qty" data-i="${i}" data-d="-1" aria-label="less">${icon('minus', 'sm')}</button>
          <input id="qty-${i}" type="number" inputmode="decimal" step="${l.step}" min="0" value="${l.qty}" data-input="qty" data-i="${i}">
          <button data-act="qty" data-i="${i}" data-d="1" aria-label="more">${icon('plus', 'sm')}</button></div>
        <div class="right"><button class="btn ghost icon sm" data-act="remove" data-i="${i}" title="Remove">${icon('trash', 'sm')}</button></div>
      </div>`).join('') : `<div class="empty">${icon('cart')}Tap a product to start a sale</div>`}</div>
    <div class="cart-foot">
      <div class="row" style="margin-bottom:.7rem">
        ${can('POS_DISCOUNT') ? `<button class="btn sm" data-act="discount" ${S.cart.lines.length ? '' : 'disabled'}>${icon('tag', 'sm')} Discount</button>` : ''}
        <button class="btn sm ${cust ? 'soft' : ''}" data-act="pick-customer">${icon('user', 'sm')} ${cust ? esc(cust.Name) : 'Add customer'}</button>
      </div>
      <div class="totals">
        <div class="line"><span>Subtotal</span><span class="num">${fmtUSD(t.sub)}</span></div>
        ${t.disc ? `<div class="line"><span>Discount</span><span class="num">−${fmtUSD(t.disc)}</span></div>` : ''}
        <div class="line grand"><span>Total</span><span class="num">${fmtUSD(t.total)}</span></div>
        <div class="line"><span>In LRD at ${rate()}</span><span class="num">${fmtLRD(t.totalLRD)}</span></div>
      </div>
      <button class="btn accent block big" style="margin-top:.9rem" data-act="checkout" ${S.cart.lines.length ? '' : 'disabled'}>Charge ${fmtUSD(t.total)}</button>
    </div>
  </div>`;
}

/** How much of this line's product is in stock (other cart lines of the same product don't exist: one line per product). */
function stockLeft(l) { return stockMap()[l.productId] || 0; }
function stockOk(l, want) {
  const have = stockLeft(l);
  if (want <= have) return true;
  if (bool(setting('AllowNegativeStock'))) { toast('Stock shows ' + fmtQty(Math.max(0, have)) + ' ' + (l.unit || '') + ' — the sale will be marked for the owner to check', 'bad'); return true; }
  toast('Only ' + fmtQty(Math.max(0, have)) + ' ' + (l.unit || '') + ' of ' + l.name + ' in stock', 'bad');
  return false;
}
function addToCart(pid) {
  const p = productById(pid);
  if (!p) return;
  const step = isYard(p) ? 0.5 : 1;
  const ex = S.cart.lines.find((l) => l.productId === pid);
  const stock = stockMap()[pid] || 0;
  const want = (ex ? ex.qty : 0) + (isYard(p) ? 1 : 1);
  if (want > stock && !bool(setting('AllowNegativeStock'))) { toast(stock > 0 ? 'Only ' + fmtQty(stock) + ' ' + (p.Unit || '') + ' in stock' : p.Name + ' is sold out', 'bad'); return; }
  if (want > stock) toast('Stock shows ' + fmtQty(Math.max(0, stock)) + ' — the sale will be marked for the owner to check', 'bad');
  if (ex) ex.qty = r2(ex.qty + 1);
  else S.cart.lines.push({ productId: pid, name: p.Name, unit: p.Unit, qty: 1, step, unitPrice: num(p.SellingPrice), priceCurrency: p.PriceCurrency });
  render();
}

/* ---------- checkout ---------- */
let co = null; // checkout state { tenders: [], method, amount, changeCurrency }
const METHODS = [
  ['USD_CASH', 'USD cash', 'USD', 'cash'], ['LRD_CASH', 'LRD cash', 'LRD', 'cash'], ['MOMO_MTN', 'MTN MoMo', 'LRD', 'phone'],
  ['MOMO_ORANGE', 'Orange Money', 'LRD', 'phone'], ['CREDIT', 'On credit', 'USD', 'book']
];

function openCheckout() {
  co = { tenders: [], method: 'LRD_CASH', changeCurrency: 'LRD' };
  showModal(checkoutModal);
}

function coPaid() {
  const t = cartTotals();
  const paidUSD = co.tenders.reduce((s, x) => s + toUSD(x.amount, x.currency), 0);
  return { t, paidUSD, remainUSD: t.total - paidUSD };
}

function checkoutModal() {
  const { t, paidUSD, remainUSD } = coPaid();
  const m = METHODS.find((x) => x[0] === co.method);
  const remainInCur = m[2] === 'USD' ? Math.max(0, remainUSD) : Math.max(0, remainUSD * rate());
  const suggest = m[2] === 'USD' ? r2(remainInCur) : Math.ceil(remainInCur);
  const cust = S.cart.customerId ? customers().find((c) => c.CustomerID === S.cart.customerId) : null;
  const methods = METHODS.filter((x) => x[0] !== 'CREDIT' || (can('CREDIT_SALE') && feature('Credit')));
  const change = -remainUSD;
  const done = remainUSD <= 0.005;
  return `<div class="modal-head"><h2>Take payment</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <div class="due"><div class="usd">${fmtUSD(t.total)}</div><div class="lrd">${fmtLRD(t.totalLRD)} · rate ${rate()}</div></div>
    ${co.tenders.map((x, i) => `<div class="tender"><span>${esc(METHODS.find((mm) => mm[0] === x.method)[1])}${x.reference ? ' · ' + esc(x.reference) : ''}</span>
      <span class="row"><b class="num">${fmtCur(x.amount, x.currency)}</b><button class="btn ghost icon sm" data-act="co-del" data-i="${i}">${icon('x', 'sm')}</button></span></div>`).join('')}
    ${!done ? `<div class="methods">${methods.map((x) => `<button class="btn ${co.method === x[0] ? 'on' : ''}" data-act="co-method" data-m="${x[0]}">${icon(x[3])}${x[1]}</button>`).join('')}</div>
      ${co.method === 'CREDIT' && !cust ? `<div class="card flat row between" style="background:var(--warn-soft);border-color:transparent"><span>Credit sales need a customer.</span><button class="btn sm primary" data-act="pick-customer">${icon('user', 'sm')} Choose customer</button></div>` : `
      <div class="grid2">
        <div class="field"><label for="co-amt">Amount received (${m[2]})</label>
          <input id="co-amt" type="number" inputmode="decimal" step="any" value="${suggest}" data-input="co-amt" class="bigin"></div>
        ${co.method.indexOf('MOMO') === 0 ? `<div class="field"><label for="co-ref">Transaction ID</label><input id="co-ref" type="text"></div>` : '<div></div>'}
      </div>
      <div class="quick">${m[2] === 'LRD' && co.method === 'LRD_CASH' ? [500, 1000, 2000, 5000].map((v) => `<button class="btn sm" data-act="co-quick" data-v="${v}">+${v}</button>`).join('') : ''}
        ${m[2] === 'USD' && co.method === 'USD_CASH' ? [1, 5, 10, 20, 50, 100].map((v) => `<button class="btn sm" data-act="co-quick" data-v="${v}">$${v}</button>`).join('') : ''}</div>
      <div class="co-live" id="co-live">${coLive(suggest)}</div>
      <button class="btn soft block" style="margin-top:.6rem" data-act="co-add">${icon('plus', 'sm')} Add as part payment</button>`}` : ''}
    <div class="totals">
      <div class="line"><span>Paid</span><span class="num">${fmtUSD(paidUSD)}</span></div>
      ${!done ? `<div class="line"><b>Still to pay</b><b class="num">${fmtUSD(remainUSD)} · ${fmtLRD(remainUSD * rate())}</b></div>` : `
      <div class="line change"><span>Change</span><span class="num">${co.changeCurrency === 'USD' ? fmtUSD(change) : fmtLRD(change * rate())}</span></div>
      <div class="row"><span class="muted small">Give change in</span>
        <button class="btn sm ${co.changeCurrency === 'LRD' ? 'primary' : ''}" data-act="co-change" data-c="LRD">LRD</button>
        <button class="btn sm ${co.changeCurrency === 'USD' ? 'primary' : ''}" data-act="co-change" data-c="USD">USD</button></div>`}
    </div>
    <button class="btn accent block big" style="margin-top:1rem" data-act="co-finish" id="co-finish" ${done || (co.method !== 'CREDIT' || cust) ? '' : 'disabled'}>${icon('check')} Complete sale</button>`;
}
/** Live line under the amount: change to give, or what is still missing. */
function coLive(typed) {
  const { remainUSD } = coPaid();
  const m = METHODS.find((x) => x[0] === co.method);
  const usd = m[2] === 'USD' ? num(typed) : num(typed) / rate();
  const diff = usd - remainUSD;
  if (!(num(typed) > 0)) return '<span class="muted">Type the amount the customer gives you</span>';
  if (diff >= -0.005) {
    return diff < 0.005 ? `<span class="ok">${icon('check', 'sm')} Exact amount</span>`
      : `<span class="chg">Change to give: <b>${fmtLRD(diff * rate())}</b> <span class="muted">or ${fmtUSD(diff)}</span></span>`;
  }
  return `<span class="warn">Still missing ${fmtUSD(-diff)} · ${fmtLRD(-diff * rate())} — add it as a part payment</span>`;
}

function finishSale() {
  const { t, remainUSD } = coPaid();
  if (remainUSD > 0.005) return;
  const st = store();
  S.counter += 1;
  const receiptNo = st.Code + '-' + S.cfg.deviceId.slice(-4) + '-' + String(S.counter).padStart(5, '0');
  const rec = enqueue('sale', {
    receiptNo,
    customerId: S.cart.customerId || undefined,
    items: S.cart.lines.map((l) => ({ productId: l.productId, qty: l.qty, priceCurrency: l.priceCurrency, unitPrice: l.unitPrice })),
    discountUSD: r2(t.disc),
    payments: co.tenders.map((x) => ({ method: x.method, currency: x.currency, amount: x.amount, reference: x.reference || undefined })),
    changeCurrency: co.changeCurrency
  });
  rec._names = S.cart.lines.map((l) => l.name);
  if (S.cart.orderId) enqueue('orderStatus', { orderId: S.cart.orderId, status: 'PAID', saleId: rec.id });
  rec._change = { usd: -remainUSD, currency: co.changeCurrency };
  persist.journal(); persist.misc();
  S.cart = { lines: [], discountUSD: 0, customerId: '' };
  S.ui.showCart = false;
  co = null;
  showModal(() => receiptModal(rec));
  render();
}

function receiptHTML(r) {
  const st = store();
  const rt = num(r.rate);
  let sub = 0;
  const lines = r.items.map((i, k) => {
    const p = productById(i.productId) || {};
    const usd = toUSDAt(i.unitPrice * i.qty, i.priceCurrency, rt);
    sub += usd;
    return `<div>${esc((r._names && r._names[k]) || p.Name || i.productId)}</div>
      <div class="l"><span>${fmtQty(i.qty)} × ${fmtCur(i.unitPrice, i.priceCurrency)}</span><span>${fmtCur(i.unitPrice * i.qty, i.priceCurrency)}</span></div>`;
  }).join('');
  const total = sub - num(r.discountUSD);
  const paid = r.payments.reduce((s, p) => s + toUSDAt(p.amount, p.currency, rt), 0);
  const changeUSD = Math.max(0, paid - total);
  const cust = r.customerId ? customers().find((c) => c.CustomerID === r.customerId) : null;
  return `<div class="receipt">
    <div class="c"><b>${esc(st.ReceiptHeader || st.Name)}</b><br>${esc(st.Address || '')}<br>${esc(st.Phone || '')}</div><hr>
    <div class="l"><span>Receipt</span><span>${esc(r.receiptNo)}</span></div>
    <div class="l"><span>Date</span><span>${fmtDate(r.timestamp)}</span></div>
    <div class="l"><span>Cashier</span><span>${esc(userName(r.userId))}</span></div>
    ${cust ? `<div class="l"><span>Customer</span><span>${esc(cust.Name)}</span></div>` : ''}<hr>
    ${lines}<hr>
    ${num(r.discountUSD) ? `<div class="l"><span>Discount</span><span>−${fmtUSD(r.discountUSD)}</span></div>` : ''}
    <div class="l"><b>TOTAL USD</b><b>${fmtUSD(total)}</b></div>
    <div class="l"><b>TOTAL LRD</b><b>${fmtLRD(total * rt)}</b></div>
    <div class="l small"><span>Rate</span><span>1 USD = ${rt} LRD</span></div><hr>
    ${r.payments.map((p) => `<div class="l"><span>${esc((METHODS.find((m) => m[0] === p.method) || [0, p.method])[1])}</span><span>${fmtCur(p.amount, p.currency)}</span></div>`).join('')}
    ${changeUSD > 0.004 ? `<div class="l"><b>Change</b><b>${r.changeCurrency === 'USD' ? fmtUSD(changeUSD) : fmtLRD(changeUSD * rt)}</b></div>` : ''}
    <hr><div class="c">${esc(st.ReceiptFooter || 'Thank you!')}</div></div>`;
}

function receiptModal(r) {
  const ch = r._change && r._change.usd > 0.004 ? (r._change.currency === 'USD' ? fmtUSD(r._change.usd) : fmtLRD(r._change.usd * num(r.rate))) : '';
  return `<div class="modal-head"><span></span><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <div class="done-hero"><span class="tick">${icon('check', 'lg')}</span><h2>Sale complete</h2>
      ${ch ? `<div class="give">Give change <b>${ch}</b></div>` : '<div class="muted">No change to give</div>'}</div>
    <details class="rcpt"><summary>Show receipt ${esc(r.receiptNo)}</summary>${receiptHTML(r)}</details>
    <div class="grid2" style="margin-top:1rem">
      <button class="btn" data-act="print" data-id="${esc(r.id)}">${icon('printer')} Print</button>
      <button class="btn" data-act="sale-doc" data-id="${esc(r.id)}">${icon('share')} PDF · share · e-mail</button></div>
    <button class="btn primary block" style="margin-top:.6rem" data-act="close">New sale ${icon('arrow')}</button>
    <button class="btn ghost block sm" style="margin-top:.4rem" data-act="void-open" data-id="${esc(r.id)}">Made a mistake? Correct this sale</button>`;
}

/* ---------- customer picker ---------- */
function customerPicker() {
  const q = (S.ui.custQ || '').toLowerCase();
  const list = customers().filter((c) => !q || (c.Name + ' ' + c.Phone).toLowerCase().indexOf(q) >= 0).slice(0, 50);
  return `<div class="modal-head"><h2>Customer</h2><button class="btn ghost icon" data-act="${co ? 'back-checkout' : 'close'}">${icon('x')}</button></div>
    <div class="searchbox">${icon('search')}<input id="cust-q" type="text" placeholder="Search name or phone" value="${esc(S.ui.custQ || '')}" data-input="cust-q"></div>
    <div id="cust-list" style="margin-top:.6rem">${list.map((c) => `<div class="tender" data-act="set-customer" data-id="${esc(c.CustomerID)}" style="cursor:pointer">
      <span><b>${esc(c.Name)}</b> <span class="muted small">${esc(c.Phone)}</span></span>
      <span class="num ${c.BalanceUSD > 0 ? '' : 'muted'}">${c.BalanceUSD > 0.004 ? 'owes ' + fmtUSD(c.BalanceUSD) : '—'}</span></div>`).join('') || '<div class="empty">No customers</div>'}</div>
    <div class="row" style="margin-top:.6rem">
      ${S.cart.customerId ? '<button class="btn" data-act="set-customer" data-id="">No customer</button>' : ''}
      ${canAny('CUSTOMER_MANAGE', 'CREDIT_SALE') ? `<button class="btn primary" data-act="new-customer">${icon('plus', 'sm')} New customer</button>` : ''}</div>`;
}

function customerForm(c) {
  c = c || {};
  return `<div class="modal-head"><h2>${c.CustomerID ? 'Edit' : 'New'} customer</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="customer" data-id="${esc(c.CustomerID || '')}">
      <div class="field"><label>Name</label><input name="name" type="text" required value="${esc(c.Name || '')}"></div>
      <div class="grid2"><div class="field"><label>Phone</label><input name="phone" type="tel" value="${esc(c.Phone || '')}"></div>
      <div class="field"><label>Credit limit (USD)</label><input name="limit" type="number" step="any" value="${esc(c.CreditLimitUSD || '')}" ${can('CUSTOMER_MANAGE') ? '' : 'disabled'}></div></div>
      <div class="field"><label>E-mail (for invoices and receipts)</label><input name="email" type="email" value="${esc(c.Email || '')}"></div>
      <div class="field"><label>Notes</label><input name="notes" type="text" value="${esc(c.Notes || '')}"></div>
      <button class="btn primary block" type="submit">Save</button></form>`;
}

/* =====================================================================
 * Online orders (from the WhatsApp shop)
 * ===================================================================== */
const ORDER_TABS = [['NEW', 'New'], ['CONFIRMED', 'Confirmed'], ['PAID', 'Paid · to hand over'], ['DONE', 'Done']];
const ORDER_BADGE = { NEW: 'warn', CONFIRMED: 'brand', PAID: 'ok', DELIVERED: '', CANCELLED: 'bad' };

function orders() {
  const list = (S.snap.orders || []).map((o) => Object.assign({}, o));
  const byId = {}; list.forEach((o) => { byId[o.OrderID] = o; });
  liveRecords().forEach((r) => {
    if (r.type === 'orderStatus' && byId[r.orderId]) { byId[r.orderId].Status = r.status; byId[r.orderId]._pending = true; if (r.saleId) byId[r.orderId].SaleID = r.saleId; }
  });
  return list;
}
const newOrderCount = () => orders().filter((o) => o.Status === 'NEW').length;
const waLink = (phone, text) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '0') d = '231' + d.slice(1);
  if (d.length === 9 && d[0] !== '0') d = '231' + d;
  return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
};

function viewOrders() {
  const tab = S.ui.orderTab || 'NEW';
  const all = orders();
  const count = (k) => all.filter((o) => (k === 'DONE' ? ['DELIVERED', 'CANCELLED'].indexOf(o.Status) >= 0 : o.Status === k)).length;
  const list = all.filter((o) => (tab === 'DONE' ? ['DELIVERED', 'CANCELLED'].indexOf(o.Status) >= 0 : o.Status === tab));
  return `<div class="page-head"><div><h2>Online orders</h2><div class="sub">Orders customers sent from your WhatsApp shop</div></div>
      <button class="btn" data-act="sync-now">${icon('sync', 'sm')} Check for new orders</button></div>
    <div class="tabs">${ORDER_TABS.map((t) => `<button class="tab ${tab === t[0] ? 'on' : ''}" data-act="order-tab" data-t="${t[0]}">${t[1]}${count(t[0]) ? ` (${count(t[0])})` : ''}</button>`).join('')}</div>
    ${list.length ? `<div class="orders">${list.map(orderCard).join('')}</div>`
      : `<div class="card empty">${icon('bag')}${tab === 'NEW' ? 'No new orders. Share your shop link on WhatsApp status to get orders.' : 'Nothing here.'}</div>`}`;
}

function orderCard(o) {
  const items = o.Items || [];
  const acts = [];
  const hello = `Hello ${o.CustomerName}, thank you for your order ${o.OrderNo} at ${store().Name}. `;
  if (o.Status === 'NEW') {
    acts.push(`<a class="btn sm wa" href="${esc(waLink(o.CustomerPhone, hello + 'We have your items. Total ' + fmtUSD(o.TotalUSD) + ' / ' + fmtLRD(o.TotalLRD) + '. You can pay by MTN MoMo, Orange Money or cash. '))}" target="_blank" rel="noopener">${icon('chat', 'sm')} WhatsApp customer</a>`);
    acts.push(`<button class="btn sm primary" data-act="order-status" data-id="${esc(o.OrderID)}" data-s="CONFIRMED">${icon('check', 'sm')} Confirm</button>`);
  }
  if (o.Status === 'NEW' || o.Status === 'CONFIRMED') {
    if (o.Status === 'CONFIRMED') acts.push(`<a class="btn sm wa" href="${esc(waLink(o.CustomerPhone, hello))}" target="_blank" rel="noopener">${icon('chat', 'sm')} WhatsApp</a>`);
    if (can('POS_SELL')) acts.push(`<button class="btn sm accent" data-act="order-ring" data-id="${esc(o.OrderID)}">${icon('cart', 'sm')} Paid — ring up sale</button>`);
    acts.push(`<button class="btn sm danger" data-act="order-status" data-id="${esc(o.OrderID)}" data-s="CANCELLED">Cancel</button>`);
  }
  if (o.Status === 'PAID') {
    acts.push(`<button class="btn sm primary" data-act="order-status" data-id="${esc(o.OrderID)}" data-s="DELIVERED">${icon('check', 'sm')} ${o.Method === 'DELIVERY' ? 'Delivered' : 'Picked up'}</button>`);
    acts.push(`<a class="btn sm wa" href="${esc(waLink(o.CustomerPhone, hello + (o.Method === 'DELIVERY' ? 'Your order is on the way.' : 'Your order is ready for pickup.')))}" target="_blank" rel="noopener">${icon('chat', 'sm')} Tell customer</a>`);
  }
  return `<div class="card order">
    <div class="row between"><div><b class="ono">${esc(o.OrderNo)}</b> <span class="badge ${ORDER_BADGE[o.Status] || ''}">${esc(o.Status)}${o._pending ? ' · not synced' : ''}</span>
      <div class="muted small">${fmtDate(o.CreatedAt)}</div></div>
      <div class="right"><div class="ototal">${fmtUSD(o.TotalUSD)}</div><div class="muted small">${fmtLRD(o.TotalLRD)}</div></div></div>
    <div class="ocust"><span class="avatar">${esc(initials(o.CustomerName))}</span><div><b>${esc(o.CustomerName)}</b><div class="muted small">${esc(o.CustomerPhone)}</div></div></div>
    <div class="ometa">${o.Method === 'DELIVERY' ? `${icon('truck', 'sm')} <span><b>Delivery${o.Place ? ' – ' + esc(o.Place) : ''}</b> · ${esc(o.Address || '')}</span>` : `${icon('store', 'sm')} <span><b>Pickup</b> · ${esc(o.Place || 'at the shop')}</span>`}</div>
    ${o.Note ? `<div class="onote">“${esc(o.Note)}”</div>` : ''}
    <div class="olines">${items.map((l) => `<div><span>${fmtQty(l.qty)} × ${esc(l.name)}${l.custom ? `<br><small class="ocustom">✎ ${esc([l.custom.name ? 'Name: ' + l.custom.name : '', l.custom.colours ? 'Colours: ' + l.custom.colours : ''].filter(Boolean).join(' · '))}${l.leadDays ? ' · ' + l.leadDays + ' days' : ''}</small>` : ''}</span><span class="num">${fmtCur(l.total, l.currency)}</span></div>`).join('')}
      ${o.Method === 'DELIVERY' ? `<div class="muted"><span>Delivery fee</span><span class="num">${num(o.Fee) ? fmtCur(o.Fee, o.FeeCurrency) : 'Free'}</span></div>` : ''}</div>
    ${acts.length ? `<div class="row oacts">${acts.join('')}</div>` : ''}
  </div>`;
}

function ringUpOrder(o) {
  if (S.cart.lines.length && !confirm('Replace the current sale with order ' + o.OrderNo + '?')) return;
  const missing = [];
  const lines = [];
  (o.Items || []).forEach((l) => {
    const p = productById(l.id);
    if (!p) { missing.push(l.name); return; }
    lines.push({ productId: p.ProductID, name: p.Name, unit: p.Unit, qty: num(l.qty), step: isYard(p) ? 0.5 : 1, unitPrice: num(l.price), priceCurrency: l.currency });
  });
  S.cart = { lines, discountUSD: 0, customerId: '', orderId: o.OrderID, orderNo: o.OrderNo, orderFee: o.Method === 'DELIVERY' ? { fee: num(o.Fee), currency: o.FeeCurrency } : null };
  if (missing.length) toast('Not found in this store: ' + missing.join(', '), 'bad');
  S.view = 'pos'; S.ui.showCart = true;
  render();
  setTimeout(() => { const c = $('#cart-panel'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
}

/* =====================================================================
 * Admin → Online shop
 * ===================================================================== */
async function loadShopAdmin() {
  S.ui.shopLoading = true; render();
  try { S.shopAdmin = await adminCall('shopData', { storeId: shopStoreId() }); }
  catch (e) { toast(e.message, 'bad'); }
  S.ui.shopLoading = false; render();
}
function shopStoreId() {
  if (store().StoreID !== 'HQ') return store().StoreID;
  const shops = (S.snap.stores || []).filter((s) => s.Type === 'SHOP' && s.Status === 'ACTIVE');
  if (!S.ui.shopStore && shops[0]) S.ui.shopStore = shops[0].StoreID;
  return S.ui.shopStore;
}
function shopLink(d) {
  const base = String(d.shopUrl || '').trim();
  const code = d.store.Code;
  if (base) return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'shop=' + encodeURIComponent(code);
  return d.webAppUrl ? d.webAppUrl + '?shop=' + encodeURIComponent(code) : '';
}

function adminShop() {
  if (!S.shopAdmin || S.shopAdmin.store.StoreID !== shopStoreId()) {
    return `<div class="card empty">${S.ui.shopLoading ? 'Loading…' : `<button class="btn primary" data-act="shop-load">Load online shop settings</button>`}</div>`;
  }
  const d = S.shopAdmin;
  const st = d.store;
  const on = bool(st.OnlineShop);
  const link = shopLink(d);
  const del = d.options.filter((o) => o.Type === 'DELIVERY');
  const pick = d.options.filter((o) => o.Type === 'PICKUP');
  const shops = (S.snap.stores || []).filter((s) => s.Type === 'SHOP' && s.Status === 'ACTIVE');
  const q = (S.ui.shopQ || '').toLowerCase();
  const prods = d.products.filter((p) => p.Status === 'ACTIVE' && (!q || p.Name.toLowerCase().indexOf(q) >= 0));
  return `
  ${store().StoreID === 'HQ' ? `<div class="field" style="max-width:340px"><label>Shop</label><select data-input="shop-store">${shops.map((s) => `<option value="${esc(s.StoreID)}" ${s.StoreID === st.StoreID ? 'selected' : ''}>${esc(s.Code + ' ' + s.Name)}</option>`).join('')}</select></div>` : ''}
  <div class="rcols" style="margin-top:0">
    <div class="card"><h3>${icon('chat')} WhatsApp shop</h3>
      <form data-form="shop-settings">
        <label class="check"><input type="checkbox" name="onlineShop" ${on ? 'checked' : ''}> <b>Take orders online</b></label>
        <div class="field" style="margin-top:.6rem"><label>WhatsApp number that receives orders (with country code)</label>
          <input name="whatsapp" type="tel" value="${esc(st.WhatsApp || '')}" placeholder="231770123456"></div>
        <div class="field"><label>Welcome message on the shop page</label><input name="shopMessage" type="text" value="${esc(st.ShopMessage || '')}" placeholder="e.g. Order before 2pm for same-day delivery"></div>
        <div class="grid2"><div class="field"><label>Shop address</label><input name="address" type="text" value="${esc(st.Address || '')}" placeholder="e.g. Broad Street, Monrovia"></div>
          <div class="field"><label>Opening hours</label><input name="hours" type="text" value="${esc(st.Hours || '')}" placeholder="e.g. Mon–Sat 8am–6pm"></div></div>
        <button class="btn primary" type="submit">Save</button></form></div>
    <div class="card"><h3>${icon('link')} Your shop link</h3>
      ${on && link ? `<div class="linkbox"><input id="shop-link" type="text" readonly value="${esc(link)}"><button class="btn sm" data-act="copy-link">Copy</button></div>
        <div class="row" style="margin:.7rem 0"><a class="btn sm wa" href="https://wa.me/?text=${encodeURIComponent('Shop with us on WhatsApp 👇\n' + link)}" target="_blank" rel="noopener">${icon('chat', 'sm')} Share on WhatsApp</a>
          <a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">Open shop</a></div>
        <img class="qr" alt="QR code for the shop" src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(link)}">
        <p class="muted small">Print the QR code for your shop door and counter. Put the link in your WhatsApp Business profile and status.</p>`
        : `<p class="muted">${on ? 'Deploy the web app first to get a link.' : 'Turn on “Take orders online” and add your WhatsApp number to get your shop link.'}</p>`}</div>
  </div>

  <div class="rcols">
    <div class="card"><div class="row between"><h3 style="margin:0">${icon('truck')} Delivery areas</h3><button class="btn sm" data-act="opt-edit" data-type="DELIVERY">${icon('plus', 'sm')} Add area</button></div>
      <p class="muted small">Customers pay this fee on top of their items.</p>
      ${del.length ? del.map((o) => optRow(o)).join('') : '<div class="empty">No delivery areas — customers can only pick up.</div>'}</div>
    <div class="card"><div class="row between"><h3 style="margin:0">${icon('store')} Pickup places</h3><button class="btn sm" data-act="opt-edit" data-type="PICKUP">${icon('plus', 'sm')} Add place</button></div>
      <p class="muted small">Your shop or agreed meeting points.</p>
      ${pick.length ? pick.map((o) => optRow(o)).join('') : '<div class="empty">No pickup places — customers can only choose delivery.</div>'}</div>
  </div>

  <div class="rcols">
    <div class="card"><h3>${icon('image')} Shop look</h3>
      <form data-form="brand">
        <div class="row" style="align-items:center;gap:.8rem;margin-bottom:.6rem">
          ${d.brand && d.brand.logo ? `<img class="logoprev" src="${esc(d.brand.logo)}" alt="Logo" referrerpolicy="no-referrer">` : '<span class="logoprev ph">Logo</span>'}
          <button type="button" class="btn sm" data-act="photo-pick" data-id="logo">${icon('image', 'sm')} ${d.brand && d.brand.logo ? 'Change logo' : 'Upload logo'}</button>
          ${d.brand && d.brand.logo ? '<button type="button" class="btn sm ghost" data-act="logo-clear">Remove</button>' : ''}</div>
        <div class="field"><label>Tagline</label><input name="tagline" type="text" maxlength="80" value="${esc((d.brand || {}).tagline || '')}" placeholder="e.g. Style. Quality. Elegance."></div>
        <div class="field"><label>Top strip (announcement)</label><input name="announcement" type="text" maxlength="160" value="${esc((d.brand || {}).announcement || '')}" placeholder="e.g. Delivery across Monrovia · Order on WhatsApp"></div>
        <div class="field"><label>Facebook page link</label><input name="facebook" type="url" value="${esc((d.brand || {}).facebook || '')}" placeholder="https://facebook.com/yourpage"></div>
        <div class="grid2"><div class="field"><label>Instagram (optional)</label><input name="instagram" type="url" value="${esc((d.brand || {}).instagram || '')}"></div>
          <div class="field"><label>TikTok (optional)</label><input name="tiktok" type="url" value="${esc((d.brand || {}).tiktok || '')}"></div></div>
        <p class="muted small">The shop's main colour is this store's colour (Admin → Stores → colour).</p>
        <button class="btn primary" type="submit">Save look</button></form></div>
    <div class="card"><div class="row between"><h3 style="margin:0">${icon('image')} Banners</h3><button class="btn sm" data-act="banner-edit">${icon('plus', 'sm')} Add banner</button></div>
      <p class="muted small">The big slides at the top of the shop. A wide photo (people wearing your products) works best. No photo? Your product photos are used.</p>
      ${(d.banners || []).length ? d.banners.map((b) => `<div class="list-item ${bool(b.Active) || b.Active === '' ? '' : 'muted'}">
        ${b.ImageURL ? `<img class="pthumb" src="${esc(b.ImageURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="pthumb ph">${icon('image', 'sm')}</span>`}
        <span class="grow"><b>${esc(b.Title || '(photo only)')}</b><div class="muted small">${esc(b.Text || '')}${b.StoreID ? '' : ' · all shops'}</div></span>
        <button class="btn sm ghost" data-act="banner-edit" data-id="${esc(b.BannerID)}">Edit</button></div>`).join('') : '<div class="empty">No banners yet — the shop shows your welcome message instead.</div>'}</div>
  </div>

  <div class="card" style="margin-top:1rem"><div class="row between"><h3 style="margin:0">${icon('image')} Products in the shop</h3>
      <div class="searchbox" style="max-width:280px">${icon('search')}<input id="shop-q" type="text" placeholder="Find product" value="${esc(S.ui.shopQ || '')}" data-input="shop-q"></div></div>
    <p class="muted small">Tick to show a product online. Add a clear photo — it sells much better.</p>
    <div class="plist">${prods.map((p) => `<div class="list-item">
      ${p.ImageURL ? `<img class="pthumb" src="${esc(p.ImageURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="pthumb ph">${esc(initials(p.Name))}</span>`}
      <span class="grow"><b>${esc(p.Name)}</b> ${num(p.SalePrice) ? `<span class="badge bad">Sale ${fmtCur(p.SalePrice, p.PriceCurrency)}</span>` : ''}${p.OnlineTag ? ` <span class="badge info">${p.OnlineTag === 'NEW' ? 'New' : 'Featured'}</span>` : ''}${p.Personalise ? ' <span class="badge">Made to order</span>' : ''}
        <div class="muted small">${esc(p.Description || 'No description')}${(p.MoreImages || []).length ? ' · ' + (p.MoreImages.length + 1) + ' photos' : ''}</div></span>
      <label class="check" style="margin:0"><input type="checkbox" data-act="online-toggle" data-id="${esc(p.ProductID)}" ${p.ShowOnline ? 'checked' : ''}> Online</label>
      <button class="btn sm" data-act="photo-pick" data-id="${esc(p.ProductID)}">${icon('image', 'sm')} Photo</button>
      <button class="btn sm ghost" data-act="desc-edit" data-id="${esc(p.ProductID)}">Edit</button></div>`).join('')}</div>
    <input type="file" id="photo-file" accept="image/*" capture="environment" hidden>
  </div>`;
}

function optRow(o) {
  const active = !(o.Active === false || String(o.Active).toUpperCase() === 'FALSE');
  return `<div class="list-item ${active ? '' : 'muted'}"><span class="grow"><b>${esc(o.Name)}</b>${o.Details ? `<div class="muted small">${esc(o.Details)}</div>` : ''}${active ? '' : ' <span class="badge">hidden</span>'}</span>
    ${o.Type === 'DELIVERY' ? `<b class="num">${num(o.Fee) ? fmtCur(o.Fee, o.Currency) : 'Free'}</b>` : ''}
    <button class="btn sm ghost" data-act="opt-edit" data-id="${esc(o.OptionID)}">Edit</button></div>`;
}

function optForm(o, type) {
  o = o || { Type: type, Currency: 'USD', Fee: '', Active: true };
  const del = o.Type === 'DELIVERY';
  const active = !(o.Active === false || String(o.Active).toUpperCase() === 'FALSE');
  return `<div class="modal-head"><h2>${o.OptionID ? 'Edit' : 'Add'} ${del ? 'delivery area' : 'pickup place'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="opt" data-id="${esc(o.OptionID || '')}" data-type="${esc(o.Type)}">
      <div class="field"><label>${del ? 'Area name' : 'Place name'}</label><input name="name" type="text" required value="${esc(o.Name || '')}" placeholder="${del ? 'e.g. Sinkor' : 'e.g. ELWA Junction'}"></div>
      ${del ? `<div class="grid2"><div class="field"><label>Fee currency</label><select name="currency"><option ${o.Currency === 'USD' ? 'selected' : ''}>USD</option><option ${o.Currency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
        <div class="field"><label>Delivery fee (0 = free)</label><input name="fee" type="number" step="any" min="0" value="${esc(o.Fee)}"></div></div>` : ''}
      <div class="field"><label>Details shown to customers (optional)</label><input name="details" type="text" value="${esc(o.Details || '')}" placeholder="${del ? 'e.g. Same day if ordered before 2pm' : 'e.g. Weekdays after 4pm, we agree the time on WhatsApp'}"></div>
      <label class="check"><input type="checkbox" name="active" ${active ? 'checked' : ''}> Show to customers</label>
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save</button></form>`;
}

function descForm(p) {
  const priceOK = can('PRODUCT_MANAGE') || can('PRICE_MANAGE');
  return `<div class="modal-head"><h2>${esc(p.Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="desc" data-id="${esc(p.ProductID)}">
      <div class="field"><label>Description shown in the shop</label><textarea name="description" rows="4" placeholder="Material, size, colours, what it is good for">${esc(p.Description || '')}</textarea></div>
      <div class="field"><label>Main photo link (or use the Photo button to upload)</label><input name="imageUrl" type="url" value="${esc(p.ImageURL || '')}" placeholder="https://… or a Google Drive share link"></div>
      <div class="field"><label>More photos (one link per line, up to 6)</label><textarea name="moreImages" rows="3" placeholder="https://…">${esc((p.MoreImages || []).join('\n'))}</textarea>
        <button type="button" class="btn sm" style="margin-top:.4rem" data-act="photo-pick" data-id="more:${esc(p.ProductID)}">${icon('image', 'sm')} Upload another photo</button></div>
      <div class="grid2">
        <div class="field"><label>Label in the shop</label><select name="onlineTag">
          <option value="" ${!p.OnlineTag ? 'selected' : ''}>None</option><option value="NEW" ${p.OnlineTag === 'NEW' ? 'selected' : ''}>New</option><option value="FEATURED" ${p.OnlineTag === 'FEATURED' ? 'selected' : ''}>Featured (our picks)</option></select></div>
        ${priceOK ? `<div class="field"><label>Sale price in ${esc(p.PriceCurrency || 'USD')} (empty = no sale)</label><input name="salePrice" type="number" step="any" min="0" value="${esc(p.SalePrice)}" placeholder="Normal price ${fmtCur(p.SellingPrice, p.PriceCurrency)}"></div>` : '<div></div>'}
      </div>
      ${priceOK ? '<p class="muted small" style="margin-top:-.3rem">The sale price is also charged at the till while it is set.</p>' : ''}
      <label class="check"><input type="checkbox" name="personalise" ${p.Personalise ? 'checked' : ''}> <b>Made to order</b> — customer types a name and colours</label>
      <div class="field" style="max-width:220px;margin-top:.5rem"><label>Ready in (days)</label><input name="leadDays" type="number" min="0" step="1" value="${esc(p.LeadDays)}" placeholder="e.g. 5"></div>
      <button class="btn primary block" type="submit">Save</button></form>`;
}

function bannerForm(b) {
  b = b || { Active: true };
  const cats = (S.snap.categories || []).filter((c) => c.Type === 'PRODUCT').map((c) => c.Name);
  const links = [['', 'All products'], ['new', 'New in'], ['sale', 'On sale'], ['best', 'Best sellers'], ['custom', 'Made to order']].concat(cats.map((c) => [c, c]));
  const active = !(b.Active === false || String(b.Active).toUpperCase() === 'FALSE');
  return `<div class="modal-head"><h2>${b.BannerID ? 'Edit' : 'Add'} banner</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="banner" data-id="${esc(b.BannerID || '')}">
      <div class="field"><label>Title</label><input name="title" type="text" maxlength="80" value="${esc(b.Title || '')}" placeholder="e.g. Headwear that makes every occasion"></div>
      <div class="field"><label>Short text (optional)</label><input name="text" type="text" maxlength="200" value="${esc(b.Text || '')}"></div>
      <div class="grid2"><div class="field"><label>Button text</label><input name="buttonText" type="text" maxlength="30" value="${esc(b.ButtonText || '')}" placeholder="Shop now"></div>
        <div class="field"><label>Button opens</label><select name="link">${links.map((l) => `<option value="${esc(l[0])}" ${String(b.Link || '') === l[0] ? 'selected' : ''}>${esc(l[1])}</option>`).join('')}</select></div></div>
      <div class="field"><label>Photo (optional)</label><input name="imageUrl" type="url" value="${esc(b.ImageURL || '')}" placeholder="https://… or upload">
        <button type="button" class="btn sm" style="margin-top:.4rem" data-act="photo-pick" data-id="banner">${icon('image', 'sm')} Upload photo</button></div>
      <div class="grid2"><div class="field"><label>Order</label><input name="sortOrder" type="number" step="1" value="${esc(b.SortOrder || '')}"></div>
        <label class="check" style="align-self:end"><input type="checkbox" name="allShops" ${!b.StoreID ? 'checked' : ''}> Show in all shops</label></div>
      <label class="check"><input type="checkbox" name="active" ${active ? 'checked' : ''}> Show in the shop</label>
      <div class="row" style="margin-top:1rem;gap:.5rem"><button class="btn primary grow" type="submit">Save</button>
        ${b.BannerID ? `<button type="button" class="btn danger" data-act="banner-del" data-id="${esc(b.BannerID)}">Delete</button>` : ''}</div></form>`;
}

/** Resize a photo on the device (max 900px, JPEG) before uploading. */
function resizeImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = maxSide || 900;
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read that photo'));
    img.src = url;
  });
}

/* =====================================================================
 * Stock
 * ===================================================================== */
function viewStock() {
  const stock = stockMap();
  const q = (S.ui.stockQ || '').toLowerCase();
  const showLow = S.ui.stockLow;
  const list = (S.snap.products || []).filter((p) => (!q || (p.Name + ' ' + p.SKU + ' ' + p.Category).toLowerCase().indexOf(q) >= 0))
    .filter((p) => !showLow || (stock[p.ProductID] || 0) <= num(p.ReorderLevel));
  const canIntake = can('STOCK_INTAKE') && !(store().Type === 'SHOP' && !bool(setting('ShopsBuyFromSuppliers')));
  const lowCount = (S.snap.products || []).filter((p) => (stock[p.ProductID] || 0) <= num(p.ReorderLevel)).length;
  return `<div class="page-head"><h2>Stock — ${esc(store().Name)}</h2>
      <div class="row">${canIntake ? `<button class="btn primary" data-act="intake">${icon('plus', 'sm')} ${feature('Suppliers') ? 'Receive stock' : 'Add stock'}</button>` : ''}
      ${can('STOCK_ADJUST') ? `<button class="btn" data-act="adjust">${icon('sliders', 'sm')} Adjust / count</button>` : ''}</div></div>
    <div class="row" style="margin-bottom:.6rem"><div class="searchbox grow" style="max-width:380px">${icon('search')}<input id="stock-q" type="text" placeholder="Search stock" value="${esc(S.ui.stockQ || '')}" data-input="stock-q"></div>
      <button class="chip-f ${showLow ? 'on' : ''}" data-act="toggle-low">Low stock (${lowCount})</button></div>
    <div class="card table-wrap" id="stock-table"><table><thead><tr><th>Product</th><th>Category</th><th class="right">In stock</th><th class="right">Reorder at</th><th>Price</th></tr></thead><tbody>
      ${list.map((p) => { const qn = stock[p.ProductID] || 0; const cls = qn <= 0 ? 'bad' : qn <= num(p.ReorderLevel) ? 'warn' : 'ok';
        return `<tr><td><b>${esc(p.Name)}</b><div class="muted small">${esc(p.SKU || '')}${p.Sells === false ? ' · not sold here' : ''}</div></td><td>${esc(p.Category)}</td>
        <td class="right"><span class="badge ${cls}">${fmtQty(qn)} ${esc(p.Unit || '')}</span></td><td class="right num">${fmtQty(p.ReorderLevel)}</td>
        <td class="num">${fmtCur(p.SellingPrice, p.PriceCurrency)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Nothing here</td></tr>'}
    </tbody></table></div>`;
}

function productOptions(sel) {
  return (S.snap.products || []).map((p) => `<option value="${esc(p.ProductID)}" ${p.ProductID === sel ? 'selected' : ''}>${esc(p.Name)}</option>`).join('');
}

let lines = []; // shared editable item lines for intake / adjust / transfer forms
function linesEditor(kind) {
  const withCost = kind === 'intake';
  return `<div id="lines">${lines.map((l, i) => `<div class="row" style="margin-bottom:.4rem">
      <select class="grow" data-input="line" data-i="${i}" data-f="productId" style="min-width:160px">${productOptions(l.productId)}</select>
      <input type="number" step="any" placeholder="${kind === 'adjust' ? '± qty' : 'Qty'}" value="${esc(l.qty)}" data-input="line" data-i="${i}" data-f="qty" style="width:90px">
      ${withCost ? `<input type="number" step="any" placeholder="Unit cost" value="${esc(l.unitCost)}" data-input="line" data-i="${i}" data-f="unitCost" style="width:110px">` : ''}
      <button class="btn ghost icon sm" type="button" data-act="line-del" data-i="${i}">${icon('trash', 'sm')}</button></div>`).join('')}</div>
    <button class="btn sm" type="button" data-act="line-add" data-kind="${kind}">${icon('plus', 'sm')} Add item</button>`;
}

function intakeModal() {
  const sups = S.snap.suppliers || [];
  if (!feature('Suppliers')) return intakeSimple();
  return `<div class="modal-head"><h2>Receive stock from supplier</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="intake">
      <div class="grid2"><div class="field"><label>Supplier</label><select name="supplierId"><option value="">— none —</option>${sups.map((s) => `<option value="${esc(s.SupplierID)}">${esc(s.Name)}</option>`).join('')}</select></div>
      <div class="field"><label>Invoice no.</label><input name="invoiceNo" type="text"></div></div>
      <div class="grid2"><div class="field"><label>Currency of costs</label><select name="currency"><option>USD</option><option>LRD</option></select></div>
      <div class="field"><label>Amount paid now</label><input name="paid" type="number" step="any" value="0"></div></div>
      <label>Items</label>${linesEditor('intake')}
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save intake</button></form>`;
}

function adjustModal() {
  return `<div class="modal-head"><h2>Adjust stock</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="adjust">
      <div class="field"><label>Reason</label><select name="reason">${['Damaged', 'Lost / stolen', 'Count correction', 'Opening stock', 'Returned to supplier', 'Other'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      <p class="muted small">Enter a negative number to remove stock (e.g. −2 damaged) and a positive number to add.</p>
      ${linesEditor('adjust')}
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save adjustment</button></form>`;
}

/* =====================================================================
 * Transfers
 * ===================================================================== */
function transferTargets(direction) {
  const me = store();
  const whOn = bool(setting('WarehouseEnabled'));
  const s2s = bool(setting('ShopToShopTransfers'));
  return (S.snap.stores || []).filter((s) => s.Status === 'ACTIVE' && s.StoreID !== me.StoreID)
    .filter((s) => whOn || (s.Type !== 'WAREHOUSE' && me.Type !== 'WAREHOUSE'))
    .filter((s) => s2s || !(s.Type === 'SHOP' && me.Type === 'SHOP'));
}

const ST_BADGE = { REQUESTED: 'warn', APPROVED: 'dark', DISPATCHED: 'warn', RECEIVED: 'ok', CANCELLED: 'bad' };
function viewTransfers() {
  const me = store().StoreID;
  const list = transfers();
  const approval = bool(setting('TransferApproval'));
  const targets = transferTargets();
  return `<div class="page-head"><h2>Transfers</h2><div class="row">
      ${can('TRANSFER_REQUEST') && me !== 'HQ' && targets.length ? '<button class="btn primary" data-act="transfer-new" data-mode="REQUEST">Request stock</button>' : ''}
      ${can('TRANSFER_DISPATCH') && me !== 'HQ' && targets.length ? '<button class="btn" data-act="transfer-new" data-mode="SEND">Send stock</button>' : ''}</div></div>
    ${list.length ? list.map((t) => {
      const acts = [];
      if (t.Status === 'REQUESTED' && can('TRANSFER_APPROVE')) acts.push(['APPROVE', 'Approve', 'primary']);
      if (t.FromStoreID === me && can('TRANSFER_DISPATCH') && (t.Status === 'APPROVED' || (t.Status === 'REQUESTED' && !approval))) acts.push(['DISPATCH', 'Dispatch', 'primary']);
      if (t.ToStoreID === me && can('TRANSFER_RECEIVE') && t.Status === 'DISPATCHED') acts.push(['RECEIVE', 'Confirm received', 'accent']);
      if ((t.Status === 'REQUESTED' || t.Status === 'APPROVED') && canAny('TRANSFER_APPROVE', 'TRANSFER_REQUEST')) acts.push(['CANCEL', 'Cancel', 'danger']);
      return `<div class="card" style="margin-bottom:.6rem">
        <div class="row between"><div><b>${esc(storeName(t.FromStoreID))} → ${esc(storeName(t.ToStoreID))}</b>
          <div class="muted small">${fmtDate(t.CreatedAt)}${t.Note ? ' · ' + esc(t.Note) : ''}</div></div>
          <span class="badge ${ST_BADGE[t.Status] || ''}">${t.Status}${t._pending ? ' · not synced' : ''}</span></div>
        <table style="margin-top:.4rem"><thead><tr><th>Item</th><th class="right">Asked</th><th class="right">Sent</th><th class="right">Received</th></tr></thead><tbody>
          ${t.items.map((i) => `<tr><td>${esc((productById(i.ProductID) || {}).Name || i.ProductID)}</td><td class="right num">${fmtQty(i.QtyRequested)}</td>
            <td class="right num">${i.QtySent === '' || i.QtySent === undefined ? '—' : fmtQty(i.QtySent)}</td>
            <td class="right num">${i.QtyReceived === '' || i.QtyReceived === undefined ? '—' : fmtQty(i.QtyReceived)}</td></tr>`).join('')}</tbody></table>
        ${acts.length ? `<div class="row" style="margin-top:.6rem">${acts.map((a) => `<button class="btn sm ${a[2]}" data-act="transfer-act" data-id="${esc(t.TransferID)}" data-a="${a[0]}">${a[1]}</button>`).join('')}</div>` : ''}
      </div>`;
    }).join('') : '<div class="card empty">No transfers yet.</div>'}`;
}

function transferModal(mode) {
  const targets = transferTargets();
  return `<div class="modal-head"><h2>${mode === 'REQUEST' ? 'Request stock' : 'Send stock'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="transfer" data-mode="${mode}">
      <div class="field"><label>${mode === 'REQUEST' ? 'Request from' : 'Send to'}</label>
        <select name="other">${targets.map((s) => `<option value="${esc(s.StoreID)}">${esc(s.Code + ' ' + s.Name)}${s.Type === 'WAREHOUSE' ? ' (warehouse)' : ''}</option>`).join('')}</select></div>
      <label>Items</label>${linesEditor('transfer')}
      <div class="field" style="margin-top:.6rem"><label>Note</label><input name="note" type="text"></div>
      <button class="btn primary block" type="submit">${mode === 'REQUEST' ? 'Send request' : 'Send stock now'}</button></form>`;
}

function transferQtyModal(t, action) {
  return `<div class="modal-head"><h2>${action === 'DISPATCH' ? 'Dispatch' : 'Confirm received'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="transfer-qty" data-id="${esc(t.TransferID)}" data-a="${action}">
      <p class="muted small">${action === 'DISPATCH' ? 'Quantity actually sent' : 'Quantity actually received — any difference is reported to the owner'}.</p>
      ${t.items.map((i) => `<div class="row" style="margin-bottom:.4rem"><span class="grow">${esc((productById(i.ProductID) || {}).Name || i.ProductID)}</span>
        <input type="number" step="any" name="q-${esc(i.ProductID)}" value="${esc(action === 'DISPATCH' ? i.QtyRequested : i.QtySent)}" style="width:110px"></div>`).join('')}
      <button class="btn primary block" type="submit">${action === 'DISPATCH' ? 'Dispatch' : 'Confirm'}</button></form>`;
}

/* =====================================================================
 * Money (expenses & income)
 * ===================================================================== */
/* =====================================================================
 * Money: income & expenditure dashboard, full list, edit and delete
 * ===================================================================== */
const M_PERIODS = [['today', 'Today'], ['7d', '7 days'], ['month', 'This month'], ['lastmonth', 'Last month']];
function moneyRange(k) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  if (k === '7d') return [new Date(d0.getTime() - 6 * 864e5), new Date(d0.getTime() + 864e5)];
  if (k === 'month') return [new Date(d0.getFullYear(), d0.getMonth(), 1), new Date(d0.getTime() + 864e5)];
  if (k === 'lastmonth') return [new Date(d0.getFullYear(), d0.getMonth() - 1, 1), new Date(d0.getFullYear(), d0.getMonth(), 1)];
  return [d0, new Date(d0.getTime() + 864e5)];
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const moneyCats = (type) => (S.snap.categories || []).filter((c) => c.Type === (type === 'expense' ? 'EXPENSE' : 'INCOME'));
function catNotInProfit(type, name) {
  const all = (S.money && S.money.categories) || [];
  const hit = all.find((c) => c.type === (type === 'expense' ? 'EXPENSE' : 'INCOME') && c.name === name)
    || moneyCats(type).find((c) => c.Name === name);
  return !!(hit && (hit.notInProfit === true || hit.NotInProfit === true || String(hit.NotInProfit).toUpperCase() === 'TRUE'));
}
/** An entry from this phone that the server hasn't got yet. */
const unsyncedMoney = (id) => S.queue.find((q) => q.rec.id === id && (q.status === 'pending' || q.status === 'failed'));
function localMoneyEntry(r) {
  const rt = num(r.rate) || rate();
  const usd = r.currency === 'USD' ? num(r.amount) : num(r.amount) / rt;
  return { type: r.type, id: r.id, timestamp: r.timestamp, storeId: store().StoreID, category: r.category, description: r.description || '',
    party: (r.type === 'expense' ? r.paidTo : r.receivedFrom) || '', currency: r.currency, amount: num(r.amount), rate: rt,
    amountUSD: r2(usd), amountLRD: r2(usd * rt), userId: r.userId, status: r.status === 'DELETED' ? 'DELETED' : r.original ? 'EDITED' : 'ACTIVE',
    deleteReason: r.deleteReason || '', notInProfit: catNotInProfit(r.type, r.category), local: true, unsynced: !!unsyncedMoney(r.id) };
}
function canEditLocal(r) { return can('MONEY_EDIT') || (r.userId === S.session.user.UserID && sameDay(r.timestamp, new Date())); }

/** Entries + totals for the chosen period: from the server when online, from this phone otherwise. */
function moneyData() {
  const [from, to] = moneyRange(S.ui.mPeriod || 'today');
  const inRange = (t) => { const d = new Date(t); return d >= from && d < to; };
  const server = S.money && S.money.period === (S.ui.mPeriod || 'today') ? S.money : null;
  let entries = server ? server.entries.slice() : [];
  const have = new Set(entries.map((e) => e.id));
  S.journal.filter((r) => (r.type === 'expense' || r.type === 'income') && inRange(r.timestamp))
    .forEach((r) => { if (!have.has(r.id)) entries.push(Object.assign(localMoneyEntry(r), { canEdit: canEditLocal(r) })); });
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const live = entries.filter((e) => e.status !== 'DELETED' && e.status !== 'VOID' && e.status !== 'VOIDED');
  const sum = { inUSD: 0, inLRD: 0, outUSD: 0, outLRD: 0, npInUSD: 0, npOutUSD: 0 };
  const cats = {}; const days = {};
  for (let d = new Date(from); d < to && d <= new Date(); d = new Date(d.getTime() + 864e5)) days[d.toDateString()] = { d: new Date(d), inUSD: 0, outUSD: 0 };
  live.forEach((e) => {
    const isIn = e.type === 'income';
    sum[isIn ? 'inUSD' : 'outUSD'] += e.amountUSD; sum[isIn ? 'inLRD' : 'outLRD'] += e.amountLRD;
    if (e.notInProfit) sum[isIn ? 'npInUSD' : 'npOutUSD'] += e.amountUSD;
    const k = e.type + '|' + e.category;
    const c = cats[k] || (cats[k] = { type: e.type, name: e.category, usd: 0, lrd: 0, count: 0, notInProfit: e.notInProfit });
    c.usd += e.amountUSD; c.lrd += e.amountLRD; c.count++;
    const day = days[new Date(e.timestamp).toDateString()]; if (day) day[isIn ? 'inUSD' : 'outUSD'] += e.amountUSD;
  });
  return { entries, sum, cats: Object.values(cats).sort((a, b) => b.usd - a.usd), days: Object.values(days), online: !!server,
    deleted: entries.length - live.length };
}

async function loadMoney() {
  if (!S.session.token || !navigator.onLine) { S.ui.mLoading = false; render(); return; }
  const period = S.ui.mPeriod || 'today';
  const [from, to] = moneyRange(period);
  S.ui.mLoading = true; render();
  try {
    const r = await adminCall('moneyList', { from: from.toISOString(), to: to.toISOString(), storeId: store().StoreID === 'HQ' ? undefined : store().StoreID });
    S.money = Object.assign(r, { period });
  } catch (e) { if (e.code !== 'AUTH') toast(e.message, 'bad'); }
  S.ui.mLoading = false; render();
}

function viewMoney() {
  const period = S.ui.mPeriod || 'today';
  if (S.money === undefined && !S.ui.mLoading && S.session.token && navigator.onLine) setTimeout(loadMoney, 0);
  const d = moneyData();
  const s = d.sum;
  const bal = s.inUSD - s.outUSD;
  const sg = (n, f) => (n < -0.004 ? '−' + f(-n) : f(n));
  const card = (k, usd, lrd, cls) => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${sg(usd, fmtUSD)}</div><div class="s">${sg(lrd, fmtLRD)}</div></div>`;
  const maxCat = Math.max(1, ...d.cats.map((c) => c.usd));
  const maxDay = Math.max(1, ...d.days.map((x) => Math.max(x.inUSD, x.outUSD)));
  const q = (S.ui.mQ || '').toLowerCase();
  const fCat = S.ui.mCat || '';
  const fType = S.ui.mType || '';
  const list = d.entries.filter((e) => (S.ui.mShowDel || e.status !== 'DELETED') && (!fType || e.type === fType) && (!fCat || e.category === fCat) &&
    (!q || [e.category, e.description, e.party, String(e.amount)].join(' ').toLowerCase().indexOf(q) >= 0));
  const allCats = Array.from(new Set(d.entries.map((e) => e.category))).sort();
  const nipNote = s.npInUSD || s.npOutUSD ? `<div class="m-note">${icon('alert', 'sm')} Includes loans / owner money — in ${fmtUSD(s.npInUSD)}, out ${fmtUSD(s.npOutUSD)}. These count in the cash balance but <b>not in profit</b>. Profit view: <b>${fmtUSD((s.inUSD - s.npInUSD) - (s.outUSD - s.npOutUSD))}</b></div>` : '';
  return `<div class="page-head"><div><h2>Money</h2><div class="sub">Income and expenses for ${esc(store().Name)}</div></div>
      <div class="row" style="gap:.5rem">${can('EXPENSE_RECORD') ? `<button class="btn primary" data-act="money-new" data-t="expense">${icon('plus', 'sm')} Expense</button>` : ''}
      ${can('INCOME_RECORD') ? `<button class="btn" data-act="money-new" data-t="income">${icon('plus', 'sm')} Income</button>` : ''}</div></div>
    <div class="seg m-periods">${M_PERIODS.map((p) => `<button class="${period === p[0] ? 'on' : ''}" data-act="money-period" data-p="${p[0]}">${p[1]}</button>`).join('')}</div>
    <div class="m-src muted small">${S.ui.mLoading ? 'Loading all phones…' : d.online ? `${icon('check', 'sm')} All phones of this shop` : `${icon('alert', 'sm')} Offline — showing entries made on this phone only`}
      ${!S.ui.mLoading && S.session.token ? ` · <a href="#" data-act="money-reload">refresh</a>` : ''}</div>
    <div class="kpis m-kpis">${card('Income', s.inUSD, s.inLRD, 'in')}${card('Expenses', s.outUSD, s.outLRD, 'out')}${card('Balance', bal, s.inLRD - s.outLRD, bal >= 0 ? 'pos' : 'neg')}</div>
    ${nipNote}
    <div class="m-grid">
      <div class="card"><h3>By category</h3>${d.cats.length ? d.cats.map((c) => `<div class="m-bar ${c.type}">
          <div class="m-bar-top"><span>${esc(c.name)}${c.notInProfit ? ' <span class="badge">not in profit</span>' : ''} <span class="muted small">· ${c.count}</span></span><b class="num">${fmtUSD(c.usd)}</b></div>
          <div class="m-track"><i style="width:${Math.max(3, (c.usd / maxCat) * 100).toFixed(1)}%"></i></div></div>`).join('') : '<div class="empty">Nothing recorded in this period.</div>'}
        <div class="m-legend"><span class="in">Income</span><span class="out">Expense</span></div></div>
      <div class="card"><h3>Money in vs out</h3>${d.days.length > 1 ? `<div class="m-chart">${d.days.map((x) => `<div class="m-day" title="${x.d.toDateString()}: in ${fmtUSD(x.inUSD)}, out ${fmtUSD(x.outUSD)}">
          <div class="m-cols"><i class="in" style="height:${((x.inUSD / maxDay) * 100).toFixed(1)}%"></i><i class="out" style="height:${((x.outUSD / maxDay) * 100).toFixed(1)}%"></i></div>
          <span>${d.days.length > 10 ? (x.d.getDate() % 5 === 1 ? x.d.getDate() : '') : x.d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)}</span></div>`).join('')}</div>`
          : `<div class="m-today"><div><span class="in">In</span><b>${fmtUSD(s.inUSD)}</b></div><div><span class="out">Out</span><b>${fmtUSD(s.outUSD)}</b></div></div>`}
        <div class="m-legend"><span class="in">Money in</span><span class="out">Money out</span></div></div>
    </div>
    <div class="card" style="margin-top:1rem"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem"><h3 style="margin:0">All entries <span class="muted small">(${list.length})</span></h3>
        ${d.deleted ? `<label class="check small" style="margin:0"><input type="checkbox" data-act="money-showdel" ${S.ui.mShowDel ? 'checked' : ''}> Show deleted (${d.deleted})</label>` : ''}</div>
      <div class="m-filters">
        <div class="searchbox">${icon('search')}<input id="m-q" type="text" placeholder="Search description, paid to, amount" value="${esc(S.ui.mQ || '')}" data-input="m-q"></div>
        <select data-input="m-type"><option value="">Expenses + income</option><option value="expense" ${fType === 'expense' ? 'selected' : ''}>Expenses</option><option value="income" ${fType === 'income' ? 'selected' : ''}>Income</option></select>
        <select data-input="m-cat"><option value="">All categories</option>${allCats.map((c) => `<option ${c === fCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="m-list">${list.map((e) => `<div class="m-row ${e.status === 'DELETED' ? 'del' : ''}">
          <span class="m-ic ${e.type}">${icon(e.type === 'expense' ? 'cash' : 'wallet', 'sm')}</span>
          <span class="grow"><b>${esc(e.category)}</b>${e.notInProfit ? ' <span class="badge">not in profit</span>' : ''}${e.status === 'EDITED' ? ' <span class="badge brand">edited</span>' : ''}${e.unsynced ? ' <span class="badge warn">not synced</span>' : ''}${e.status === 'DELETED' ? ` <span class="badge bad">deleted</span>` : ''}
            <div class="muted small">${fmtDate(e.timestamp)}${e.description ? ' · ' + esc(e.description) : ''}${e.party ? ' · ' + (e.type === 'expense' ? 'to ' : 'from ') + esc(e.party) : ''} · ${esc(userName(e.userId))}${e.status === 'DELETED' && e.deleteReason ? ' · reason: ' + esc(e.deleteReason) : ''}</div></span>
          <span class="right num"><b class="${e.type === 'expense' ? 'neg' : 'pos'}">${e.type === 'expense' ? '−' : '+'}${fmtCur(e.amount, e.currency)}</b>
            <div class="muted small">${e.currency === 'USD' ? fmtLRD(e.amountLRD) : fmtUSD(e.amountUSD)}</div></span>
          ${e.canEdit && e.status !== 'DELETED' ? `<span class="m-acts"><button class="btn sm ghost" data-act="money-edit" data-id="${esc(e.id)}">Edit</button><button class="btn sm ghost danger" data-act="money-del" data-id="${esc(e.id)}" title="Delete">${icon('trash', 'sm')}</button></span>` : '<span class="m-acts"></span>'}
        </div>`).join('') || '<div class="empty">No entries match.</div>'}</div></div>`;
}

function moneyForm(t, e) {
  const cats = moneyCats(t).map((c) => c.Name);
  if (e && cats.indexOf(e.category) < 0) cats.unshift(e.category);
  const dt = e ? new Date(e.timestamp) : new Date();
  const dstr = new Date(dt.getTime() - dt.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  return `<div class="grid2"><div class="field"><label>Category</label><select name="category" required>${cats.map((c) => `<option ${e && e.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>${t === 'expense' ? 'Paid to' : 'Received from'}</label><input name="party" type="text" value="${esc(e ? e.party : '')}"></div></div>
      <div class="field"><label>Description</label><input name="description" type="text" value="${esc(e ? e.description : '')}"></div>
      <div class="grid2"><div class="field"><label>Currency</label><select name="currency"><option ${e && e.currency === 'LRD' ? 'selected' : ''}>LRD</option><option ${e && e.currency === 'USD' ? 'selected' : ''}>USD</option></select></div>
        <div class="field"><label>Amount</label><input name="amount" type="number" step="any" min="0" required value="${e ? esc(e.amount) : ''}" class="bigin"></div></div>
      ${e ? `<div class="field"><label>Date</label><input name="date" type="date" value="${dstr}" max="${new Date().toISOString().slice(0, 10)}"></div>
        <p class="muted small">The exchange rate stays the one used on the day it was first recorded${e.rate ? ' (' + fmtQty(e.rate) + ')' : ''}, so older reports don't change.</p>` : ''}`;
}
function moneyNewModal() {
  const t = S.ui.moneyTab;
  return `<div class="modal-head"><h2>${t === 'expense' ? 'New expense' : 'New income'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="money" data-t="${t}">${moneyForm(t)}<button class="btn primary block" type="submit">Save ${t === 'expense' ? 'expense' : 'income'}</button></form>`;
}
function findMoneyEntry(id) { return moneyData().entries.find((e) => e.id === id); }
function moneyEditModal() {
  const e = findMoneyEntry(S.ui.mEdit);
  if (!e) return '<div class="empty">Entry not found</div>';
  return `<div class="modal-head"><h2>Edit ${e.type === 'expense' ? 'expense' : 'income'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="money-edit">${moneyForm(e.type, e)}
      ${e.unsynced ? '<p class="muted small">Not synced yet — the change is made on this phone and sent with the entry.</p>' : ''}
      <button class="btn primary block" type="submit">Save changes</button></form>`;
}
const DEL_REASONS = ['Entered twice', 'Wrong amount — will enter again', 'Wrong category — will enter again', 'Entered by mistake', 'Other'];
function moneyDelModal() {
  const e = findMoneyEntry(S.ui.mEdit);
  if (!e) return '<div class="empty">Entry not found</div>';
  return `<div class="modal-head"><h2>Delete this entry?</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <div class="void-sum"><b>${esc(e.category)}</b> · ${fmtCur(e.amount, e.currency)} · ${fmtDate(e.timestamp)}${e.description ? '<div class="muted small">' + esc(e.description) + '</div>' : ''}</div>
    <p class="muted small" style="margin:.6rem 0">It is marked as deleted and left out of all totals. It is not erased: the owner can still see it with the reason.</p>
    <form data-form="money-del"><div class="field"><label>Reason</label><select name="why">${DEL_REASONS.map((x) => `<option>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Note (optional)</label><input name="note" type="text"></div>
      <div class="row" style="gap:.5rem"><button class="btn ghost" type="button" data-act="close">Cancel</button><button class="btn danger grow" type="submit">${icon('trash', 'sm')} Delete entry</button></div></form>`;
}
function guardSyncing() { if (S.syncing) { toast('Syncing — try again in a moment', 'bad'); return true; } return false; }
const MONEY_ACTS = {
  'money-period': (el) => { S.ui.mPeriod = el.dataset.p; S.money = null; render(); loadMoney(); },
  'money-reload': (el, ev) => { if (ev) ev.preventDefault(); loadMoney(); },
  'money-new': (el) => { S.ui.moneyTab = el.dataset.t; showModal(moneyNewModal); },
  'money-showdel': () => { S.ui.mShowDel = !S.ui.mShowDel; render(); },
  'money-edit': (el) => { S.ui.mEdit = el.dataset.id; showModal(moneyEditModal); },
  'money-del': (el) => { S.ui.mEdit = el.dataset.id; showModal(moneyDelModal); }
};
const MONEY_FORMS = {
  'money-edit': async (f) => {
    const e = findMoneyEntry(S.ui.mEdit); if (!e) return;
    const amt = num(f.amount.value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    const t0 = new Date(e.timestamp);
    const nd = f.date.value ? new Date(f.date.value + 'T' + String(t0.getHours()).padStart(2, '0') + ':' + String(t0.getMinutes()).padStart(2, '0') + ':00') : t0;
    const ch = { category: f.category.value, description: f.description.value.trim(), party: f.party.value.trim(), currency: f.currency.value, amount: amt, timestamp: nd.toISOString() };
    if (e.unsynced) {
      if (guardSyncing()) return;
      const q = unsyncedMoney(e.id); const j = S.journal.find((x) => x.id === e.id);
      [q && q.rec, j].forEach((r) => {
        if (!r) return;
        if (!r.original) r.original = { Category: r.category, Description: r.description || '', Party: (r.type === 'expense' ? r.paidTo : r.receivedFrom) || '', Currency: r.currency, Amount: r.amount, Timestamp: r.timestamp };
        Object.assign(r, { category: ch.category, description: ch.description, currency: ch.currency, amount: ch.amount, timestamp: ch.timestamp, editedBy: S.session.user.UserID, editedAt: nowISO() });
        if (r.type === 'expense') r.paidTo = ch.party; else r.receivedFrom = ch.party;
        if (q) q.status = 'pending';
      });
      persist.queue(); persist.journal();
      closeModal(); toast('Changed', 'ok'); render(); scheduleSync(1500);
      return;
    }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await adminCall('moneyEdit', Object.assign({ type: e.type, id: e.id }, ch));
      closeModal(); toast('Changed', 'ok'); await loadMoney();
    } catch (x) { toast(x.message, 'bad'); btn.disabled = false; btn.textContent = 'Save changes'; }
  },
  'money-del': async (f) => {
    const e = findMoneyEntry(S.ui.mEdit); if (!e) return;
    const reason = f.why.value + (f.note.value.trim() ? ' — ' + f.note.value.trim() : '');
    if (e.unsynced) {
      if (guardSyncing()) return;
      const q = unsyncedMoney(e.id); const j = S.journal.find((x) => x.id === e.id);
      [q && q.rec, j].forEach((r) => { if (r) Object.assign(r, { status: 'DELETED', deleteReason: reason, editedBy: S.session.user.UserID, editedAt: nowISO() }); });
      if (q) q.status = 'pending';
      persist.queue(); persist.journal();
      closeModal(); toast('Deleted', 'ok'); render(); scheduleSync(1500);
      return;
    }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      await adminCall('moneyDelete', { type: e.type, id: e.id, reason });
      closeModal(); toast('Deleted', 'ok'); await loadMoney();
    } catch (x) { toast(x.message, 'bad'); btn.disabled = false; btn.textContent = 'Delete entry'; }
  }
};

/* =====================================================================
 * Customers
 * ===================================================================== */
function viewCustomers() {
  const q = (S.ui.custListQ || '').toLowerCase();
  const list = customers().filter((c) => !q || (c.Name + ' ' + c.Phone).toLowerCase().indexOf(q) >= 0);
  const total = list.reduce((t, c) => t + Math.max(0, c.BalanceUSD), 0);
  return `<div class="page-head"><h2>Customers & credit</h2>
      ${canAny('CUSTOMER_MANAGE', 'CREDIT_SALE') ? `<button class="btn primary" data-act="new-customer">${icon('plus', 'sm')} New customer</button>` : ''}</div>
    <div class="kpis" style="margin-bottom:.8rem"><div class="kpi"><div class="k">Owed to the business</div><div class="v">${fmtUSD(total)}</div><div class="s">${fmtLRD(total * rate())}</div></div>
      <div class="kpi"><div class="k">Customers</div><div class="v">${list.length}</div></div></div>
    <div class="searchbox" style="max-width:380px;margin-bottom:.8rem">${icon('search')}<input id="custlist-q" type="text" placeholder="Search name or phone" value="${esc(S.ui.custListQ || '')}" data-input="custlist-q"></div>
    <div class="card table-wrap" id="cust-table"><table><thead><tr><th>Customer</th><th class="right">Balance</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.Name)}</b>${c._pending ? ' <span class="badge warn">not synced</span>' : ''}<div class="muted small">${esc(c.Phone)}${num(c.CreditLimitUSD) ? ' · limit ' + fmtUSD(c.CreditLimitUSD) : ''}</div></td>
        <td class="right num"><b class="${c.BalanceUSD > 0.004 ? '' : 'muted'}">${fmtUSD(c.BalanceUSD)}</b><div class="muted small">${fmtLRD(c.BalanceUSD * rate())}</div></td>
        <td class="right">${can('CREDIT_COLLECT') && c.BalanceUSD > 0.004 ? `<button class="btn sm primary" data-act="collect" data-id="${esc(c.CustomerID)}">Receive payment</button>` : ''}
        ${can('CUSTOMER_MANAGE') ? `<button class="btn sm ghost" data-act="edit-customer" data-id="${esc(c.CustomerID)}">Edit</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No customers</td></tr>'}
    </tbody></table></div>`;
}

function collectModal(c) {
  return `<div class="modal-head"><h2>Payment from ${esc(c.Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <div class="due"><div class="usd">${fmtUSD(c.BalanceUSD)}</div><div class="lrd">owed · ${fmtLRD(c.BalanceUSD * rate())}</div></div>
    <form data-form="collect" data-id="${esc(c.CustomerID)}">
      <div class="grid2"><div class="field"><label>Paid with</label><select name="method">${METHODS.filter((m) => m[0] !== 'CREDIT').map((m) => `<option value="${m[0]}">${m[1]}</option>`).join('')}</select></div>
        <div class="field"><label>Currency</label><select name="currency"><option>LRD</option><option>USD</option></select></div></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="any" required></div>
      <button class="btn primary block" type="submit">Save payment</button></form>`;
}

/* =====================================================================
 * Shift (till open / close)
 * ===================================================================== */
function shiftExpected() {
  const sh = S.shift;
  const out = { usd: num(sh.openingUSD), lrd: num(sh.openingLRD), sales: 0, salesUSD: 0 };
  S.journal.filter((r) => r.timestamp >= sh.openedAt && r.userId === sh.userId).forEach((r) => {
    if (r.type === 'sale') {
      out.sales++;
      r.payments.forEach((p) => {
        if (p.method === 'USD_CASH') out.usd += num(p.amount);
        if (p.method === 'LRD_CASH') out.lrd += num(p.amount);
        out.salesUSD += toUSDAt(p.amount, p.currency, r.rate);
      });
      // change handed back
      const total = r.items.reduce((t, i) => t + toUSDAt(i.unitPrice * i.qty, i.priceCurrency, r.rate), 0) - num(r.discountUSD);
      const paid = r.payments.reduce((t, p) => t + toUSDAt(p.amount, p.currency, r.rate), 0);
      const ch = Math.max(0, paid - total);
      if (r.changeCurrency === 'USD') out.usd -= ch; else out.lrd -= Math.round(ch * num(r.rate));
    }
    if (r.type === 'customerPayment') { if (r.method === 'USD_CASH') out.usd += num(r.amount); if (r.method === 'LRD_CASH') out.lrd += num(r.amount); }
    if (r.type === 'expense') { if (r.currency === 'USD') out.usd -= num(r.amount); else out.lrd -= num(r.amount); }
  });
  return out;
}

function viewShift() {
  if (!S.shift) {
    return `<div class="page-head"><div><h2>Till shift</h2><div class="sub">Open with your cash float, close with a cash count</div></div></div><div class="card" style="max-width:520px"><p>Open a shift at the start of the day with the cash in the drawer. At closing you count the cash and the app compares it with what it should be.</p>
      <form data-form="shift-open"><div class="grid2"><div class="field"><label>Opening cash USD</label><input name="usd" type="number" step="any" value="0"></div>
      <div class="field"><label>Opening cash LRD</label><input name="lrd" type="number" step="any" value="0"></div></div>
      <button class="btn primary block" type="submit">Open shift</button></form></div>`;
  }
  const e = shiftExpected();
  return `<div class="page-head"><div><h2>Till shift</h2><div class="sub">Open with your cash float, close with a cash count</div></div></div><div class="card" style="max-width:620px">
    <p>Opened ${fmtDate(S.shift.openedAt)} by <b>${esc(userName(S.shift.userId))}</b> · ${e.sales} sale(s)</p>
    <div class="kpis"><div class="kpi"><div class="k">Expected USD in drawer</div><div class="v">${fmtUSD(e.usd)}</div></div>
      <div class="kpi"><div class="k">Expected LRD in drawer</div><div class="v">${fmtLRD(e.lrd)}</div></div></div>
    <p class="muted small">Expected = opening cash + cash sales + cash debt repayments − change given − expenses paid on this device.</p>
    ${S.shift.userId === S.session.user.UserID || can('SALE_VOID') ? `<form data-form="shift-close"><div class="grid2"><div class="field"><label>Counted USD</label><input name="usd" type="number" step="any" required></div>
      <div class="field"><label>Counted LRD</label><input name="lrd" type="number" step="any" required></div></div>
      <div class="field"><label>Note</label><input name="note" type="text"></div>
      <button class="btn accent block" type="submit">Close shift</button></form>` : '<p class="muted">Only the person who opened the shift or a manager can close it.</p>'}</div>`;
}

/* =====================================================================
 * Reports (online)
 * ===================================================================== */
let reportCache = null;
function periodRange(p) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const tomorrow = new Date(d.getTime() + 86400000);
  if (p === 'today') return [d, tomorrow];
  if (p === 'yesterday') return [new Date(d.getTime() - 86400000), d];
  if (p === 'week') return [new Date(d.getTime() - 6 * 86400000), tomorrow];
  if (p === 'month') return [new Date(d.getFullYear(), d.getMonth(), 1), tomorrow];
  return [new Date(0), tomorrow];
}

function viewReports() {
  const periods = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 days'], ['month', 'This month'], ['all', 'All time']];
  const stores = (S.snap.stores || []).filter((s) => s.Status === 'ACTIVE');
  const myStores = S.session.user.StoreIDs === 'ALL' || (S.session.role && S.session.role.Scope === 'ALL_STORES') ? stores.map((s) => s.StoreID) : String(S.session.user.StoreIDs || '').split(',');
  const opts = [];
  if (can('REPORTS_ALL')) opts.push(['all', 'All stores']);
  stores.filter((s) => myStores.indexOf(s.StoreID) >= 0).forEach((s) => opts.push([s.StoreID, s.Code + ' ' + s.Name]));
  if (S.ui.reportStore === 'mine') S.ui.reportStore = can('REPORTS_ALL') && store().StoreID === 'HQ' ? 'all' : (myStores.indexOf(store().StoreID) >= 0 ? store().StoreID : (opts[0] || [''])[0]);
  const r = reportCache && reportCache.key === S.ui.reportPeriod + '|' + S.ui.reportStore ? reportCache.report : null;
  return `<div class="page-head"><div><h2>Reports</h2><div class="sub">Every amount in US dollars, with Liberian dollars underneath</div></div>
      <select id="rep-store" data-input="rep-store" style="max-width:280px">${opts.map((o) => `<option value="${esc(o[0])}" ${S.ui.reportStore === o[0] ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></div>
    <div class="tabs">${periods.map((p) => `<button class="tab ${S.ui.reportPeriod === p[0] ? 'on' : ''}" data-act="rep-period" data-p="${p[0]}">${p[1]}</button>`).join('')}
      <button class="tab" data-act="rep-load">${icon('sync', 'sm')} Refresh</button></div>
    <div id="report-body">${r ? reportBody(r) : `<div class="card empty">${S.ui.repLoading ? 'Loading report…' : (S.ui.repError ? esc(S.ui.repError) : 'Tap Refresh to load the report (needs internet).')}</div>`}</div>`;
}

const PERIOD_LABEL = { today: 'today', yesterday: 'yesterday', week: 'in the last 7 days', month: 'this month', all: 'so far' };

function bigCard(label, usd, lrd, note, cls) {
  return `<div class="rcard ${cls || ''}"><div class="k">${label}</div>
    <div class="v">${fmtUSD(usd)}</div><div class="v2">${fmtLRD(lrd)}</div>${note ? `<div class="s">${note}</div>` : ''}</div>`;
}

function reportBody(r) {
  const t = r.totals;
  const hasProfit = t.netProfitUSD !== undefined;
  const when = PERIOD_LABEL[S.ui.reportPeriod] || '';
  const taken = r.taken || { usd: 0, lrd: 0 };
  const methods = Object.keys(r.byPayment).map((k) => Object.assign({ k }, r.byPayment[k])).sort((a, b) => b.amountUSD - a.amountUSD);
  const maxPay = Math.max(1, ...methods.map((m) => m.amountUSD));
  const daily = r.daily || [];
  const maxDay = Math.max(1, ...daily.map((d) => d.salesUSD));
  const stores = Object.keys(r.byStore);
  const mini = [];
  if (hasProfit) mini.push(['Cost of goods sold', fmtUSD(t.cogsUSD), fmtLRD(t.cogsLRD)], ['Gross profit', fmtUSD(t.grossProfitUSD), fmtLRD(t.grossProfitLRD)]);
  mini.push(['Other income', fmtUSD(t.incomeUSD), fmtLRD(t.incomeLRD)], ['Sold on credit', fmtUSD(t.creditSalesUSD), fmtLRD(t.creditSalesUSD * rate()) + ' today']);
  mini.push(['Customers owe you', fmtUSD(t.creditOutstandingUSD), fmtLRD(t.creditOutstandingUSD * rate()) + ' today']);
  if (hasProfit && t.stockValueUSD !== undefined) mini.push(['Stock value (cost)', fmtUSD(t.stockValueUSD), fmtLRD(t.stockValueUSD * rate()) + ' today']);
  if (t.discountUSD) mini.push(['Discounts given', fmtUSD(t.discountUSD), '']);

  return `
  <div class="rgrid">
    ${bigCard('Sales', t.salesUSD, t.salesLRD, `${t.salesCount} sale${t.salesCount === 1 ? '' : 's'} ${when}`, 'brand')}
    ${bigCard('Expenses', t.expensesUSD, t.expensesLRD, 'rent, fuel, salaries and other costs')}
    ${t.nonProfitOutUSD || t.nonProfitInUSD ? bigCard('Loans & owner money', num(t.nonProfitInUSD) - num(t.nonProfitOutUSD), num(t.nonProfitInLRD) - num(t.nonProfitOutLRD), 'in ' + fmtUSD(t.nonProfitInUSD) + ' · out ' + fmtUSD(t.nonProfitOutUSD) + ' — not in profit') : ''}
    ${hasProfit ? bigCard('Profit', t.netProfitUSD, t.netProfitLRD, 'sales − cost of goods − expenses + other income', t.netProfitUSD >= 0 ? 'good' : 'bad')
      : `<div class="rcard"><div class="k">Profit</div><div class="s" style="margin-top:.6rem">Only the owner and managers can see profit.</div></div>`}
    <div class="rcard"><div class="k">Money taken in</div>
      <div class="v">${fmtUSD(taken.usd)}</div><div class="v">${fmtLRD(taken.lrd)}</div>
      <div class="s">cash + mobile money, after change. Should match your drawer and phones.</div></div>
  </div>

  <div class="card" style="margin-top:1rem"><div class="ministats">${mini.map((m) => `<div><div class="k">${m[0]}</div><div class="v">${m[1]}</div><div class="s">${m[2]}</div></div>`).join('')}</div></div>

  <div class="rcols">
    <div class="card"><h3>Daily sales · last 14 days</h3>
      ${daily.length ? `<div class="bars">${daily.map((d) => {
        const dt = new Date(d.date + 'T12:00:00Z');
        const isToday = d.date === new Date().toISOString().slice(0, 10);
        return `<div class="bar ${isToday ? 'today' : ''}" title="${dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}: ${fmtUSD(d.salesUSD)} · ${fmtLRD(d.salesLRD)} · ${d.count} sales">
          <span class="amt">${d.salesUSD >= 1000 ? '$' + (d.salesUSD / 1000).toFixed(1) + 'k' : '$' + Math.round(d.salesUSD)}</span>
          <span class="col" style="height:${Math.max(2, Math.round(d.salesUSD / maxDay * 100))}%"></span>
          <span class="lbl">${dt.toLocaleDateString('en-GB', { day: 'numeric' })}<br>${dt.toLocaleDateString('en-GB', { weekday: 'narrow' })}</span></div>`;
      }).join('')}</div>` : '<div class="empty">No data</div>'}</div>

    <div class="card"><h3>How customers paid</h3>
      ${methods.length ? methods.map((m) => { const mm = METHODS.find((x) => x[0] === m.k);
        return `<div class="payrow"><div class="row between"><span class="row">${icon(mm ? mm[3] : 'cash', 'sm')} <b>${esc(mm ? mm[1] : m.k)}</b> <span class="muted small">${m.count}×</span></span>
          <span class="num"><b>${fmtUSD(m.amountUSD)}</b></span></div>
          <div class="meter"><span style="width:${Math.round(m.amountUSD / maxPay * 100)}%"></span></div>
          <div class="muted small">${m.k === 'CREDIT' ? 'not paid yet — added to customer balances' : 'received: ' + [m.tenderedUSD ? fmtUSD(m.tenderedUSD) : '', m.tenderedLRD ? fmtLRD(m.tenderedLRD) : ''].filter(Boolean).join(' + ')}</div></div>`; }).join('')
        : `<div class="empty">No sales ${when}</div>`}</div>
  </div>

  ${stores.length > 1 ? `<div class="card" style="margin-top:1rem"><h3>Stores</h3><div class="table-wrap"><table><thead><tr><th>Store</th><th class="right">Sales</th><th class="right">Expenses</th>${hasProfit ? '<th class="right">Profit</th>' : ''}<th class="right">Sales</th></tr></thead><tbody>
    ${stores.map((k) => { const a = r.byStore[k]; const st = (S.snap.stores || []).find((x) => x.StoreID === k) || {};
      return `<tr><td><span class="store-dot" style="background:${esc(st.Color || themeColor())}"></span><b>${esc(storeName(k))}</b></td>
        <td class="right num"><b>${fmtUSD(a.salesUSD)}</b><div class="muted small">${fmtLRD(a.salesLRD)}</div></td>
        <td class="right num">${fmtUSD(a.expensesUSD)}<div class="muted small">${fmtLRD(a.expensesLRD)}</div></td>
        ${hasProfit ? `<td class="right num"><b style="color:${a.netProfitUSD < 0 ? 'var(--bad)' : 'var(--ok)'}">${fmtUSD(a.netProfitUSD)}</b><div class="muted small">${fmtLRD(a.netProfitLRD)}</div></td>` : ''}
        <td class="right num muted">${a.salesCount}</td></tr>`; }).join('')}</tbody></table></div></div>` : ''}

  <div class="rcols">
    <div class="card"><h3>Best sellers</h3>${r.topByRevenue.length ? r.topByRevenue.slice(0, 8).map((p, i) => `<div class="list-item">
      <span class="rank">${i + 1}</span><span class="grow"><b>${esc(p.name)}</b><div class="muted small">${fmtQty(p.qty)} sold${p.profitUSD !== undefined ? ' · profit ' + fmtUSD(p.profitUSD) : ''}</div></span>
      <b class="num">${fmtUSD(p.revenueUSD)}</b></div>`).join('') : `<div class="empty">No sales ${when}</div>`}</div>
    <div class="card"><h3>Needs attention</h3>
      ${r.lowStock.length ? r.lowStock.slice(0, 8).map((x) => `<div class="list-item"><span class="grow"><b>${esc(x.product)}</b><div class="muted small">${esc(x.store)} · reorder at ${fmtQty(x.reorderLevel)}</div></span>
        <span class="badge ${x.qty <= 0 ? 'bad' : 'warn'}">${fmtQty(x.qty)} left</span></div>`).join('') + (r.lowStock.length > 8 ? `<p class="muted small">+ ${r.lowStock.length - 8} more low items — see Stock</p>` : '')
        : `<div class="empty">${icon('check')}Everything is well stocked</div>`}
      ${Object.keys(r.expensesByCategory).length ? `<h3 style="margin-top:1rem">Where expenses went</h3>${Object.keys(r.expensesByCategory).sort((a, b) => r.expensesByCategory[b].usd - r.expensesByCategory[a].usd).map((k) =>
        `<div class="list-item"><span class="grow">${esc(k)}${r.expensesByCategory[k].notInProfit ? ' <span class="badge warn">not in profit</span>' : ''}</span><span class="num right"><b>${fmtUSD(r.expensesByCategory[k].usd)}</b><div class="muted small">${fmtLRD(r.expensesByCategory[k].lrd)}</div></span></div>`).join('')}` : ''}
    </div>
  </div>`;
}

async function loadReport() {
  const [from, to] = periodRange(S.ui.reportPeriod);
  const storeIds = S.ui.reportStore === 'all' ? [] : [S.ui.reportStore];
  S.ui.repLoading = true; S.ui.repError = ''; render();
  try {
    const res = await adminCall('report', { from: from.toISOString(), to: to.toISOString(), storeIds });
    reportCache = { key: S.ui.reportPeriod + '|' + S.ui.reportStore, report: res.report };
  } catch (e) { S.ui.repError = e.message; reportCache = null; }
  S.ui.repLoading = false;
  render();
}

/* =====================================================================
 * Admin (online)
 * ===================================================================== */
function adminTabs() {
  const t = [];
  if (canAny('RATE_SET_GLOBAL', 'RATE_SET_STORE')) t.push(['rate', 'Exchange rate']);
  t.push(['stores', 'Stores']);
  if (can('USER_MANAGE') && feature('Staff')) t.push(['users', 'Users']);
  if (can('DEVICE_MANAGE')) t.push(['devices', 'Devices']);
  if (canAny('PRODUCT_MANAGE', 'PRICE_MANAGE')) t.push(['products', 'Products']);
  if (feature('OnlineShop') && canAny('SHOP_MANAGE', 'STORE_MANAGE') && (store().Type === 'SHOP' || store().StoreID === 'HQ')) t.push(['shop', 'Online shop']);
  if (can('CATEGORY_MANAGE') && feature('Money')) t.push(['categories', 'Categories']);
  if (canChangeFeatures()) t.push(['features', 'Features']);
  if (can('SETTINGS_MANAGE')) t.push(['settings', 'Owner settings']);
  return t;
}

/* ---------- Admin → Categories (expense & income) ---------- */
function adminCategories() {
  if (!S.cats && !S.ui.catLoading && S.session.token) setTimeout(loadCats, 0);
  if (!S.cats) return `<div class="card empty">${S.ui.catLoading || S.session.token ? 'Loading…' : 'Needs internet — log in again while connected.'}</div>`;
  const t = S.ui.catType || 'EXPENSE';
  const list = S.cats.filter((c) => c.type === t).sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
  const locked = ['Contract Income', 'Delivery Fees'];
  return `<div class="seg" style="margin-bottom:.8rem"><button class="${t === 'EXPENSE' ? 'on' : ''}" data-act="cat-type" data-t="EXPENSE">Expenses (${S.cats.filter((c) => c.type === 'EXPENSE' && c.active).length})</button>
      <button class="${t === 'INCOME' ? 'on' : ''}" data-act="cat-type" data-t="INCOME">Income (${S.cats.filter((c) => c.type === 'INCOME' && c.active).length})</button></div>
    <div class="card"><h3>Add a${t === 'EXPENSE' ? 'n expense' : 'n income'} category</h3>
      <form data-form="cat-add" class="row" style="gap:.5rem;flex-wrap:wrap;align-items:flex-end">
        <div class="field grow" style="margin:0;min-width:200px"><label>Name</label><input name="name" type="text" maxlength="40" required placeholder="${t === 'EXPENSE' ? 'e.g. Tape measures' : 'e.g. Embroidery orders'}"></div>
        <label class="check" style="margin:0 0 .6rem"><input type="checkbox" name="nip"> Not counted in profit (loans, owner money)</label>
        <button class="btn primary" type="submit">${icon('plus', 'sm')} Add</button></form></div>
    <div class="card" style="margin-top:1rem"><h3>${t === 'EXPENSE' ? 'Expense' : 'Income'} categories</h3>
      <p class="muted small" style="margin-top:-.3rem">Hidden categories are not offered when recording, but past entries keep them. Renaming also renames past entries.</p>
      ${list.map((c) => `<div class="list-item cat-item ${c.active ? '' : 'off'}"><span class="grow"><b>${esc(c.name)}</b>
          ${c.notInProfit ? ' <span class="badge warn">not in profit</span>' : ''}${c.active ? '' : ' <span class="badge">hidden</span>'}</span>
        <span class="cat-acts">${locked.indexOf(c.name) < 0 ? `<button class="btn sm ghost" data-act="cat-rename" data-n="${esc(c.name)}">Rename</button>` : ''}
        <button class="btn sm ghost" data-act="cat-nip" data-n="${esc(c.name)}">${c.notInProfit ? 'Count in profit' : 'Leave out of profit'}</button>
        <button class="btn sm ${c.active ? 'ghost' : 'primary'}" data-act="cat-hide" data-n="${esc(c.name)}">${c.active ? 'Hide' : 'Show'}</button></span></div>`).join('')}</div>`;
}
async function loadCats() {
  S.ui.catLoading = true;
  try { S.cats = (await adminCall('categoryList', {})).categories; } catch (e) { toast(e.message, 'bad'); }
  S.ui.catLoading = false; render();
}
async function saveCat(body, msg) {
  try {
    const r = await adminCall('categorySave', Object.assign({ type: S.ui.catType || 'EXPENSE' }, body));
    S.cats = r.categories;
    // devices offer only active money categories; update this phone now (others get it at their next sync)
    S.snap.categories = (S.snap.categories || []).filter((c) => c.Type !== 'EXPENSE' && c.Type !== 'INCOME')
      .concat(r.categories.filter((c) => c.active).map((c) => ({ Type: c.type, Name: c.name, Active: true, NotInProfit: c.notInProfit })));
    persist.snap(); S.money = undefined;
    toast(msg, 'ok'); render(); return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}
function catRenameModal() {
  return `<div class="modal-head"><h2>Rename category</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="cat-rename"><div class="field"><label>New name for “${esc(S.ui.catEdit)}”</label><input name="name" type="text" maxlength="40" required value="${esc(S.ui.catEdit)}"></div>
      <p class="muted small">All past entries in this category get the new name too.</p>
      <button class="btn primary block" type="submit">Rename</button></form>`;
}
const CAT_ACTS = {
  'cat-type': (el) => { S.ui.catType = el.dataset.t; render(); },
  'cat-rename': (el) => { S.ui.catEdit = el.dataset.n; showModal(catRenameModal); },
  'cat-hide': (el) => { const c = S.cats.find((x) => x.type === (S.ui.catType || 'EXPENSE') && x.name === el.dataset.n); if (c) saveCat({ oldName: c.name, name: c.name, active: !c.active }, c.active ? 'Hidden' : 'Shown again'); },
  'cat-nip': (el) => { const c = S.cats.find((x) => x.type === (S.ui.catType || 'EXPENSE') && x.name === el.dataset.n); if (c) saveCat({ oldName: c.name, name: c.name, notInProfit: !c.notInProfit }, c.notInProfit ? 'Now counted in profit' : 'Now left out of profit'); }
};
const CAT_FORMS = {
  'cat-add': async (f) => { if (await saveCat({ name: f.name.value, notInProfit: f.nip.checked }, 'Category added')) f.reset(); },
  'cat-rename': async (f) => { if (await saveCat({ oldName: S.ui.catEdit, name: f.name.value }, 'Renamed')) closeModal(); }
};

function viewAdmin() {
  const tabs = adminTabs();
  if (!S.ui.adminTab || !tabs.some((x) => x[0] === S.ui.adminTab)) S.ui.adminTab = tabs[0][0];
  const body = { rate: adminRate, stores: adminStores, users: adminUsers, devices: adminDevices, products: adminProducts, settings: adminSettings, shop: adminShop, features: adminFeatures, categories: adminCategories }[S.ui.adminTab];
  const needData = ['users', 'devices', 'products', 'settings'].indexOf(S.ui.adminTab) >= 0;
  return `<div class="page-head"><div><h2>Admin</h2><div class="sub">Manage stores, people, devices and settings</div></div></div><div class="tabs">${tabs.map((x) => `<button class="tab ${S.ui.adminTab === x[0] ? 'on' : ''}" data-act="admin-tab" data-t="${x[0]}">${x[1]}</button>`).join('')}</div>
    ${!S.session.token ? '<div class="card" style="background:#fbf0d9;margin-bottom:.8rem">You logged in offline. Admin changes need internet — log out and log in again while connected.</div>' : ''}
    ${needData && !S.admin ? `<div class="card empty">${S.ui.adminLoading ? 'Loading…' : `<button class="btn primary" data-act="admin-load">Load (needs internet)</button>`}</div>` : body()}`;
}

function adminRate() {
  const mode = setting('RateMode');
  const perStore = mode === 'PER_STORE';
  const st = store();
  return `<div class="card" style="max-width:560px">
    <p>Rate mode: <b>${perStore ? 'Each store sets its own rate' : 'One rate for all stores (set centrally)'}</b>${isOwner() ? ' — change in Owner settings' : ''}.</p>
    <p>Current rate here: <b>1 USD = ${rate()} LRD</b></p>
    ${perStore && st.StoreID !== 'HQ' && can('RATE_SET_STORE') ? `<form data-form="rate" data-scope="store"><div class="field"><label>New rate for ${esc(st.Name)} (LRD per 1 USD)</label><input name="rate" type="number" step="any" required></div>
      <button class="btn primary" type="submit">Set store rate</button></form>` : ''}
    ${can('RATE_SET_GLOBAL') ? `<form data-form="rate" data-scope="global" style="margin-top:1rem"><div class="field"><label>Business-wide rate (LRD per 1 USD)${perStore ? ' — used by stores without their own rate' : ''}</label>
      <input name="rate" type="number" step="any" required value="${esc(setting('GlobalRate'))}"></div><button class="btn primary" type="submit">Set business-wide rate</button></form>` : ''}
    ${!perStore && !can('RATE_SET_GLOBAL') ? '<p class="muted">The owner sets the rate for all stores.</p>' : ''}
    <p class="muted small">Sales already recorded keep the rate they were made at.</p></div>`;
}

function adminStores() {
  const stores = S.snap.stores || [];
  return `<div class="row between" style="margin-bottom:.6rem"><span class="muted">${stores.length} location(s)</span>
      ${can('STORE_MANAGE') && feature('MultiStore') ? `<button class="btn primary" data-act="store-new">${icon('plus', 'sm')} New store</button>` : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Rate</th><th>Status</th><th></th></tr></thead><tbody>
    ${stores.map((s) => `<tr><td><span class="store-dot" style="background:${esc(s.Color || setting('ThemeColor') || '#0F766E')}"></span><b>${esc(s.Code)}</b></td><td>${esc(s.Name)}<div class="muted small">${esc(s.Address || '')}</div></td><td>${esc(s.Type)}</td>
      <td class="num">${s.Rate ? esc(s.Rate) : '<span class="muted">global</span>'}</td><td><span class="badge ${s.Status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(s.Status)}</span></td>
      <td class="right">${can('STORE_MANAGE') ? `<button class="btn sm" data-act="store-color" data-id="${esc(s.StoreID)}">${icon('palette', 'sm')} Colour</button>` : ''}
        ${can('STORE_MANAGE') && s.Status === 'ACTIVE' ? `<button class="btn sm danger" data-act="store-close" data-id="${esc(s.StoreID)}">Close</button>` : ''}
        ${can('STORE_MANAGE') && s.Status !== 'ACTIVE' ? `<button class="btn sm" data-act="store-reopen" data-id="${esc(s.StoreID)}">Reopen</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function storeForm() {
  const wh = bool(setting('WarehouseEnabled'));
  return `<div class="modal-head"><h2>New store</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="store">
      <div class="field"><label>Store name</label><input name="name" type="text" required placeholder="e.g. Duala Market Shop"></div>
      <div class="grid2"><div class="field"><label>Type</label><select name="type"><option value="SHOP">Shop (sells)</option>${wh ? '<option value="WAREHOUSE">Warehouse (holds & dispatches)</option>' : ''}</select></div>
        <div class="field"><label>Phone</label><input name="phone" type="tel"></div></div>
      <div class="field"><label>Address / location</label><input name="address" type="text"></div>
      ${setting('RateMode') === 'PER_STORE' ? '<div class="field"><label>Starting exchange rate (optional)</label><input name="rate" type="number" step="any"></div>' : ''}
      <div class="field"><label>Store colour</label>${colorPicker('color', '')}</div>
      <p class="muted small">Next: add staff in Users, then create a device setup code for this store.</p>
      <button class="btn primary block" type="submit">Create store</button></form>`;
}

function colorPicker(name, value) {
  const v = (value || '').toUpperCase();
  const cur = /^#[0-9A-F]{6}$/.test(v) ? v : '#0F766E';
  return `<div class="cpicker" data-picker="${name}">
    <div class="cp-preview" style="--pc:${cur}"><span class="cp-chip"></span><span class="cp-btn">Button</span><span class="cp-tag">Badge</span><b class="cp-hex">${esc(v || 'Business colour')}</b></div>
    ${SWATCH_GROUPS.map((g) => `<div class="cp-group"><div class="cp-l">${esc(g[0])}</div><div class="swatches">${g[1].map((c) => `<button type="button" class="swatch ${v === c ? 'on' : ''}" style="background:${c}" data-act="pick-color" data-c="${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div></div>`).join('')}
    <div class="cp-group"><div class="cp-l">Your exact colour</div>
      <div class="row" style="flex-wrap:nowrap"><input type="color" value="${esc(cur.toLowerCase())}" data-input="color-custom" title="Pick any colour">
        <input type="text" class="cp-hexin" value="${esc(v)}" placeholder="#D1217E" maxlength="7" data-input="color-hex" autocomplete="off" spellcheck="false">
        <span class="muted small">Type the code from your logo, e.g. <b>#D1217E</b></span></div></div>
    <input type="hidden" name="${name}" value="${esc(v)}"></div>`;
}
function setPickerColor(box, c) {
  c = String(c || '').toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(c)) return;
  box.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x.dataset.c === c));
  box.querySelector('input[type=hidden]').value = c;
  box.querySelector('input[type=color]').value = c.toLowerCase();
  const hx = box.querySelector('.cp-hexin'); if (hx && document.activeElement !== hx) hx.value = c;
  const pv = box.querySelector('.cp-preview'); if (pv) { pv.style.setProperty('--pc', c); pv.querySelector('.cp-hex').textContent = c; }
}

function storeColorModal(st) {
  return `<div class="modal-head"><h2>Colour for ${esc(st.Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <p class="muted">Devices in this store use this colour for buttons, the header and the login screen. It helps staff see at a glance which store a device belongs to.</p>
    <form data-form="store-color" data-id="${esc(st.StoreID)}">${colorPicker('color', st.Color || '')}
      <div class="row" style="margin-top:1.2rem"><button class="btn primary grow" type="submit">Save colour</button>
      <button class="btn" type="button" data-act="clear-store-color" data-id="${esc(st.StoreID)}">Use business colour</button></div></form>`;
}

function adminUsers() {
  const users = S.admin.users || [];
  const roles = {}; (S.admin.roles || []).forEach((r) => { roles[r.RoleID] = r.RoleName; });
  return `<div class="row between" style="margin-bottom:.6rem"><span class="muted">${users.length} user(s)</span><button class="btn primary" data-act="user-edit" data-id="">${icon('plus', 'sm')} New user</button></div>
    <div class="card table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Stores</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td><b>${esc(u.FullName)}</b><div class="muted small">@${esc(u.Username)}${u.ExtraPermissions ? ' · +' + esc(u.ExtraPermissions) : ''}</div></td><td>${esc(roles[u.RoleID] || u.RoleID)}</td>
      <td class="small">${String(u.StoreIDs) === 'ALL' ? 'All stores' : String(u.StoreIDs).split(',').filter(Boolean).map(storeName).map(esc).join(', ')}</td>
      <td><span class="badge ${u.Status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(u.Status)}</span></td>
      <td class="right"><button class="btn sm" data-act="user-edit" data-id="${esc(u.UserID)}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`;
}

function userForm(u) {
  u = u || {};
  const myRank = num(S.session.role.Rank);
  const roles = (S.admin.roles || []).filter((r) => isOwner() || num(r.Rank) < myRank).filter((r) => r.RoleID !== 'OWNER' || isOwner());
  const allMine = S.session.user.StoreIDs === 'ALL' || S.session.role.Scope === 'ALL_STORES';
  const mine = allMine ? (S.snap.stores || []).map((s) => s.StoreID) : String(S.session.user.StoreIDs).split(',');
  const userStores = String(u.StoreIDs || '').split(',');
  const extra = String(u.ExtraPermissions || '').split(',');
  const grantable = (S.admin.permissions || []).filter((p) => !p.ownerOnly && can(p.code));
  return `<div class="modal-head"><h2>${u.UserID ? 'Edit user' : 'New user'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="user" data-id="${esc(u.UserID || '')}">
      <div class="grid2"><div class="field"><label>Full name</label><input name="fullName" type="text" required value="${esc(u.FullName || '')}"></div>
        <div class="field"><label>Username</label><input name="username" type="text" required value="${esc(u.Username || '')}" autocapitalize="off"></div></div>
      <div class="grid2"><div class="field"><label>Role</label><select name="roleId">${roles.map((r) => `<option value="${esc(r.RoleID)}" ${r.RoleID === u.RoleID ? 'selected' : ''}>${esc(r.RoleName)}</option>`).join('')}</select></div>
        <div class="field"><label>${u.UserID ? 'New PIN (leave empty to keep)' : 'PIN (4–8 digits)'}</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" ${u.UserID ? '' : 'required'}></div></div>
      <div class="grid2"><div class="field"><label>Phone</label><input name="phone" type="tel" value="${esc(u.Phone || '')}"></div>
        <div class="field"><label>Status</label><select name="status"><option ${u.Status !== 'INACTIVE' ? 'selected' : ''}>ACTIVE</option><option ${u.Status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option></select></div></div>
      <label>Stores</label><div class="card" style="padding:.5rem .8rem;margin-bottom:.8rem">
        ${allMine ? `<label class="check"><input type="checkbox" name="allStores" ${String(u.StoreIDs) === 'ALL' ? 'checked' : ''}> All stores (including future ones)</label>` : ''}
        ${(S.snap.stores || []).filter((s) => mine.indexOf(s.StoreID) >= 0).map((s) => `<label class="check"><input type="checkbox" name="store" value="${esc(s.StoreID)}" ${userStores.indexOf(s.StoreID) >= 0 ? 'checked' : ''}> ${esc(s.Code + ' ' + s.Name)}</label>`).join('')}</div>
      <details><summary class="muted" style="cursor:pointer;margin-bottom:.4rem">Extra responsibilities (on top of the role)</summary>
        <div class="card" style="padding:.5rem .8rem;max-height:260px;overflow:auto">${grantable.map((p) => `<label class="check"><input type="checkbox" name="extra" value="${esc(p.code)}" ${extra.indexOf(p.code) >= 0 ? 'checked' : ''}> <span><b>${esc(p.code)}</b> <span class="muted small">${esc(p.description)}</span></span></label>`).join('')}</div></details>
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save user</button></form>`;
}

function adminDevices() {
  const devs = S.admin.devices || [];
  const allMine = S.session.user.StoreIDs === 'ALL' || S.session.role.Scope === 'ALL_STORES';
  const mine = allMine ? (S.snap.stores || []).map((s) => s.StoreID) : String(S.session.user.StoreIDs).split(',');
  return `<div class="card" style="margin-bottom:.8rem"><h3>Connect a new device</h3>
      <form data-form="setup-code" class="row"><select name="storeId" class="grow" style="max-width:320px">
        ${(S.snap.stores || []).filter((s) => s.Status === 'ACTIVE' && mine.indexOf(s.StoreID) >= 0).map((s) => `<option value="${esc(s.StoreID)}" ${s.StoreID === store().StoreID ? 'selected' : ''}>${esc(s.Code + ' ' + s.Name)}</option>`).join('')}
        ${allMine ? '<option value="HQ">Head office (owner / supervisor laptop)</option>' : ''}</select>
      <button class="btn primary" type="submit">Get setup code</button></form>
      ${S.ui.setupCode ? `<div class="setup-code" style="margin-top:.8rem">${esc(S.ui.setupCode.code)}</div><p class="muted small center">For ${esc(storeName(S.ui.setupCode.storeId))} · valid 24 hours · works once. Open the app on the new device and enter this code.</p>` : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Device</th><th>Store</th><th>Last sync</th><th>Status</th><th></th></tr></thead><tbody>
    ${devs.filter((d) => d.Status !== 'SAMPLE').map((d) => `<tr><td><b>${esc(d.DeviceName)}</b>${d.DeviceID === S.cfg.deviceId ? ' <span class="badge">this device</span>' : ''}</td><td>${esc(storeName(d.StoreID))}</td>
      <td class="small">${fmtDate(d.LastSyncAt)}</td><td><span class="badge ${d.Status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(d.Status)}</span></td>
      <td class="right">${d.DeviceID !== S.cfg.deviceId ? `<button class="btn sm ${d.Status === 'ACTIVE' ? 'danger' : ''}" data-act="device-status" data-id="${esc(d.DeviceID)}" data-s="${d.Status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE'}">${d.Status === 'ACTIVE' ? 'Block' : 'Unblock'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No devices yet</td></tr>'}
    </tbody></table></div>`;
}

function adminProducts() {
  const list = S.admin.products || [];
  const showCost = can('VIEW_COST_PROFIT');
  return `<div class="row between" style="margin-bottom:.6rem"><span class="muted">${list.length} product(s) in the shared catalog</span>
      ${can('PRODUCT_MANAGE') ? `<button class="btn primary" data-act="product-edit" data-id="">${icon('plus', 'sm')} New product</button>` : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Product</th><th>Category</th>${showCost ? '<th class="right">Cost</th>' : ''}<th class="right">Price</th><th class="right">Reorder</th><th></th></tr></thead><tbody>
    ${list.map((p) => `<tr><td><b>${esc(p.Name)}</b><div class="muted small">${esc(p.SKU || '')} · ${esc(p.Unit || '')}${p.Status !== 'ACTIVE' ? ' · ' + esc(p.Status) : ''}</div></td><td>${esc(p.Category)}</td>
      ${showCost ? `<td class="right num">${fmtCur(p.CostPrice, p.PriceCurrency)}</td>` : ''}<td class="right num">${fmtCur(p.SellingPrice, p.PriceCurrency)}</td><td class="right num">${fmtQty(p.ReorderLevel)}</td>
      <td class="right">${can('PRODUCT_MANAGE') ? `<button class="btn sm" data-act="product-edit" data-id="${esc(p.ProductID)}">Edit</button>` : ''}
        ${can('PRICE_MANAGE') && store().StoreID !== 'HQ' ? `<button class="btn sm ghost" data-act="store-price" data-id="${esc(p.ProductID)}">Price here</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function productForm(p) {
  p = p || { PriceCurrency: 'USD', Status: 'ACTIVE' };
  const cats = (S.snap.categories || []).filter((c) => c.Type === 'PRODUCT');
  return `<div class="modal-head"><h2>${p.ProductID ? 'Edit product' : 'New product'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="product" data-id="${esc(p.ProductID || '')}">
      <div class="field"><label>Name</label><input name="name" type="text" required value="${esc(p.Name || '')}"></div>
      <div class="grid2"><div class="field"><label>Category</label><select name="category">${cats.map((c) => `<option ${c.Name === p.Category ? 'selected' : ''}>${esc(c.Name)}</option>`).join('')}</select></div>
        <div class="field"><label>Unit (piece, yard, set…)</label><input name="unit" type="text" value="${esc(p.Unit || 'piece')}"></div></div>
      <div class="grid3"><div class="field"><label>Currency</label><select name="priceCurrency"><option ${p.PriceCurrency === 'USD' ? 'selected' : ''}>USD</option><option ${p.PriceCurrency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
        ${can('VIEW_COST_PROFIT') ? `<div class="field"><label>Cost price</label><input name="costPrice" type="number" step="any" value="${esc(p.CostPrice === undefined ? '' : p.CostPrice)}"></div>` : '<div></div>'}
        <div class="field"><label>Selling price</label><input name="sellingPrice" type="number" step="any" required value="${esc(p.SellingPrice || '')}"></div></div>
      <div class="grid3"><div class="field"><label>SKU</label><input name="sku" type="text" value="${esc(p.SKU || '')}"></div>
        <div class="field"><label>Barcode</label><input name="barcode" type="text" value="${esc(p.Barcode || '')}"></div>
        <div class="field"><label>Reorder level</label><input name="reorderLevel" type="number" step="any" value="${esc(p.ReorderLevel || '')}"></div></div>
      <div class="field"><label>Status</label><select name="status"><option ${p.Status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option><option ${p.Status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option></select></div>
      <button class="btn primary block" type="submit">Save product</button></form>`;
}

function storePriceForm(p) {
  const cur = productById(p.ProductID) || p;
  return `<div class="modal-head"><h2>Price at ${esc(store().Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <p><b>${esc(p.Name)}</b> — catalog price ${fmtCur(p.SellingPrice, p.PriceCurrency)}; here now ${fmtCur(cur.SellingPrice, cur.PriceCurrency)}</p>
    <form data-form="store-price" data-id="${esc(p.ProductID)}">
      <div class="grid2"><div class="field"><label>Currency</label><select name="priceCurrency"><option ${cur.PriceCurrency === 'USD' ? 'selected' : ''}>USD</option><option ${cur.PriceCurrency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
        <div class="field"><label>Price in this store (empty = catalog price)</label><input name="sellingPrice" type="number" step="any"></div></div>
      <label class="check"><input type="checkbox" name="sells" ${cur.Sells === false ? '' : 'checked'}> This store sells this product</label>
      <button class="btn primary block" style="margin-top:.8rem" type="submit">Save</button></form>`;
}

function adminSettings() {
  const list = S.admin.settings || [];
  return `<div class="card"><form data-form="settings">${list.filter((s) => s.Key !== 'GlobalRate' && !/^Feature/.test(s.Key) && s.Key !== 'ManagersCanChangeFeatures').map((s) => {
    const dis = bool(s.OwnerOnly) && !isOwner() ? 'disabled' : '';
    let input;
    if (typeof s.Value === 'boolean') input = `<label class="check"><input type="checkbox" name="${esc(s.Key)}" ${s.Value ? 'checked' : ''} ${dis}> ${s.Value ? 'On' : 'Off'}</label>`;
    else if (s.Key === 'RateMode') input = `<select name="RateMode" ${dis}><option value="OWNER_GLOBAL" ${s.Value === 'OWNER_GLOBAL' ? 'selected' : ''}>One rate for all stores (owner sets)</option><option value="PER_STORE" ${s.Value === 'PER_STORE' ? 'selected' : ''}>Each store sets its own rate</option></select>`;
    else if (s.Key === 'ThemeColor') input = colorPicker('ThemeColor', String(s.Value || ''));
    else if (s.Key === 'ReportingCurrency') input = `<select name="ReportingCurrency" ${dis}><option ${s.Value === 'USD' ? 'selected' : ''}>USD</option><option ${s.Value === 'LRD' ? 'selected' : ''}>LRD</option></select>`;
    else input = `<input name="${esc(s.Key)}" type="${typeof s.Value === 'number' ? 'number' : 'text'}" step="any" value="${esc(s.Value)}" ${dis}>`;
    return `<div class="field" style="border-bottom:1px solid var(--line);padding-bottom:.6rem"><div class="row between"><b>${esc(SETTING_LABELS[s.Key] || s.Key)}</b>${bool(s.OwnerOnly) ? '<span class="badge">owner only</span>' : ''}</div>
      <div class="muted small" style="margin:.2rem 0 .4rem">${esc(s.Description || '')}</div>${input}</div>`;
  }).join('')}<button class="btn primary block" type="submit">Save settings</button></form></div>`;
}

const SETTING_LABELS = {
  BusinessName: 'Business name', ThemeColor: 'Business colour', ReportingCurrency: 'Reporting currency', RateMode: 'Exchange rate mode',
  WarehouseEnabled: 'Use warehouses', ShopToShopTransfers: 'Shop-to-shop transfers', TransferApproval: 'Transfers need approval',
  ShopsBuyFromSuppliers: 'Shops can buy from suppliers', UpdateCostOnIntake: 'Update cost on each delivery',
  DiscountLimitPct: 'Discount limit (%)', AllowNegativeStock: 'Allow selling at zero stock', LowStockDefault: 'Default low-stock level',
  ReceiptFooterDefault: 'Default receipt footer', ShopURL: 'Online shop address (ShopURL)'
};

async function loadAdmin() {
  S.ui.adminLoading = true; render();
  try { S.admin = await adminCall('adminData', {}); }
  catch (e) { toast(e.message, 'bad'); }
  S.ui.adminLoading = false; render();
}

/* =====================================================================
 * Sync screen
 * ===================================================================== */
function viewSync() {
  const pend = S.queue.filter((q) => q.status === 'pending');
  const failed = S.queue.filter((q) => q.status === 'failed');
  return `<div class="page-head"><div><h2>Sync & device</h2><div class="sub">Connection, waiting records and appearance</div></div></div>${installCard(true)}
    <div class="kpis"><div class="kpi"><div class="k">Connection</div><div class="v small"><span class="status-dot ${navigator.onLine ? '' : 'off'}"></span>${navigator.onLine ? 'Online' : 'Offline'}</div></div>
      <div class="kpi"><div class="k">Waiting to sync</div><div class="v">${pend.length}</div></div>
      <div class="kpi"><div class="k">Last sync</div><div class="v small">${S.lastSync ? fmtDate(S.lastSync) : 'never'}</div></div></div>
    ${S.lastError ? `<div class="card" style="background:#f8e1de;margin-top:.8rem">Last error: ${esc(S.lastError)}</div>` : ''}
    <button class="btn primary big" style="margin:1rem 0" data-act="sync-now" ${S.syncing ? 'disabled' : ''}>${S.syncing ? 'Syncing…' : 'Sync now'}</button>
    ${failed.length ? `<h3>Rejected by the server</h3><div class="card table-wrap"><table><tbody>${failed.map((q) => `<tr><td>${fmtDate(q.createdAt)}</td><td><b>${esc(q.rec.type)}</b> ${esc(q.rec.receiptNo || '')}<div class="small" style="color:var(--bad)">${esc(q.error)}</div></td>
      <td class="right"><button class="btn sm" data-act="retry" data-id="${esc(q.rec.id)}">Retry</button> <button class="btn sm danger" data-act="discard" data-id="${esc(q.rec.id)}">Discard</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <h3 style="margin-top:1.2rem">Appearance</h3>
    <div class="tabs">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map((m) => `<button class="tab ${themeMode() === m[0] ? 'on' : ''}" data-act="theme-mode" data-m="${m[0]}">${m[1]}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:-.4rem">Store colour: <span class="store-dot" style="background:${esc(themeColor())}"></span>${esc(themeColor())}${can('STORE_MANAGE') ? ' — change it in Admin → Stores' : ''}</p>
    <h3 style="margin-top:1rem">This device</h3>
    <div class="card small"><div>Device: <b>${esc(S.cfg.deviceName)}</b> (${esc(S.cfg.deviceId)})</div><div>Store: <b>${esc(store().Name)}</b></div>
      <div>Server: <span class="muted">${esc(S.cfg.url)}</span></div><div>App version ${APP_VERSION}</div>
      <div style="margin-top:.6rem"><button class="btn sm danger" data-act="reset-device">Disconnect this device</button></div></div>`;
}

function themeMode() { try { return localStorage.getItem(lsKey('sm-mode')) || 'auto'; } catch (e) { return 'auto'; } }

/* =====================================================================
 * Modal helper
 * ===================================================================== */
let modalFn = null;
function showModal(fn, wide) {
  modalFn = fn;
  $('#modal-root').innerHTML = `<div class="overlay" data-act="overlay"><div class="modal ${wide ? 'wide' : ''}" id="modal">${fn()}</div></div>`;
}
function refreshModal() { if (modalFn && $('#modal')) $('#modal').innerHTML = modalFn(); }
function closeModal() { modalFn = null; co = null; $('#modal-root').innerHTML = ''; }

/* =====================================================================
 * Events
 * ===================================================================== */
const ACT = {
  go: (el) => { S.view = el.dataset.view; S.ui.showCart = false; if (S.view === 'contracts') { S.ui.conEdit = null; S.ui.conId = null; } render(); if (S.view === 'reports' && !reportCache) loadReport(); if (S.view === 'contracts' && !S.contracts && S.session.token) loadContracts(); },
  logout: () => { if (S.cart.lines.length && !confirm('Discard the current sale and log out?')) return; logout(); },
  'sync-now': () => sync(true),
  'pick-user': (el) => { loginUser = el.dataset.id || null; pinEntry = ''; render(); },
  pin: (el) => {
    const k = el.dataset.k;
    if (k === 'C') pinEntry = '';
    else if (k === '⏎') { if (pinEntry.length >= 4) { doLogin(); return; } }
    else if (pinEntry.length < 8) pinEntry += k;
    render();
  },
  'reset-device': async () => {
    const pend = S.queue.filter((q) => q.status === 'pending').length;
    if (pend && !confirm(pend + ' record(s) have NOT been synced and will be lost. Continue?')) return;
    if (!confirm('Disconnect this device? You will need a new setup code.')) return;
    await Promise.all(['cfg', 'snap', 'queue', 'journal', 'session', 'misc'].map(KV.del));
    location.reload();
  },
  cat: (el) => { S.ui.cat = el.dataset.cat; render(); },
  add: (el) => addToCart(el.dataset.id),
  qty: (el) => {
    const l = S.cart.lines[+el.dataset.i];
    const nq = r2(l.qty + (+el.dataset.d) * l.step);
    if (+el.dataset.d > 0 && !stockOk(l, nq)) return;
    if (nq <= 0) S.cart.lines.splice(+el.dataset.i, 1); else l.qty = nq;
    render();
  },
  remove: (el) => { S.cart.lines.splice(+el.dataset.i, 1); render(); },
  'clear-cart': () => { S.cart = { lines: [], discountUSD: 0, customerId: '' }; render(); },
  'show-cart': () => {
    S.ui.showCart = true; S.ui.sheetAnim = true; render();
    try { if (!GAS) history.pushState({ sheet: 'cart' }, ''); } catch (e) { /* ignore */ }
  },
  'hide-cart': () => {
    try { if (!GAS && history.state && history.state.sheet === 'cart') { history.back(); return; } } catch (e) { /* ignore */ }
    S.ui.showCart = false; render();
  },
  discount: () => {
    const t = cartTotals();
    const lim = num(setting('DiscountLimitPct'));
    const v = prompt('Discount — enter a % (e.g. 5%) or an amount in USD (e.g. 2.50)' + (can('POS_DISCOUNT_UNLIMITED') ? '' : '\nMaximum ' + lim + '%'), '');
    if (v === null) return;
    let usd = /%$/.test(v.trim()) ? t.sub * num(v.replace('%', '')) / 100 : num(v);
    if (!can('POS_DISCOUNT_UNLIMITED') && usd > t.sub * lim / 100 + 0.001) { toast('Discount above ' + lim + '% needs a manager', 'bad'); return; }
    S.cart.discountUSD = r2(Math.max(0, usd));
    render();
  },
  'pick-customer': () => { S.ui.custQ = ''; showModal(customerPicker); },
  'back-checkout': () => { if (co) showModal(checkoutModal); else closeModal(); },
  'set-customer': (el) => { S.cart.customerId = el.dataset.id; if (co) showModal(checkoutModal); else { closeModal(); } render(); },
  'new-customer': () => showModal(() => customerForm()),
  'edit-customer': (el) => showModal(() => customerForm(customers().find((c) => c.CustomerID === el.dataset.id))),
  checkout: () => openCheckout(),
  'co-method': (el) => { co.method = el.dataset.m; refreshModal(); },
  'co-quick': (el) => { const i = $('#co-amt'); const cur = num(i.value); i.value = co._quicked ? cur + num(el.dataset.v) : num(el.dataset.v); co._quicked = true; const lv = $('#co-live'); if (lv) lv.innerHTML = coLive(i.value); },
  'co-add': () => {
    const m = METHODS.find((x) => x[0] === co.method);
    const amt = num($('#co-amt').value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    co.tenders.push({ method: m[0], currency: m[2], amount: amt, reference: $('#co-ref') ? $('#co-ref').value.trim() : '' });
    co._quicked = false;
    refreshModal();
  },
  'co-del': (el) => { co.tenders.splice(+el.dataset.i, 1); refreshModal(); },
  'co-change': (el) => { co.changeCurrency = el.dataset.c; co._chgSet = true; refreshModal(); },
  'co-finish': () => {
    // one tap: if nothing was added yet, the amount typed counts as the payment
    const amtEl = $('#co-amt');
    if (amtEl && coPaid().remainUSD > 0.005) {
      const m = METHODS.find((x) => x[0] === co.method);
      const amt = num(amtEl.value);
      const usd = m[2] === 'USD' ? amt : amt / rate();
      if (!(amt > 0)) { toast('Enter the amount received', 'bad'); return; }
      if (usd + 0.005 < coPaid().remainUSD) { toast('Not enough — add it as a part payment, then take the rest', 'bad'); return; }
      co.tenders.push({ method: m[0], currency: m[2], amount: amt, reference: $('#co-ref') ? $('#co-ref').value.trim() : '' });
      if (m[2] === 'USD' && usd - coPaid().remainUSD > 0.004 && !co._chgSet) co.changeCurrency = 'LRD';
    }
    finishSale();
  },
  close: () => closeModal(),
  overlay: (el, e) => { if (e.target === el && !co) closeModal(); },
  print: (el) => {
    const r = S.journal.find((x) => x.id === el.dataset.id);
    printDoc(saleDoc(r), setting('ReceiptPaper') || '80mm');
  },
  'toggle-low': () => { S.ui.stockLow = !S.ui.stockLow; render(); },
  intake: () => { lines = [{ productId: (S.snap.products[0] || {}).ProductID, qty: '', unitCost: '' }]; showModal(intakeModal, true); },
  adjust: () => { lines = [{ productId: (S.snap.products[0] || {}).ProductID, qty: '' }]; showModal(adjustModal); },
  'line-add': () => { lines.push({ productId: (S.snap.products[0] || {}).ProductID, qty: '', unitCost: '' }); refreshModal(); },
  'line-del': (el) => { lines.splice(+el.dataset.i, 1); refreshModal(); },
  'transfer-new': (el) => { lines = [{ productId: (S.snap.products[0] || {}).ProductID, qty: '' }]; showModal(() => transferModal(el.dataset.mode)); },
  'transfer-act': (el) => {
    const t = transfers().find((x) => x.TransferID === el.dataset.id);
    const a = el.dataset.a;
    if (a === 'DISPATCH' || a === 'RECEIVE') { showModal(() => transferQtyModal(t, a)); return; }
    if (a === 'CANCEL' && !confirm('Cancel this transfer?')) return;
    enqueue('transferAction', { transferId: t.TransferID, action: a });
    toast(a === 'APPROVE' ? 'Approved' : 'Cancelled', 'ok');
    render();
  },
  'money-tab': (el) => { S.ui.moneyTab = el.dataset.t; render(); },
  collect: (el) => showModal(() => collectModal(customers().find((c) => c.CustomerID === el.dataset.id))),
  'rep-period': (el) => { S.ui.reportPeriod = el.dataset.p; reportCache = null; loadReport(); },
  'rep-load': () => loadReport(),
  'admin-tab': (el) => { S.ui.adminTab = el.dataset.t; S.ui.setupCode = null; render(); if (el.dataset.t === 'shop' && S.session.token && (!S.shopAdmin || S.shopAdmin.store.StoreID !== shopStoreId())) { loadShopAdmin(); return; } if (['users', 'devices', 'products', 'settings'].indexOf(el.dataset.t) >= 0 && !S.admin && S.session.token) loadAdmin(); },
  'admin-load': () => loadAdmin(),
  'store-new': () => showModal(storeForm),
  'order-tab': (el) => { S.ui.orderTab = el.dataset.t; render(); },
  'order-status': (el) => {
    const o = orders().find((x) => x.OrderID === el.dataset.id);
    const s = el.dataset.s;
    if (s === 'CANCELLED' && !confirm('Cancel order ' + o.OrderNo + '?')) return;
    enqueue('orderStatus', { orderId: o.OrderID, status: s });
    toast(o.OrderNo + ': ' + s.toLowerCase(), 'ok'); render();
  },
  'order-ring': (el) => ringUpOrder(orders().find((x) => x.OrderID === el.dataset.id)),
  'shop-load': () => loadShopAdmin(),
  'copy-link': () => { const i = $('#shop-link'); i.select(); try { navigator.clipboard.writeText(i.value); } catch (e) { document.execCommand('copy'); } toast('Link copied', 'ok'); },
  'opt-edit': (el) => showModal(() => optForm(el.dataset.id ? S.shopAdmin.options.find((o) => o.OptionID === el.dataset.id) : null, el.dataset.type)),
  'desc-edit': (el) => showModal(() => descForm(S.shopAdmin.products.find((p) => p.ProductID === el.dataset.id))),
  'online-toggle': async (el) => {
    const p = S.shopAdmin.products.find((x) => x.ProductID === el.dataset.id);
    try { await adminCall('upsertProduct', { productId: p.ProductID, showOnline: el.checked }); p.ShowOnline = el.checked; toast(el.checked ? 'Shown in the shop' : 'Hidden from the shop', 'ok'); }
    catch (e) { el.checked = !el.checked; toast(e.message, 'bad'); }
  },
  'photo-pick': (el) => { S.ui.photoFor = el.dataset.id; const f = $('#photo-file'); f.value = ''; f.click(); },
  'banner-edit': (el) => showModal(() => bannerForm(el.dataset.id ? S.shopAdmin.banners.find((b) => b.BannerID === el.dataset.id) : null)),
  'banner-del': async (el) => {
    if (!confirm('Delete this banner?')) return;
    try { await adminCall('deleteBanner', { bannerId: el.dataset.id }); S.shopAdmin = await adminCall('shopData', { storeId: S.shopAdmin.store.StoreID }); closeModal(); toast('Banner deleted', 'ok'); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'logo-clear': async () => {
    try { const r = await adminCall('updateBrand', { logo: '' }); S.shopAdmin.brand = r.brand; toast('Logo removed', 'ok'); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'store-color': (el) => showModal(() => storeColorModal((S.snap.stores || []).find((x) => x.StoreID === el.dataset.id))),
  'pick-color': (el) => setPickerColor(el.closest('[data-picker]'), el.dataset.c),
  'clear-store-color': async (el) => {
    try { await adminCall('updateStore', { storeId: el.dataset.id, color: '' }); closeModal(); toast('Store now uses the business colour', 'ok'); await sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'theme-mode': (el) => { try { localStorage.setItem(lsKey('sm-mode'), el.dataset.m); } catch (e) { /* ignore */ } render(); },
  'store-close': async (el) => {
    const reason = prompt('Close ' + storeName(el.dataset.id) + '? Its devices will be blocked; history stays. Reason:');
    if (reason === null) return;
    try {
      let r = await adminCall('closeStore', { storeId: el.dataset.id, reason });
      if (!r.closed && confirm(r.message + '\n\nClose anyway?')) r = await adminCall('closeStore', { storeId: el.dataset.id, reason, force: true });
      if (r.closed) { toast('Store closed', 'ok'); await sync(false); }
    } catch (e) { toast(e.message, 'bad'); }
  },
  'store-reopen': async (el) => { try { await adminCall('reopenStore', { storeId: el.dataset.id }); toast('Store reopened', 'ok'); await sync(false); } catch (e) { toast(e.message, 'bad'); } },
  'user-edit': (el) => showModal(() => userForm((S.admin.users || []).find((u) => u.UserID === el.dataset.id)), true),
  'device-status': async (el) => {
    try { await adminCall('setDeviceStatus', { deviceId: el.dataset.id, status: el.dataset.s }); S.admin = await adminCall('adminData', {}); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'product-edit': (el) => showModal(() => productForm((S.admin.products || []).find((p) => p.ProductID === el.dataset.id)), true),
  'store-price': (el) => showModal(() => storePriceForm((S.admin.products || []).find((p) => p.ProductID === el.dataset.id))),
  retry: (el) => { const q = S.queue.find((x) => x.rec.id === el.dataset.id); q.status = 'pending'; q.error = ''; persist.queue(); sync(true); },
  discard: (el) => { if (!confirm('Discard this record? It will not reach the server.')) return; S.queue = S.queue.filter((x) => x.rec.id !== el.dataset.id); persist.queue(); render(); }
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); fn(el, e); }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const k = el.dataset && el.dataset.input;
  if (!k) return;
  if (k === 'pos-search') { S.ui.q = el.value; $('#pos-grid').innerHTML = posGrid(); }
  if (k === 'stock-q') { S.ui.stockQ = el.value; const pos = el.selectionStart; render(); const n = $('#stock-q'); n.focus(); n.setSelectionRange(pos, pos); }
  if (k === 'cust-q') { S.ui.custQ = el.value; refreshModal(); const n = $('#cust-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  if (k === 'custlist-q') { S.ui.custListQ = el.value; render(); }
  if (k === 'm-q') { S.ui.mQ = el.value; render(); }
  if (k === 'm-type') { S.ui.mType = el.value; render(); }
  if (k === 'm-cat') { S.ui.mCat = el.value; render(); }
  if (k === 'con-q') { S.ui.conQ = el.value; const pos = el.selectionStart; render(); const n = $('#con-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
  if (k === 'con-recalc') {
    const e = readConForm();
    const sub = e.items.reduce((s, l) => s + num(l.qty) * num(l.price), 0); const tot = Math.max(0, sub - num(e.discount));
    $$('.conl-t').forEach((b, i) => { b.textContent = fmtCur(num(e.items[i].qty) * num(e.items[i].price), e.currency); });
    const sm = $('#con-sum'); if (sm) sm.innerHTML = `<div><span>Subtotal</span><span class="num">${fmtCur(sub, e.currency)}</span></div><div><b>Total</b><b class="num">${fmtCur(tot, e.currency)}</b></div><div class="muted"><span>Deposit</span><span class="num">${fmtCur(tot * num(e.depositPct) / 100, e.currency)}</span></div>`;
  }
  if (k === 'con-cust') {
    const c = customers().find((x) => x.Name.toLowerCase() === el.value.trim().toLowerCase()); const f = el.form;
    if (c && f) { if (!f.customerPhone.value) f.customerPhone.value = c.Phone || ''; if (!f.customerEmail.value) f.customerEmail.value = c.Email || ''; if (!f.customerAddress.value) f.customerAddress.value = c.Address || ''; }
  }
  if (k === 'shop-q') { S.ui.shopQ = el.value; const pos = el.selectionStart; render(); const n = $('#shop-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
  if (k === 'line') { lines[+el.dataset.i][el.dataset.f] = el.value; }
  if (k === 'co-amt') { const lv = $('#co-live'); if (lv) lv.innerHTML = coLive(el.value); }
  if (k === 'color-custom') setPickerColor(el.closest('[data-picker]'), el.value);
  if (k === 'color-hex') { let v = el.value.trim(); if (v && v[0] !== '#') v = '#' + v; if (/^#[0-9a-f]{6}$/i.test(v)) setPickerColor(el.closest('[data-picker]'), v); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const k = el.dataset && el.dataset.input;
  if (k === 'qty') {
    const l = S.cart.lines[+el.dataset.i];
    let v = r2(el.value);
    if (v > l.qty && !stockOk(l, v)) v = Math.max(l.qty, Math.floor(stockLeft(l) / l.step) * l.step);
    if (v <= 0) S.cart.lines.splice(+el.dataset.i, 1); else l.qty = v;
    render();
  }
  if (k === 'co-amt') { const lv = $('#co-live'); if (lv) lv.innerHTML = coLive(el.value); }
  if (k === 'color-custom') setPickerColor(el.closest('[data-picker]'), el.value);
  if (k === 'color-hex') { let v = el.value.trim(); if (v && v[0] !== '#') v = '#' + v; if (/^#[0-9a-f]{6}$/i.test(v)) setPickerColor(el.closest('[data-picker]'), v); }
  if (el.id === 'photo-file' && el.files && el.files[0]) {
    const target = String(S.ui.photoFor || '');
    const more = target.indexOf('more:') === 0 ? target.slice(5) : '';
    const pid = target === 'logo' || target === 'banner' || more ? '' : target;
    toast('Uploading photo…');
    resizeImage(el.files[0], target === 'banner' ? 1600 : target === 'logo' ? 800 : 900)
      .then((dataUrl) => adminCall('uploadImage', { productId: pid, dataUrl, name: target === 'logo' ? 'logo' : target === 'banner' ? 'banner' : ((productById(pid || more) || {}).Name || 'photo') }))
      .then(async (r) => {
        if (target === 'logo') { const b = await adminCall('updateBrand', { logo: r.url }); S.shopAdmin.brand = b.brand; render(); }
        else if (target === 'banner') { const i = $('.modal [name=imageUrl]'); if (i) i.value = r.url; }
        else if (more) { const t = $('.modal [name=moreImages]'); if (t) t.value = (t.value.trim() ? t.value.trim() + '\n' : '') + r.url; }
        else { const p = S.shopAdmin.products.find((x) => x.ProductID === pid); if (p) p.ImageURL = r.url; render(); }
        toast(more ? 'Photo added — press Save' : target === 'banner' ? 'Photo added — press Save' : 'Photo saved', 'ok');
      })
      .catch((e) => toast(e.message, 'bad'));
  }
  if (k === 'shop-store') { S.ui.shopStore = el.value; S.shopAdmin = null; loadShopAdmin(); }
  if (k === 'rep-store') { S.ui.reportStore = el.value; reportCache = null; loadReport(); }
  if (k === 'line') { lines[+el.dataset.i][el.dataset.f] = el.value; }
});

document.addEventListener('keydown', (e) => {
  if (!S.session && loginUser && /^[0-9]$/.test(e.key)) { if (pinEntry.length < 8) pinEntry += e.key; render(); }
  else if (!S.session && loginUser && e.key === 'Enter' && pinEntry.length >= 4) doLogin();
  else if (!S.session && loginUser && e.key === 'Backspace') { pinEntry = pinEntry.slice(0, -1); render(); }
});

const FORMS = {
  register: async (f) => {
    const url = GAS ? 'apps-script' : f.url.value.trim();
    try { localStorage.setItem(lsKey('sm-url'), url); } catch (e) { /* storage may be blocked */ }
    try {
      const r = await api('registerDevice', { setupCode: f.code.value.trim().toUpperCase(), deviceName: f.name.value.trim() }, { url });
      S.cfg = { url, deviceId: r.deviceId, deviceKey: r.deviceKey, deviceName: f.name.value.trim() };
      await KV.set('cfg', S.cfg);
      S.snap = await api('pull');
      await persist.snap();
      toast('Device connected to ' + r.store.Name, 'ok');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  },
  customer: (f) => {
    const id = f.dataset.id;
    const data = { name: f.name.value.trim(), phone: f.phone.value.trim(), notes: f.notes.value.trim(), email: f.email.value.trim() };
    if (can('CUSTOMER_MANAGE') && f.limit.value !== '') data.creditLimitUSD = num(f.limit.value);
    if (id) { data.customerId = id; enqueue('customer', data); }
    else { const rec = enqueue('customer', data); if (modalFn === customerPicker || co || S.view === 'pos') S.cart.customerId = rec.id; }
    toast('Customer saved', 'ok');
    if (co) showModal(checkoutModal); else closeModal();
    render();
  },
  intake: (f) => {
    const items = lines.filter((l) => l.productId && num(l.qty) > 0).map((l) => ({ productId: l.productId, qty: num(l.qty), unitCost: num(l.unitCost) }));
    if (!items.length) { toast('Add at least one item with a quantity', 'bad'); return; }
    enqueue('stockIntake', { supplierId: f.supplierId.value || undefined, invoiceNo: f.invoiceNo.value.trim(), currency: f.currency.value, items, paidAmount: num(f.paid.value) });
    closeModal(); toast('Stock received', 'ok'); render();
  },
  adjust: (f) => {
    const items = lines.filter((l) => l.productId && num(l.qty) !== 0).map((l) => ({ productId: l.productId, qty: num(l.qty) }));
    if (!items.length) { toast('Enter a quantity change', 'bad'); return; }
    enqueue('stockAdjust', { reason: f.reason.value, items });
    closeModal(); toast('Adjustment saved', 'ok'); render();
  },
  transfer: (f) => {
    const mode = f.dataset.mode;
    const items = lines.filter((l) => l.productId && num(l.qty) > 0).map((l) => ({ productId: l.productId, qty: num(l.qty) }));
    if (!items.length) { toast('Add at least one item', 'bad'); return; }
    if (mode === 'SEND') {
      const stock = stockMap();
      const short = items.find((i) => num(i.qty) > (stock[i.productId] || 0));
      if (short && !confirm('You are sending more ' + productById(short.productId).Name + ' than the system shows in stock. Continue?')) return;
    }
    const me = store().StoreID;
    enqueue('transfer', { mode, fromStoreId: mode === 'SEND' ? me : f.other.value, toStoreId: mode === 'SEND' ? f.other.value : me, items, note: f.note.value.trim() });
    closeModal(); toast(mode === 'SEND' ? 'Stock sent' : 'Request sent', 'ok'); render();
  },
  'transfer-qty': (f) => {
    const t = transfers().find((x) => x.TransferID === f.dataset.id);
    const items = t.items.map((i) => ({ productId: i.ProductID, qty: num(f['q-' + i.ProductID].value) }));
    const rec = enqueue('transferAction', { transferId: t.TransferID, action: f.dataset.a, items });
    rec._items = items; // used for the local stock view until the next pull
    const q = S.queue.find((x) => x.rec.id === rec.id); if (q) q.rec._items = items;
    persist.queue();
    closeModal(); toast(f.dataset.a === 'DISPATCH' ? 'Dispatched' : 'Received', 'ok'); render();
  },
  money: (f) => {
    const t = f.dataset.t;
    const amt = num(f.amount.value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    const data = { category: f.category.value, description: f.description.value.trim(), currency: f.currency.value, amount: amt };
    if (t === 'expense') data.paidTo = f.party.value.trim(); else data.receivedFrom = f.party.value.trim();
    enqueue(t, data);
    toast((t === 'expense' ? 'Expense' : 'Income') + ' saved', 'ok');
    if (modalFn === moneyNewModal) closeModal();
    render();
  },
  collect: (f) => {
    const amt = num(f.amount.value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    let currency = f.currency.value;
    if (f.method.value === 'USD_CASH') currency = 'USD';
    if (f.method.value === 'LRD_CASH') currency = 'LRD';
    enqueue('customerPayment', { customerId: f.dataset.id, method: f.method.value, currency, amount: amt });
    closeModal(); toast('Payment recorded', 'ok'); render();
  },
  'shift-open': (f) => {
    const rec = enqueue('shift', { action: 'OPEN', cashUSD: num(f.usd.value), cashLRD: num(f.lrd.value) });
    S.shift = { shiftId: rec.id, openedAt: rec.timestamp, userId: rec.userId, openingUSD: num(f.usd.value), openingLRD: num(f.lrd.value) };
    persist.misc(); render();
  },
  'shift-close': (f) => {
    const e = shiftExpected();
    const cu = num(f.usd.value), cl = num(f.lrd.value);
    enqueue('shift', { action: 'CLOSE', shiftId: S.shift.shiftId, cashUSD: cu, cashLRD: cl,
      note: (f.note.value.trim() ? f.note.value.trim() + ' | ' : '') + 'expected USD ' + r2(e.usd) + ', LRD ' + Math.round(e.lrd) });
    alert('Shift closed.\n\nUSD: counted ' + fmtUSD(cu) + ', expected ' + fmtUSD(e.usd) + ' → difference ' + fmtUSD(cu - e.usd) +
      '\nLRD: counted ' + fmtLRD(cl) + ', expected ' + fmtLRD(e.lrd) + ' → difference ' + fmtLRD(cl - e.lrd));
    S.shift = null; persist.misc(); render();
  },
  rate: async (f) => {
    try {
      const body = { rate: num(f.rate.value) };
      if (f.dataset.scope === 'store') body.storeId = store().StoreID;
      await adminCall('setRate', body);
      toast('Rate updated', 'ok');
      await sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  store: async (f) => {
    try {
      const body = { name: f.name.value.trim(), type: f.type.value, address: f.address.value.trim(), phone: f.phone.value.trim() };
      const col = f.querySelector('input[name=color]'); if (col && col.value) body.color = col.value;
      if (f.rate && f.rate.value) body.rate = num(f.rate.value);
      const r = await adminCall('createStore', body);
      closeModal(); toast('Created ' + r.store.Code + ' ' + r.store.Name, 'ok');
      await sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  user: async (f) => {
    const body = { fullName: f.fullName.value.trim(), username: f.username.value.trim().toLowerCase(), roleId: f.roleId.value, phone: f.phone.value.trim(), status: f.status.value };
    if (f.dataset.id) body.userId = f.dataset.id;
    if (f.pin.value) body.pin = f.pin.value;
    body.storeIds = f.allStores && f.allStores.checked ? 'ALL' : Array.from(f.querySelectorAll('input[name=store]:checked')).map((x) => x.value);
    body.extraPermissions = Array.from(f.querySelectorAll('input[name=extra]:checked')).map((x) => x.value);
    try {
      await adminCall('upsertUser', body);
      S.admin = await adminCall('adminData', {});
      closeModal(); toast('User saved', 'ok'); render(); sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  'setup-code': async (f) => {
    try { const r = await adminCall('createSetupCode', { storeId: f.storeId.value }); S.ui.setupCode = { code: r.setupCode, storeId: r.storeId }; render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  product: async (f) => {
    const body = { name: f.name.value.trim(), category: f.category.value, unit: f.unit.value.trim(), priceCurrency: f.priceCurrency.value,
      sellingPrice: num(f.sellingPrice.value), sku: f.sku.value.trim(), barcode: f.barcode.value.trim(), reorderLevel: num(f.reorderLevel.value), status: f.status.value };
    if (f.costPrice && f.costPrice.value !== '') body.costPrice = num(f.costPrice.value);
    if (f.dataset.id) body.productId = f.dataset.id;
    try { await adminCall('upsertProduct', body); S.admin = await adminCall('adminData', {}); closeModal(); toast('Product saved', 'ok'); render(); sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'shop-settings': async (f) => {
    try {
      const r = await adminCall('updateShop', { storeId: S.shopAdmin.store.StoreID, onlineShop: f.onlineShop.checked, whatsapp: f.whatsapp.value.trim(),
        shopMessage: f.shopMessage.value.trim(), address: f.address.value.trim(), hours: f.hours.value.trim() });
      S.shopAdmin.store = r.store; toast('Online shop saved', 'ok'); render(); sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  opt: async (f) => {
    const body = { storeId: S.shopAdmin.store.StoreID, type: f.dataset.type, name: f.name.value.trim(), details: f.details.value.trim(), active: f.active.checked };
    if (f.dataset.id) body.optionId = f.dataset.id;
    if (f.fee) { body.fee = num(f.fee.value); body.currency = f.currency.value; }
    try { await adminCall('upsertOnlineOption', body); S.shopAdmin = await adminCall('shopData', { storeId: S.shopAdmin.store.StoreID }); closeModal(); toast('Saved', 'ok'); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  desc: async (f) => {
    const p = S.shopAdmin.products.find((x) => x.ProductID === f.dataset.id);
    const body = { productId: p.ProductID, description: f.description.value.trim(), imageUrl: f.imageUrl.value.trim(),
      moreImages: f.moreImages.value, onlineTag: f.onlineTag.value, personalise: f.personalise.checked, leadDays: f.leadDays.value === '' ? '' : num(f.leadDays.value) };
    if (f.salePrice) {
      body.salePrice = f.salePrice.value === '' ? '' : num(f.salePrice.value);
      if (body.salePrice !== '' && body.salePrice >= num(p.SellingPrice)) { toast('The sale price must be lower than the normal price', 'bad'); return; }
    }
    try {
      await adminCall('upsertProduct', body);
      S.shopAdmin = await adminCall('shopData', { storeId: S.shopAdmin.store.StoreID }); closeModal(); toast('Saved', 'ok'); render();
      if (body.salePrice !== undefined) sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  brand: async (f) => {
    try {
      const r = await adminCall('updateBrand', { tagline: f.tagline.value.trim(), announcement: f.announcement.value.trim(),
        facebook: f.facebook.value.trim(), instagram: f.instagram.value.trim(), tiktok: f.tiktok.value.trim() });
      S.shopAdmin.brand = r.brand; toast('Shop look saved', 'ok'); render();
    } catch (e) { toast(e.message, 'bad'); }
  },
  banner: async (f) => {
    const body = { title: f.title.value.trim(), text: f.text.value.trim(), buttonText: f.buttonText.value.trim(), link: f.link.value,
      imageUrl: f.imageUrl.value.trim(), sortOrder: f.sortOrder.value, active: f.active.checked, storeId: f.allShops.checked ? '' : S.shopAdmin.store.StoreID };
    if (f.dataset.id) body.bannerId = f.dataset.id;
    try { await adminCall('upsertBanner', body); S.shopAdmin = await adminCall('shopData', { storeId: S.shopAdmin.store.StoreID }); closeModal(); toast('Banner saved', 'ok'); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'store-color': async (f) => {
    const c = f.querySelector('input[name=color]').value;
    if (!c) { toast('Pick a colour', 'bad'); return; }
    try { await adminCall('updateStore', { storeId: f.dataset.id, color: c }); closeModal(); toast('Colour saved', 'ok'); await sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'store-price': async (f) => {
    const body = { storeId: store().StoreID, productId: f.dataset.id, sells: f.sells.checked, priceCurrency: f.priceCurrency.value };
    if (f.sellingPrice.value !== '') body.sellingPrice = num(f.sellingPrice.value);
    try { await adminCall('setStorePrice', body); closeModal(); toast('Store price saved', 'ok'); sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  settings: async (f) => {
    const changes = {};
    (S.admin.settings || []).forEach((s) => {
      const el = f.querySelector('[name="' + s.Key + '"]');
      if (!el || el.disabled) return;
      const v = el.type === 'checkbox' ? el.checked : (typeof s.Value === 'number' ? num(el.value) : el.value);
      if (v !== s.Value) changes[s.Key] = v;
    });
    if (!Object.keys(changes).length) { toast('Nothing changed'); return; }
    try { const r = await adminCall('updateSettings', { settings: changes }); S.admin.settings = r.settings.map((x) => Object.assign({}, (S.admin.settings || []).find((y) => y.Key === x.Key), x)); toast('Settings saved', 'ok'); await sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  }
};

document.addEventListener('submit', (e) => {
  const f = e.target;
  const k = f.dataset && f.dataset.form;
  if (!k || !FORMS[k]) return;
  e.preventDefault();
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  Promise.resolve(FORMS[k](f)).finally(() => { if (btn && document.body.contains(btn)) btn.disabled = false; });
});


/* =====================================================================
 * Documents: receipts, quotations, invoices, payment receipts
 * One renderer for screen preview, printing (A4 or 58/80 mm slip), PDF and e-mail.
 * ===================================================================== */
ICONS.file = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>';
ICONS.mail = '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>';
ICONS.share = '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>';
ICONS.download = '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>';
ICONS.receipt = '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"/>';

const PAPERS = [['A4', 'A4 page'], ['80mm', '80 mm slip'], ['58mm', '58 mm slip']];
const PAY_LABEL = { USD_CASH: 'USD cash', LRD_CASH: 'LRD cash', MOMO_MTN: 'MTN MoMo', MOMO_ORANGE: 'Orange Money', CREDIT: 'On credit', BANK: 'Bank transfer' };
const fmtDay = (d) => { const x = new Date(d); return isNaN(x) ? '' : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const storeById = (id) => (S.snap.stores || []).find((x) => x.StoreID === id) || store();

function docBrand(storeId) {
  const st = storeById(storeId || store().StoreID);
  return { biz: setting('BusinessName') || st.Name, logo: setting('ShopLogoURL') || '', tagline: setting('ShopTagline') || '',
    color: /^#[0-9a-f]{6}$/i.test(st.Color || '') ? st.Color : (setting('ThemeColor') || '#0F766E'),
    store: st.Name, address: st.Address || '', phone: st.Phone || '', whatsapp: st.WhatsApp ? '+' + st.WhatsApp : '' };
}

const DOC_CSS = (c) => `
.sdoc{font-family:Arial,Helvetica,sans-serif;color:#222;font-size:12px;line-height:1.45;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sdoc *{box-sizing:border-box}
.sdoc table{border-collapse:collapse;width:100%}
.sdoc td,.sdoc th{border:0;background:none}
.sdoc.a4{width:100%;max-width:720px;margin:0 auto;padding:0}
.sdoc.a4 table{table-layout:fixed}
.sdoc.a4 td,.sdoc.a4 th{word-wrap:break-word;overflow-wrap:anywhere}
.docprev .sdoc.a4{padding:18px 16px}
.sdoc .hd td{vertical-align:top}
.sdoc .logo{max-height:64px;max-width:240px;display:block;margin-bottom:6px}
.sdoc .biz{font-size:19px;font-weight:bold;color:${c}}
.sdoc .muted{color:#666}
.sdoc .kind{font-size:24px;font-weight:bold;color:${c};text-align:right;letter-spacing:1px}
.sdoc .meta{margin-left:auto;width:100%}
.sdoc .meta td{padding:2px 0 2px 8px;text-align:right}
.sdoc .meta td.k{color:#666}
.sdoc .bar{height:4px;background:${c};margin:16px 0 14px}
.sdoc .to td{vertical-align:top;padding-bottom:12px}
.sdoc .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:3px}
.sdoc .job{font-size:15px;font-weight:bold;margin:2px 0 12px}
.sdoc .items th{background:${c};color:#fff;text-align:left;padding:7px 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px}
.sdoc .items td{padding:7px 6px;border-bottom:1px solid #e6e6e6;vertical-align:top}
.sdoc .num{text-align:right}
.sdoc .items th.num{text-align:right}
.sdoc .tot{width:55%;margin:12px 0 0 45%}
.sdoc .tot td{padding:4px 6px}
.sdoc .tot td.num{width:48%}
.sdoc .tot tr.big td{font-size:15px;font-weight:bold;border-top:2px solid #222;padding-top:8px}
.sdoc .tot tr.hl td{color:${c};font-weight:bold}
.sdoc .box{background:#f5f5f5;padding:10px 12px;border-radius:6px;margin-top:14px;white-space:pre-line}
.sdoc .stamp{border:3px solid #15803d;color:#15803d;font-weight:bold;font-size:20px;padding:3px 14px;display:inline-block;transform:rotate(-8deg);letter-spacing:2px}
.sdoc .stamp.bad{border-color:#b91c1c;color:#b91c1c}
.sdoc .foot{text-align:center;color:#666;margin-top:26px;font-size:11px;border-top:1px solid #eee;padding-top:10px}
.sdoc.slip{font-family:"Courier New",ui-monospace,Menlo,monospace;font-size:12px;margin:0 auto;padding:6px 2px;color:#000}
.sdoc.w80{width:72mm}.sdoc.w58{width:50mm;font-size:10.5px}
.sdoc.slip .c{text-align:center}
.sdoc.slip .logo{max-height:46px;max-width:90%;margin:0 auto 4px}
.sdoc.slip hr{border:0;border-top:1px dashed #555;margin:6px 0}
.sdoc.slip .l td{padding:1px 0;vertical-align:top}
.sdoc.slip .b{font-weight:bold}
.sdoc.slip .big{font-size:1.15em;font-weight:bold}
`;

/* ---------- document models ---------- */
const isVoid = (r) => r && (r.status === 'VOID' || r.status === 'VOIDED');
function saleDoc(r) {
  const rt = num(r.rate) || rate();
  let sub = 0;
  const lines = (r.items || []).map((i, k) => {
    const p = productById(i.productId) || {};
    sub += toUSDAt(i.unitPrice * i.qty, i.priceCurrency, rt);
    return { desc: i.name || (r._names && r._names[k]) || p.Name || i.productId, qty: i.qty, unit: p.Unit || '', price: i.unitPrice, cur: i.priceCurrency, total: i.unitPrice * i.qty };
  });
  const total = sub - num(r.discountUSD);
  const paid = (r.payments || []).reduce((s, p) => s + toUSDAt(p.amount, p.currency, rt), 0);
  const changeUSD = Math.max(0, paid - total);
  const cust = r.customerName ? { name: r.customerName, phone: r.customerPhone, email: r.customerEmail }
    : (r.customerId ? (() => { const c = customers().find((x) => x.CustomerID === r.customerId); return c ? { name: c.Name, phone: c.Phone, email: c.Email } : null; })() : null);
  const st = storeById(r.storeId || store().StoreID);
  const totals = [];
  if (num(r.discountUSD)) totals.push(['Discount', '−' + fmtUSD(r.discountUSD)]);
  totals.push(['TOTAL USD', fmtUSD(total), 'big'], ['TOTAL LRD', fmtLRD(total * rt), 'hl'], ['Rate', '1 USD = ' + rt + ' LRD']);
  const pays = (r.payments || []).map((p) => [PAY_LABEL[p.method] || p.method, fmtCur(p.amount, p.currency)]);
  if (changeUSD > 0.004) pays.push(['Change', r.changeCurrency === 'USD' ? fmtUSD(changeUSD) : fmtLRD(changeUSD * rt)]);
  return { kind: 'RECEIPT', no: r.receiptNo, storeId: st.StoreID, date: r.timestamp, filename: 'Receipt-' + r.receiptNo,
    meta: [['Date', fmtDate(r.timestamp)], ['Served by', userName(r.userId)]], to: cust, lines, totals, pays,
    saleId: r.id, stamp: isVoid(r) ? 'VOID' : '', footer: st.ReceiptFooter || setting('DocFooter') || 'Thank you!',
    header: st.ReceiptHeader || '', paperDefault: setting('ReceiptPaper') || '80mm',
    summary: 'Receipt ' + r.receiptNo + ' — total ' + fmtUSD(total) + ' / ' + fmtLRD(total * rt) };
}

function contractDoc(c, kind) {
  const inv = kind === 'INVOICE';
  const cur = c.Currency;
  const totals = [['Subtotal', fmtCur(c.Subtotal, cur)]];
  if (num(c.Discount)) totals.push(['Discount', '−' + fmtCur(c.Discount, cur)]);
  totals.push(['TOTAL', fmtCur(c.Total, cur), 'big']);
  if (inv) {
    if (num(c.Paid)) totals.push(['Paid so far', fmtCur(c.Paid, cur)]);
    totals.push(['BALANCE DUE', fmtCur(c.Balance, cur), 'hl']);
    if (num(c.DepositPct) && !num(c.Paid)) totals.push(['Deposit to start (' + num(c.DepositPct) + '%)', fmtCur(c.DepositDue, cur), 'hl']);
  } else if (num(c.DepositPct)) totals.push(['Deposit to start (' + num(c.DepositPct) + '%)', fmtCur(c.DepositDue, cur), 'hl']);
  const no = inv ? c.InvoiceNo : c.QuoteNo;
  const meta = inv
    ? [['Invoice no.', no], ['Date', fmtDay(c.InvoiceDate)], ['Due', fmtDay(c.DueDate)], ['Quotation', c.QuoteNo]]
    : [['Quotation no.', no], ['Date', fmtDay(c.QuoteDate)], ['Valid until', fmtDay(c.ValidUntil)]];
  const pays = inv ? (c.Payments || []).filter((p) => p.Status !== 'VOID').map((p) => [fmtDay(p.Timestamp) + ' · ' + (PAY_LABEL[p.Method] || p.Method) + ' · ' + p.ReceiptNo, fmtCur(p.Amount, p.Currency)]) : [];
  const b = docBrand(c.StoreID);
  return { kind: inv ? 'INVOICE' : 'QUOTATION', no, storeId: c.StoreID, date: inv ? c.InvoiceDate : c.QuoteDate, filename: (inv ? 'Invoice-' : 'Quotation-') + no,
    meta, to: { name: c.CustomerName, phone: c.CustomerPhone, email: c.CustomerEmail, address: c.CustomerAddress }, job: c.Title,
    lines: c.Items.map((l) => ({ desc: l.desc, qty: l.qty, unit: l.unit, price: l.price, cur, total: l.total })), totals, pays,
    notes: c.Notes, terms: c.Terms, payInfo: inv || num(c.DepositPct) ? setting('DocPaymentInfo') : '',
    stamp: c.Status === 'PAID' && inv ? 'PAID' : c.Status === 'CANCELLED' ? 'CANCELLED' : '',
    footer: setting('DocFooter') || 'Thank you for your business!', paperDefault: 'A4', email: c.CustomerEmail, phone: c.CustomerPhone,
    summary: (inv ? 'Invoice ' : 'Quotation ') + no + ' — ' + c.Title + ': total ' + fmtCur(c.Total, cur) +
      (inv ? ', balance ' + fmtCur(c.Balance, cur) + ', due ' + fmtDay(c.DueDate) : (num(c.DepositPct) ? ', deposit ' + fmtCur(c.DepositDue, cur) : '') + ', valid until ' + fmtDay(c.ValidUntil)),
    subject: (inv ? 'Invoice ' : 'Quotation ') + no + ' from ' + b.biz };
}

function paymentDoc(c, p) {
  const cur = c.Currency;
  const after = (c.Payments || []).filter((x) => x.Status !== 'VOID' && x.Timestamp <= p.Timestamp).reduce((s, x) => s + num(x.AmountInContract), 0);
  const bal = Math.max(0, num(c.Total) - after);
  const b = docBrand(c.StoreID);
  return { kind: 'PAYMENT RECEIPT', no: p.ReceiptNo, storeId: c.StoreID, date: p.Timestamp, filename: 'Receipt-' + p.ReceiptNo,
    meta: [['Receipt no.', p.ReceiptNo], ['Date', fmtDay(p.Timestamp)], ['For invoice', c.InvoiceNo]],
    to: { name: c.CustomerName, phone: c.CustomerPhone, email: c.CustomerEmail, address: c.CustomerAddress }, job: c.Title,
    lines: [{ desc: 'Payment received — ' + (PAY_LABEL[p.Method] || p.Method) + (p.Reference ? ' (ref. ' + p.Reference + ')' : ''), qty: 1, unit: '', price: p.Amount, cur: p.Currency, total: p.Amount }],
    totals: [['Amount received', fmtCur(p.Amount, p.Currency), 'big'], ...(p.Currency !== cur ? [['Counted as', fmtCur(p.AmountInContract, cur)]] : []),
      ['Invoice total', fmtCur(c.Total, cur)], ['Paid to date', fmtCur(after, cur)], ['Balance', fmtCur(bal, cur), 'hl']],
    pays: [], stamp: p.Status === 'VOID' ? 'VOID' : (bal <= 0.01 ? 'PAID' : ''), footer: setting('DocFooter') || 'Thank you!',
    paperDefault: 'A4', email: c.CustomerEmail, phone: c.CustomerPhone,
    summary: 'Payment receipt ' + p.ReceiptNo + ': received ' + fmtCur(p.Amount, p.Currency) + ' for ' + c.InvoiceNo + '. Balance ' + fmtCur(bal, cur),
    subject: 'Payment receipt ' + p.ReceiptNo + ' from ' + b.biz };
}

/* ---------- rendering ---------- */
function docBody(d, paper) {
  const b = docBrand(d.storeId);
  const slip = paper !== 'A4';
  const stamp = d.stamp ? `<span class="stamp ${d.stamp === 'PAID' ? '' : 'bad'}">${esc(d.stamp)}</span>` : '';
  if (slip) {
    const w = paper === '58mm' ? 'w58' : 'w80';
    const row = (a, v, cls) => `<tr class="l ${cls || ''}"><td>${a}</td><td style="text-align:right">${v}</td></tr>`;
    return `<div class="sdoc slip ${w}">
      <div class="c">${b.logo ? `<img class="logo" src="${esc(b.logo)}" alt="">` : ''}<div class="b">${esc(d.header || b.biz)}</div>${!d.header && b.store !== b.biz ? esc(b.store) : ''}${b.address ? '<br>' + esc(b.address) : ''}${b.phone ? '<br>' + esc(b.phone) : ''}</div><hr>
      <div class="c b">${esc(d.kind)}</div>
      <table>${row(esc(d.kind === 'RECEIPT' ? 'No.' : 'No.'), esc(d.no))}${d.meta.filter((m) => !/no\.$/i.test(m[0])).map((m) => row(esc(m[0]), esc(m[1]))).join('')}
      ${d.to && d.to.name ? row('Customer', esc(d.to.name)) : ''}</table>${d.job ? `<div class="b" style="margin-top:4px">${esc(d.job)}</div>` : ''}<hr>
      ${d.lines.map((l) => `<div>${esc(l.desc)}</div><table>${row(fmtQty(l.qty) + (l.unit ? ' ' + esc(l.unit) : '') + ' × ' + fmtCur(l.price, l.cur), fmtCur(l.total, l.cur))}</table>`).join('')}<hr>
      <table>${d.totals.map((t) => row(esc(t[0]), esc(t[1]), t[2] === 'big' ? 'big' : t[2] === 'hl' ? 'b' : '')).join('')}</table>
      ${d.pays.length ? `<hr><table>${d.pays.map((p) => row(esc(p[0]), esc(p[1]))).join('')}</table>` : ''}
      ${stamp ? `<div class="c" style="margin:8px 0">${stamp}</div>` : ''}
      ${d.payInfo ? `<hr><div>${esc(d.payInfo)}</div>` : ''}
      <hr><div class="c">${esc(d.footer)}</div></div>`;
  }
  const to = d.to && d.to.name ? `<div class="lbl">${d.kind === 'QUOTATION' ? 'Prepared for' : 'Bill to'}</div><b>${esc(d.to.name)}</b>
    ${d.to.address ? '<br>' + esc(d.to.address) : ''}${d.to.phone ? '<br>' + esc(d.to.phone) : ''}${d.to.email ? '<br>' + esc(d.to.email) : ''}` : '';
  return `<div class="sdoc a4">
    <table class="hd"><tr><td style="width:55%">${b.logo ? `<img class="logo" src="${esc(b.logo)}" alt="${esc(b.biz)}">` : `<div class="biz">${esc(b.biz)}</div>`}
      <div class="muted">${b.tagline ? esc(b.tagline) + '<br>' : ''}${esc(b.store)}${b.address ? ' · ' + esc(b.address) : ''}<br>${[b.phone, b.whatsapp ? 'WhatsApp ' + b.whatsapp : ''].filter(Boolean).map(esc).join(' · ')}</div></td>
      <td style="width:45%;text-align:right"><div class="kind">${esc(d.kind)}</div>
        <table class="meta">${d.meta.map((m) => `<tr><td class="k">${esc(m[0])}</td><td><b>${esc(m[1])}</b></td></tr>`).join('')}</table></td></tr></table>
    <div class="bar"></div>
    <table class="to"><tr><td style="width:60%">${to}</td><td style="text-align:right;vertical-align:middle">${stamp}</td></tr></table>
    ${d.job ? `<div class="lbl">Job</div><div class="job">${esc(d.job)}</div>` : ''}
    <table class="items"><tr><th style="width:46%">Description</th><th class="num" style="width:14%">Qty</th><th class="num" style="width:20%">Unit price</th><th class="num" style="width:20%">Amount</th></tr>
      ${d.lines.map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${fmtQty(l.qty)}${l.unit ? ' ' + esc(l.unit) : ''}</td><td class="num">${fmtCur(l.price, l.cur)}</td><td class="num">${fmtCur(l.total, l.cur)}</td></tr>`).join('')}</table>
    <table class="tot">${d.totals.map((t) => `<tr class="${t[2] || ''}"><td>${esc(t[0])}</td><td class="num">${esc(t[1])}</td></tr>`).join('')}</table>
    ${d.pays.length ? `<div class="lbl" style="margin-top:16px">Payments</div><table class="items">${d.pays.map((p) => `<tr><td style="width:70%">${esc(p[0])}</td><td class="num">${esc(p[1])}</td></tr>`).join('')}</table>` : ''}
    ${d.payInfo ? `<div class="box"><b>How to pay</b><br>${esc(d.payInfo)}</div>` : ''}
    ${d.notes ? `<div class="box"><b>Notes</b><br>${esc(d.notes)}</div>` : ''}
    ${d.terms ? `<div class="box"><b>Terms</b><br>${esc(d.terms)}</div>` : ''}
    <div class="foot">${esc(d.footer)}<br>${esc(b.biz)}${b.phone ? ' · ' + esc(b.phone) : ''}</div></div>`;
}
function docHTML(d, paper) {
  const b = docBrand(d.storeId);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(d.filename)}</title><style>body{margin:0;background:#fff}${DOC_CSS(b.color)}
    @page{size:${paper === 'A4' ? 'A4' : paper + ' auto'};margin:${paper === 'A4' ? '14mm 13mm' : '2mm'}}${paper === 'A4' ? '.sdoc.a4{max-width:640px;padding:0}' : ''}</style></head><body>${docBody(d, paper)}</body></html>`;
}
function printDoc(d, paper) {
  const b = docBrand(d.storeId);
  $('#print-root').innerHTML = `<style>${DOC_CSS(b.color)}@page{size:${paper === 'A4' ? 'A4' : paper + ' auto'};margin:${paper === 'A4' ? '14mm 13mm' : '2mm'}}</style>${docBody(d, paper)}`;
  setTimeout(() => window.print(), 120);
}
async function docPdf(d, paper) {
  if (!navigator.onLine) throw new Error('PDF needs internet. Use Print and choose "Save as PDF" instead.');
  const r = await adminCall('makePdf', { html: docHTML(d, paper), filename: d.filename });
  const bin = atob(r.base64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], r.filename, { type: 'application/pdf' });
}
function saveFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = file.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- the document window ---------- */
function openDoc(d, back) { S.ui.doc = { d, paper: d.paperDefault || 'A4', back: back || null, busy: '' }; showModal(docModal, true); }
function docModal() {
  const x = S.ui.doc; const d = x.d;
  const b = docBrand(d.storeId);
  const canShareFiles = !!(navigator.canShare && window.File);
  return `<div class="modal-head"><h2>${esc(d.kind === 'RECEIPT' ? 'Receipt' : d.kind.charAt(0) + d.kind.slice(1).toLowerCase())} ${esc(d.no)}</h2><button class="btn ghost icon" data-act="doc-close">${icon('x')}</button></div>
    <div class="tabs" style="margin-bottom:.6rem">${PAPERS.map((p) => `<button class="tab ${x.paper === p[0] ? 'on' : ''}" data-act="doc-paper" data-p="${p[0]}">${p[1]}</button>`).join('')}</div>
    <div class="docprev ${x.paper === 'A4' ? 'a4' : 'slip'}"><style>${DOC_CSS(b.color)}</style>${docBody(d, x.paper)}</div>
    <div class="docacts">
      <button class="btn primary" data-act="doc-print">${icon('printer', 'sm')} Print</button>
      <button class="btn" data-act="doc-pdf" ${x.busy ? 'disabled' : ''}>${icon('download', 'sm')} ${x.busy === 'pdf' ? 'Making PDF…' : 'Download PDF'}</button>
      <button class="btn" data-act="doc-share" ${x.busy ? 'disabled' : ''}>${icon('share', 'sm')} ${x.busy === 'share' ? 'Making PDF…' : x.file && x.filePaper === x.paper ? 'Share PDF now' : canShareFiles ? 'Share PDF' : 'Share'}</button>
      <button class="btn" data-act="doc-email">${icon('mail', 'sm')} E-mail</button>
      ${d.kind === 'RECEIPT' && d.saleId && !d.stamp ? `<button class="btn danger-soft" data-act="void-open" data-id="${esc(d.saleId)}">${icon('x', 'sm')} Correct / void sale</button>` : ''}
      ${d.to && d.to.phone ? `<a class="btn wa" href="${esc(waLink(d.to.phone, 'Hello ' + d.to.name + ', ' + d.summary + '. ' + (d.payInfo ? 'How to pay: ' + d.payInfo + '. ' : '') + 'Thank you — ' + b.biz))}" target="_blank" rel="noopener">${icon('chat', 'sm')} WhatsApp text</a>` : ''}
    </div>
    <p class="muted small" style="margin-top:.6rem">Print → choose your printer, or <b>Save as PDF</b>. Share PDF sends the file to WhatsApp, e-mail or any app on this phone.</p>`;
}
function emailModal() {
  const x = S.ui.doc; const d = x.d; const b = docBrand(d.storeId);
  const to = (d.to && d.to.email) || '';
  return `<div class="modal-head"><h2>E-mail ${esc(d.no)}</h2><button class="btn ghost icon" data-act="doc-back">${icon('x')}</button></div>
    <form data-form="doc-email">
      <div class="field"><label>To</label><input name="to" type="email" required value="${esc(to)}" placeholder="customer@email.com"></div>
      <div class="field"><label>Subject</label><input name="subject" type="text" value="${esc(d.subject || (d.kind === 'RECEIPT' ? 'Your receipt ' + d.no + ' from ' + b.biz : d.kind + ' ' + d.no))}"></div>
      <div class="field"><label>Message</label><textarea name="message" rows="5">${esc('Hello ' + ((d.to && d.to.name) || '') + ',\n\nPlease find attached ' + d.summary + '.\n' + (d.payInfo && d.kind !== 'RECEIPT' ? '\nHow to pay: ' + d.payInfo + '\n' : '') + '\nThank you,\n' + b.biz)}</textarea></div>
      <p class="muted small">The ${x.paper === 'A4' ? 'A4' : x.paper} PDF is attached. It is sent from the business Google account.</p>
      <div class="row" style="gap:.5rem"><button class="btn ghost" type="button" data-act="doc-back">Back</button><button class="btn primary grow" type="submit">${icon('mail', 'sm')} Send</button></div></form>`;
}

Object.assign(ACT, INSTALL_ACTS, MONEY_ACTS, CAT_ACTS);
Object.assign(FORMS, MONEY_FORMS, CAT_FORMS);
Object.assign(ACT, {
  'doc-paper': (el) => { S.ui.doc.paper = el.dataset.p; refreshModal(); },
  'doc-print': () => printDoc(S.ui.doc.d, S.ui.doc.paper),
  'doc-close': () => { const back = S.ui.doc && S.ui.doc.back; S.ui.doc = null; if (back) back(); else closeModal(); },
  'doc-back': () => showModal(docModal, true),
  'doc-email': () => {
    if (!S.session.token) { toast('E-mail needs an online login: log out and in again while connected', 'bad'); return; }
    showModal(emailModal);
  },
  'doc-pdf': async () => {
    const x = S.ui.doc;
    x.busy = 'pdf'; refreshModal();
    try { saveFile(await docPdf(x.d, x.paper)); toast('PDF saved', 'ok'); }
    catch (e) { toast(e.message, 'bad'); if (/Save as PDF/.test(e.message)) printDoc(x.d, x.paper); }
    x.busy = ''; if (modalFn === docModal) refreshModal();
  },
  'doc-share': async () => {
    const x = S.ui.doc;
    const canFiles = (f) => navigator.canShare && navigator.canShare({ files: [f] });
    const share = async (f) => {
      if (canFiles(f)) await navigator.share({ files: [f], title: f.name, text: x.d.summary });
      else { saveFile(f); toast('This device cannot share files — the PDF was downloaded instead', 'ok'); }
    };
    // A PDF made earlier for this paper size is shared straight away (this tap counts as permission).
    if (x.file && x.filePaper === x.paper) {
      try { await share(x.file); } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'bad'); }
      return;
    }
    x.busy = 'share'; refreshModal();
    let f = null;
    try {
      f = await docPdf(x.d, x.paper);
      x.file = f; x.filePaper = x.paper;
      await share(f);
    } catch (e) {
      // Phones only allow sharing right after a tap; making the PDF took a moment, so ask for one more tap.
      if (f && (e.name === 'NotAllowedError' || /gesture|activation|permission/i.test(e.message))) toast('PDF ready — tap "Share PDF now"', 'ok');
      else if (e.name !== 'AbortError') toast(e.message, 'bad');
    }
    x.busy = ''; if (modalFn === docModal) refreshModal();
  },
  'sale-doc': (el) => {
    const r = S.journal.find((x) => x.id === el.dataset.id) || (S.ui.salesFound || []).find((x) => x.id === el.dataset.id);
    if (r) openDoc(saleDoc(r), modalFn === receiptModal ? () => showModal(() => receiptModal(r)) : null);
  }
});
Object.assign(FORMS, {
  'doc-email': async (f) => {
    const x = S.ui.doc;
    try {
      const r = await adminCall('emailDoc', { to: f.to.value.trim(), subject: f.subject.value.trim(), message: f.message.value, html: docHTML(x.d, x.paper), filename: x.d.filename });
      toast('Sent to ' + r.to, 'ok'); showModal(docModal, true);
    } catch (e) { toast(e.message, 'bad'); }
  }
});

/* =====================================================================
 * Receipts history (reprint, PDF, e-mail)
 * ===================================================================== */
function viewReceipts() {
  const local = S.journal.filter((r) => r.type === 'sale').slice(-60).reverse();
  const found = S.ui.salesFound;
  const rowOf = (r, onServer) => {
    const d = saleDoc(r);
    const tot = d.totals.find((t) => t[0] === 'TOTAL USD');
    const synced = !S.queue.some((q) => q.rec.id === r.id);
    return `<div class="list-item" data-act="sale-doc" data-id="${esc(r.id)}" style="cursor:pointer">${icon('receipt')}
      <span class="grow"><b>${esc(r.receiptNo)}</b>${isVoid(r) ? ' <span class="badge bad">void</span>' : ''}${!onServer && !synced ? ' <span class="badge warn">not synced</span>' : ''}
        <div class="muted small">${fmtDate(r.timestamp)} · ${esc(userName(r.userId))}${d.to && d.to.name ? ' · ' + esc(d.to.name) : ''}</div></span>
      <b class="num">${esc(tot ? tot[1] : '')}</b><span class="btn sm ghost">${icon('printer', 'sm')} Open</span></div>`;
  };
  const today = new Date().toDateString();
  const todays = S.journal.filter((r) => r.type === 'sale' && !isVoid(r) && new Date(r.timestamp).toDateString() === today);
  const tUSD = todays.reduce((a, r) => { const d = saleDoc(r); const x = d.totals.find((t) => t[0] === 'TOTAL USD'); return a + (x ? num(String(x[1]).replace(/[^\d.-]/g, '')) : 0); }, 0);
  return `<div class="page-head"><div><h2>Receipts</h2><div class="sub">Today's sales, reprint, correct a mistake</div></div></div>
    <div class="kpis"><div class="kpi"><div class="k">Sales today (this phone)</div><div class="v">${todays.length}</div></div>
      <div class="kpi"><div class="k">Total today</div><div class="v">${fmtUSD(tUSD)}</div><div class="muted small">${fmtLRD(tUSD * rate())}</div></div></div>
    <div class="row" style="gap:.5rem;margin:.2rem 0 1rem;flex-wrap:wrap">
      <button class="btn primary" data-act="sales-today">${icon('receipt', 'sm')} Today's sales (all phones)</button>
      ${canAny('REPORTS_STORE', 'REPORTS_ALL') ? `<button class="btn" data-act="go" data-view="reports">${icon('chart', 'sm')} Today's report (profit, payments)</button>` : ''}</div>
    <div class="card"><h3>Find a receipt</h3>
      <form data-form="sales-search" class="row" style="gap:.5rem;flex-wrap:wrap;align-items:flex-end">
        <div class="field grow" style="min-width:180px;margin:0"><label>Receipt no., customer name or phone</label><input name="q" type="text" value="${esc(S.ui.salesQ || '')}" placeholder="e.g. ST-01-89E6-00012"></div>
        <div class="field" style="margin:0"><label>Or from date</label><input name="from" type="date" value="${esc(S.ui.salesFrom || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10))}"></div>
        <button class="btn primary" type="submit">${icon('search', 'sm')} Search</button></form>
      ${S.ui.salesLoading ? '<div class="empty">Searching…</div>' : found ? (found.length ? `<div style="margin-top:.6rem">${found.map((r) => rowOf(r, true)).join('')}</div>` : '<div class="empty">No receipts found.</div>') : '<p class="muted small" style="margin:.6rem 0 0">Searches all receipts of this store on the server (needs internet).</p>'}
    </div>
    <div class="card" style="margin-top:1rem"><h3>Made on this device</h3>
      ${local.length ? local.map((r) => rowOf(r, false)).join('') : '<div class="empty">No sales on this device yet.</div>'}</div>`;
}
ACT['sales-today'] = async () => {
  if (!navigator.onLine) { toast('Needs internet. The list below shows sales made on this phone.', 'bad'); return; }
  S.ui.salesQ = ''; S.ui.salesFrom = new Date().toISOString().slice(0, 10);
  S.ui.salesLoading = true; render();
  try {
    const r = await adminCall('salesList', { from: new Date(new Date().toDateString()).toISOString(), storeId: store().StoreID === 'HQ' ? undefined : store().StoreID });
    S.ui.salesFound = r.sales;
  } catch (e) { toast(e.message, 'bad'); }
  S.ui.salesLoading = false; render();
};

/* ---------- correcting a sale (void, then ring up again) ---------- */
const VOID_REASONS = ['Wrong item', 'Wrong quantity', 'Wrong price', 'Wrong payment method', 'Customer returned the goods', 'Other'];
function findSale(id) { return S.journal.find((x) => x.id === id) || (S.ui.salesFound || []).find((x) => x.id === id); }
function voidModal() {
  const r = findSale(S.ui.voidId);
  if (!r) return '<div class="empty">Sale not found</div>';
  const d = saleDoc(r); const tot = d.totals.find((t) => t[0] === 'TOTAL USD');
  if (!can('SALE_VOID')) return `<div class="modal-head"><h2>Correct a sale</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <p>Only the owner or a manager can correct a finished sale. Ask them to open <b>Receipts</b>, find <b>${esc(r.receiptNo)}</b> and tap <b>Correct / void sale</b>.</p>
    <button class="btn block" data-act="close">OK</button>`;
  return `<div class="modal-head"><h2>Correct sale ${esc(r.receiptNo)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="void-sale">
      <div class="void-sum"><b>${esc(tot ? tot[1] : '')}</b> · ${d.lines.map((l) => esc(fmtQty(l.qty) + ' × ' + l.desc)).join(', ')}</div>
      <p class="muted small" style="margin:.6rem 0">The sale is cancelled (marked VOID): the goods go back into stock, it is removed from today's totals and from any customer's credit. It stays in the records with your reason.</p>
      <div class="field"><label>What went wrong?</label><select name="why">${VOID_REASONS.map((x) => `<option>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Note (optional)</label><input name="note" type="text" placeholder="e.g. should be 2 yards, not 3"></div>
      <label class="check"><input type="checkbox" name="again" checked> Put the items back in the till so I can fix them and charge again</label>
      <div class="row" style="gap:.5rem;margin-top:1rem"><button class="btn ghost" type="button" data-act="close">Cancel</button>
        <button class="btn danger grow" type="submit">${icon('x', 'sm')} Void this sale</button></div>
    </form>`;
}
ACT['void-open'] = (el) => { S.ui.voidId = el.dataset.id; S.ui.doc = null; showModal(voidModal); };
FORMS['void-sale'] = async (f) => {
  const r = findSale(S.ui.voidId); if (!r) return;
  const reason = f.why.value + (f.note.value.trim() ? ' — ' + f.note.value.trim() : '');
  const again = f.again.checked;
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Voiding…';
  try {
    if (!navigator.onLine) throw new Error('Correcting a sale needs internet. Connect and try again.');
    if (S.queue.some((q) => q.rec.id === r.id)) await sync(true);
    if (S.queue.some((q) => q.rec.id === r.id)) throw new Error('This sale has not reached the server yet. Tap Sync, then try again.');
    await adminCall('voidSale', { saleId: r.id, reason });
    const j = S.journal.find((x) => x.id === r.id); if (j) { j.status = 'VOID'; persist.journal(); }
    (S.ui.salesFound || []).forEach((x) => { if (x.id === r.id) x.status = 'VOIDED'; });
    toast('Sale ' + r.receiptNo + ' voided — stock put back', 'ok');
    closeModal();
    await sync(false);
    if (again) {
      const lines = [];
      (r.items || []).forEach((i, k) => {
        const p = productById(i.productId);
        if (p) lines.push({ productId: p.ProductID, name: p.Name, unit: p.Unit, qty: num(i.qty), step: isYard(p) ? 0.5 : 1, unitPrice: num(p.SellingPrice), priceCurrency: p.PriceCurrency });
        else if (r._names && r._names[k]) toast('Not found any more: ' + r._names[k], 'bad');
      });
      S.cart = { lines, discountUSD: 0, customerId: r.customerId || '' };
      S.view = 'pos'; S.ui.showCart = true; S.ui.sheetAnim = true;
      toast('Fix the items, then charge again', 'ok');
    }
    render();
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; btn.textContent = 'Void this sale'; }
};

FORMS['sales-search'] = async (f) => {
  S.ui.salesQ = f.q.value.trim(); S.ui.salesFrom = f.from.value;
  S.ui.salesLoading = true; render();
  try {
    const r = await adminCall('salesList', { q: S.ui.salesQ, from: S.ui.salesFrom ? new Date(S.ui.salesFrom + 'T00:00:00').toISOString() : undefined, storeId: store().StoreID === 'HQ' ? undefined : store().StoreID });
    S.ui.salesFound = r.sales;
  } catch (e) { toast(e.message, 'bad'); }
  S.ui.salesLoading = false; render();
};

/* =====================================================================
 * Quotations & invoices (contract work)
 * ===================================================================== */
const CON_TABS = [['Q', 'Quotations', ['DRAFT', 'SENT']], ['I', 'Invoices', ['INVOICED', 'PART_PAID']], ['P', 'Paid', ['PAID']], ['X', 'Declined / cancelled', ['DECLINED', 'CANCELLED']]];
const CON_BADGE = { DRAFT: '', SENT: 'brand', DECLINED: 'bad', INVOICED: 'warn', PART_PAID: 'warn', PAID: 'ok', CANCELLED: 'bad' };
const CON_LABEL = { DRAFT: 'Draft', SENT: 'Quotation sent', DECLINED: 'Declined', INVOICED: 'Invoice — unpaid', PART_PAID: 'Part paid', PAID: 'Paid', CANCELLED: 'Cancelled' };

async function loadContracts() {
  S.ui.conLoading = true; render();
  try { S.contracts = (await adminCall('contractList', {})).contracts; }
  catch (e) { toast(e.message, 'bad'); }
  S.ui.conLoading = false; render();
}
const conById = (id) => (S.contracts || []).find((c) => c.ContractID === id);
function putContract(c) { S.contracts = [c].concat((S.contracts || []).filter((x) => x.ContractID !== c.ContractID)); }

function viewContracts() {
  if (S.ui.conEdit) return contractEditor();
  if (S.ui.conId && conById(S.ui.conId)) return contractDetail(conById(S.ui.conId));
  if (!S.contracts) {
    return `<div class="page-head"><h2>Quotations &amp; invoices</h2></div><div class="card empty">${S.ui.conLoading ? 'Loading…' : (S.session.token ? '<button class="btn primary" data-act="con-load">Load quotations &amp; invoices</button>' : 'Needs internet: log out and log in again while connected.')}</div>`;
  }
  const tab = CON_TABS.find((t) => t[0] === (S.ui.conTab || 'Q'));
  const q = (S.ui.conQ || '').toLowerCase();
  const all = S.contracts;
  const list = all.filter((c) => tab[2].indexOf(c.Status) >= 0 && (!q || [c.QuoteNo, c.InvoiceNo, c.Title, c.CustomerName, c.CustomerPhone].join(' ').toLowerCase().indexOf(q) >= 0));
  const owed = all.filter((c) => c.Status === 'INVOICED' || c.Status === 'PART_PAID');
  const sumBy = (arr, k) => { const u = arr.filter((c) => c.Currency === 'USD').reduce((s, c) => s + num(c[k]), 0); const l = arr.filter((c) => c.Currency === 'LRD').reduce((s, c) => s + num(c[k]), 0); return [u ? fmtUSD(u) : '', l ? fmtLRD(l) : ''].filter(Boolean).join(' + ') || fmtUSD(0); };
  return `<div class="page-head"><div><h2>Quotations &amp; invoices</h2><div class="sub">Contract work: quote → invoice with deposit → payments → receipt</div></div>
      <div class="row" style="gap:.5rem"><button class="btn ghost" data-act="con-load">${icon('sync', 'sm')}</button><button class="btn primary" data-act="con-new">${icon('plus', 'sm')} New quotation</button></div></div>
    <div class="kpis" style="margin-bottom:1rem"><div class="kpi"><div class="k">Open quotations</div><div class="v">${all.filter((c) => c.Status === 'DRAFT' || c.Status === 'SENT').length}</div></div>
      <div class="kpi"><div class="k">Customers owe</div><div class="v">${sumBy(owed, 'Balance')}</div></div>
      <div class="kpi"><div class="k">Received (all time)</div><div class="v">${sumBy(all, 'Paid')}</div></div></div>
    <div class="row between" style="flex-wrap:wrap;gap:.5rem"><div class="tabs" style="margin:0">${CON_TABS.map((t) => `<button class="tab ${tab[0] === t[0] ? 'on' : ''}" data-act="con-tab" data-t="${t[0]}">${t[1]} (${all.filter((c) => t[2].indexOf(c.Status) >= 0).length})</button>`).join('')}</div>
      <div class="searchbox" style="max-width:280px">${icon('search')}<input id="con-q" type="text" placeholder="Search number, job, customer" value="${esc(S.ui.conQ || '')}" data-input="con-q"></div></div>
    <div style="margin-top:1rem">${list.length ? list.map((c) => `<div class="card con-row" data-act="con-open" data-id="${esc(c.ContractID)}">
        <div class="row between"><div><b>${esc(c.InvoiceNo || c.QuoteNo)}</b> <span class="badge ${CON_BADGE[c.Status]}">${CON_LABEL[c.Status]}</span>
          <div class="con-title">${esc(c.Title)}</div><div class="muted small">${esc(c.CustomerName)}${c.CustomerPhone ? ' · ' + esc(c.CustomerPhone) : ''} · ${esc(storeName(c.StoreID))}</div></div>
          <div class="right"><div class="ototal">${fmtCur(c.Total, c.Currency)}</div>${num(c.Paid) && c.Status !== 'PAID' ? `<div class="muted small">Balance ${fmtCur(c.Balance, c.Currency)}</div>` : ''}
          ${c.Status === 'INVOICED' || c.Status === 'PART_PAID' ? `<div class="muted small">Due ${fmtDay(c.DueDate)}</div>` : ''}</div></div></div>`).join('')
      : `<div class="card empty">${icon('file')}${tab[0] === 'Q' ? 'No quotations yet. Tap <b>New quotation</b> for a contract job.' : 'Nothing here.'}</div>`}</div>`;
}

function contractDetail(c) {
  const quote = ['DRAFT', 'SENT', 'DECLINED'].indexOf(c.Status) >= 0;
  const inv = !!c.InvoiceNo && !quote;
  const acts = [];
  if (quote || c.Status === 'CANCELLED') acts.push(`<button class="btn" data-act="con-doc" data-k="QUOTATION">${icon('file', 'sm')} Quotation</button>`);
  if (inv) acts.push(`<button class="btn" data-act="con-doc" data-k="INVOICE">${icon('file', 'sm')} Invoice</button>`);
  if (['DRAFT', 'SENT', 'INVOICED'].indexOf(c.Status) >= 0 && !num(c.Paid)) acts.push(`<button class="btn ghost" data-act="con-edit">Edit</button>`);
  if (c.Status === 'DRAFT') acts.push(`<button class="btn" data-act="con-status" data-s="SENT">Mark as sent</button>`);
  if (c.Status === 'DRAFT' || c.Status === 'SENT') acts.push(`<button class="btn primary" data-act="con-status" data-s="INVOICED">${icon('check', 'sm')} Accepted — make invoice</button>`);
  if (c.Status === 'SENT') acts.push(`<button class="btn ghost" data-act="con-status" data-s="DECLINED">Declined</button>`);
  if (c.Status === 'INVOICED' || c.Status === 'PART_PAID') acts.push(`<button class="btn primary" data-act="con-pay">${icon('cash', 'sm')} Record payment</button>`);
  if (['DRAFT', 'SENT', 'INVOICED'].indexOf(c.Status) >= 0 && !num(c.Paid)) acts.push(`<button class="btn danger" data-act="con-status" data-s="CANCELLED">Cancel</button>`);
  if (c.Status === 'DECLINED' || c.Status === 'CANCELLED') acts.push(`<button class="btn ghost" data-act="con-status" data-s="DRAFT">Reopen as draft</button>`);
  return `<div class="page-head"><div><button class="btn ghost sm" data-act="con-back">← All quotations &amp; invoices</button>
      <h2 style="margin-top:.4rem">${esc(c.Title)}</h2><div class="sub">${esc(c.QuoteNo)}${c.InvoiceNo ? ' · ' + esc(c.InvoiceNo) : ''} · <span class="badge ${CON_BADGE[c.Status]}">${CON_LABEL[c.Status]}</span></div></div></div>
    <div class="row" style="gap:.5rem;flex-wrap:wrap;margin-bottom:1rem">${acts.join('')}</div>
    <div class="rcols" style="margin-top:0">
      <div class="card"><h3>Customer</h3><b>${esc(c.CustomerName)}</b><div class="muted">${[c.CustomerPhone, c.CustomerEmail, c.CustomerAddress].filter(Boolean).map(esc).join('<br>')}</div>
        ${c.CustomerPhone ? `<a class="btn sm wa" style="margin-top:.6rem" href="${esc(waLink(c.CustomerPhone, 'Hello ' + c.CustomerName + ', '))}" target="_blank" rel="noopener">${icon('chat', 'sm')} WhatsApp</a>` : ''}</div>
      <div class="card"><h3>Money</h3>
        <div class="olines" style="border:0;margin:0;padding:0">
          <div><span>Total</span><b class="num">${fmtCur(c.Total, c.Currency)}</b></div>
          ${num(c.DepositPct) ? `<div><span>Deposit (${num(c.DepositPct)}%)</span><span class="num">${fmtCur(c.DepositDue, c.Currency)}</span></div>` : ''}
          <div><span>Paid</span><span class="num">${fmtCur(c.Paid, c.Currency)}</span></div>
          <div><span><b>Balance</b></span><b class="num">${fmtCur(c.Balance, c.Currency)}</b></div>
          <div class="muted"><span>${inv ? 'Due' : 'Valid until'}</span><span>${fmtDay(inv ? c.DueDate : c.ValidUntil)}</span></div></div></div>
    </div>
    <div class="card" style="margin-top:1rem"><h3>Work</h3>
      <div class="olines" style="border:0;margin:0;padding:0">${c.Items.map((l) => `<div><span>${fmtQty(l.qty)}${l.unit ? ' ' + esc(l.unit) : ''} × ${esc(l.desc)} @ ${fmtCur(l.price, c.Currency)}</span><span class="num">${fmtCur(l.total, c.Currency)}</span></div>`).join('')}
      ${num(c.Discount) ? `<div class="muted"><span>Discount</span><span class="num">−${fmtCur(c.Discount, c.Currency)}</span></div>` : ''}</div>
      ${c.Notes ? `<p class="muted" style="white-space:pre-line">${esc(c.Notes)}</p>` : ''}</div>
    <div class="card" style="margin-top:1rem"><h3>Payments</h3>
      ${(c.Payments || []).length ? c.Payments.map((p) => `<div class="list-item ${p.Status === 'VOID' ? 'muted' : ''}">${icon('receipt')}
        <span class="grow"><b>${esc(p.ReceiptNo)}</b> ${p.Status === 'VOID' ? '<span class="badge bad">void</span>' : ''}<div class="muted small">${fmtDate(p.Timestamp)} · ${esc(PAY_LABEL[p.Method] || p.Method)}${p.Reference ? ' · ' + esc(p.Reference) : ''}</div></span>
        <b class="num">${fmtCur(p.Amount, p.Currency)}</b>
        <button class="btn sm" data-act="con-receipt" data-id="${esc(p.PaymentID)}">${icon('printer', 'sm')} Receipt</button>
        ${p.Status !== 'VOID' ? `<button class="btn sm ghost" data-act="con-void" data-id="${esc(p.PaymentID)}">Void</button>` : ''}</div>`).join('')
        : `<div class="empty">${inv ? 'No payments yet.' : 'Payments are recorded once the quotation becomes an invoice.'}</div>`}</div>`;
}

function contractEditor() {
  const e = S.ui.conEdit;
  const shops = (S.snap.stores || []).filter((s) => s.Type === 'SHOP' && s.Status === 'ACTIVE');
  const sub = e.items.reduce((s, l) => s + num(l.qty) * num(l.price), 0);
  const total = Math.max(0, sub - num(e.discount));
  const dep = total * num(e.depositPct) / 100;
  return `<div class="page-head"><div><button class="btn ghost sm" data-act="con-cancel-edit">← Back</button><h2 style="margin-top:.4rem">${e.contractId ? 'Edit ' + esc(e.no) : 'New quotation'}</h2></div></div>
    <form data-form="contract" id="con-form">
      <div class="rcols" style="margin-top:0">
        <div class="card"><h3>Customer</h3>
          <div class="field"><label>Name</label><input name="customerName" type="text" list="con-custs" required value="${esc(e.customerName)}" data-input="con-cust" autocomplete="off"></div>
          <datalist id="con-custs">${customers().map((c) => `<option value="${esc(c.Name)}">${esc(c.Phone || '')}</option>`).join('')}</datalist>
          <div class="grid2"><div class="field"><label>Phone (WhatsApp)</label><input name="customerPhone" type="tel" value="${esc(e.customerPhone)}"></div>
            <div class="field"><label>E-mail</label><input name="customerEmail" type="email" value="${esc(e.customerEmail)}"></div></div>
          <div class="field"><label>Address (optional)</label><input name="customerAddress" type="text" value="${esc(e.customerAddress)}"></div></div>
        <div class="card"><h3>Job</h3>
          <div class="field"><label>Title</label><input name="title" type="text" required value="${esc(e.title)}" placeholder="e.g. 30 name scarves for St. Peter's choir"></div>
          ${store().StoreID === 'HQ' && !e.contractId ? `<div class="field"><label>Store</label><select name="storeId">${shops.map((s) => `<option value="${esc(s.StoreID)}" ${e.storeId === s.StoreID ? 'selected' : ''}>${esc(s.Name)}</option>`).join('')}</select></div>` : ''}
          <div class="grid2"><div class="field"><label>Currency</label><select name="currency" data-input="con-recalc"><option ${e.currency === 'USD' ? 'selected' : ''}>USD</option><option ${e.currency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
            <div class="field"><label>Valid until</label><input name="validUntil" type="date" value="${esc(e.validUntil)}"></div></div></div>
      </div>
      <div class="card" style="margin-top:1rem"><h3>Work and prices</h3>
        <div class="conlines">${e.items.map((l, i) => `<div class="conline">
          <div class="field" style="margin:0"><label class="${i ? 'sr' : ''}">Description</label><input name="desc_${i}" type="text" value="${esc(l.desc)}" placeholder="e.g. Knitted name scarf, school colours"></div>
          <div class="field" style="margin:0"><label class="${i ? 'sr' : ''}">Qty</label><input name="qty_${i}" type="number" step="any" min="0" value="${esc(l.qty)}" data-input="con-recalc"></div>
          <div class="field" style="margin:0"><label class="${i ? 'sr' : ''}">Unit</label><input name="unit_${i}" type="text" value="${esc(l.unit)}" placeholder="pcs"></div>
          <div class="field" style="margin:0"><label class="${i ? 'sr' : ''}">Unit price</label><input name="price_${i}" type="number" step="any" min="0" value="${esc(l.price)}" data-input="con-recalc"></div>
          <b class="num conl-t">${fmtCur(num(l.qty) * num(l.price), e.currency)}</b>
          <button type="button" class="btn ghost icon sm" data-act="con-line-del" data-i="${i}" aria-label="Remove line">${icon('trash', 'sm')}</button></div>`).join('')}</div>
        <button type="button" class="btn sm" data-act="con-line-add" style="margin-top:.6rem">${icon('plus', 'sm')} Add line</button>
        <div class="grid2" style="margin-top:1rem"><div class="field"><label>Discount (${esc(e.currency)})</label><input name="discount" type="number" step="any" min="0" value="${esc(e.discount)}" data-input="con-recalc"></div>
          <div class="field"><label>Deposit to start work (%)</label><input name="depositPct" type="number" step="1" min="0" max="100" value="${esc(e.depositPct)}" data-input="con-recalc"></div></div>
        <div class="olines" id="con-sum"><div><span>Subtotal</span><span class="num">${fmtCur(sub, e.currency)}</span></div><div><b>Total</b><b class="num">${fmtCur(total, e.currency)}</b></div><div class="muted"><span>Deposit</span><span class="num">${fmtCur(dep, e.currency)}</span></div></div></div>
      <div class="card" style="margin-top:1rem"><h3>Notes and terms</h3>
        <div class="field"><label>Notes for the customer (sizes, colours, delivery date…)</label><textarea name="notes" rows="3">${esc(e.notes)}</textarea></div>
        <div class="field"><label>Terms</label><textarea name="terms" rows="3">${esc(e.terms)}</textarea></div></div>
      <div class="row" style="gap:.5rem;margin:1rem 0 2rem"><button type="button" class="btn ghost" data-act="con-cancel-edit">Cancel</button><button class="btn primary grow" type="submit">${icon('check', 'sm')} Save quotation</button></div>
    </form>`;
}
function readConForm() {
  const f = $('#con-form'); const e = S.ui.conEdit;
  if (!f) return e;
  ['customerName', 'customerPhone', 'customerEmail', 'customerAddress', 'title', 'currency', 'validUntil', 'discount', 'depositPct', 'notes', 'terms'].forEach((k) => { if (f[k]) e[k] = f[k].value; });
  if (f.storeId) e.storeId = f.storeId.value;
  e.items = e.items.map((l, i) => ({ desc: f['desc_' + i].value, qty: f['qty_' + i].value, unit: f['unit_' + i].value, price: f['price_' + i].value }));
  return e;
}
function payModal() {
  const c = conById(S.ui.conId);
  const m = S.ui.payMethod || (c.Currency === 'USD' ? 'USD_CASH' : 'LRD_CASH');
  const fixed = m === 'USD_CASH' ? 'USD' : m === 'LRD_CASH' ? 'LRD' : '';
  const cur = fixed || S.ui.payCur || c.Currency;
  const want = !num(c.Paid) && num(c.DepositDue) ? num(c.DepositDue) : num(c.Balance);
  const rt = rate();
  const suggest = cur === c.Currency ? want : (cur === 'USD' ? want / rt : want * rt);
  return `<div class="modal-head"><h2>Payment for ${esc(c.InvoiceNo)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <p class="muted">Balance <b>${fmtCur(c.Balance, c.Currency)}</b>${!num(c.Paid) && num(c.DepositDue) ? ` · deposit asked <b>${fmtCur(c.DepositDue, c.Currency)}</b>` : ''}</p>
    <form data-form="con-pay">
      <div class="field"><label>How did they pay?</label><div class="tabs" style="margin:0">${['USD_CASH', 'LRD_CASH', 'MOMO_MTN', 'MOMO_ORANGE', 'BANK'].map((k) => `<button type="button" class="tab ${m === k ? 'on' : ''}" data-act="pay-method" data-m="${k}">${PAY_LABEL[k]}</button>`).join('')}</div></div>
      ${fixed ? '' : `<div class="field"><label>Currency</label><div class="tabs" style="margin:0">${['USD', 'LRD'].map((k) => `<button type="button" class="tab ${cur === k ? 'on' : ''}" data-act="pay-cur" data-c="${k}">${k}</button>`).join('')}</div></div>`}
      <div class="field"><label>Amount (${cur})</label><input name="amount" type="number" step="any" min="0" required value="${cur === 'USD' ? r2(suggest) : Math.round(suggest)}"></div>
      ${cur !== c.Currency ? `<p class="muted small">Counted at today's rate: 1 USD = ${rt} LRD.</p>` : ''}
      ${fixed ? '' : '<div class="field"><label>Transaction / reference no.</label><input name="reference" type="text"></div>'}
      <div class="field"><label>Note (optional)</label><input name="note" type="text"></div>
      <button class="btn primary block" type="submit">${icon('check', 'sm')} Save payment and make receipt</button></form>`;
}

Object.assign(ACT, {
  'con-load': () => loadContracts(),
  'con-tab': (el) => { S.ui.conTab = el.dataset.t; render(); },
  'con-open': (el) => { S.ui.conId = el.dataset.id; render(); window.scrollTo(0, 0); },
  'con-back': () => { S.ui.conId = null; render(); },
  'con-new': () => {
    const days = num(setting('QuoteValidDays')) || 14;
    S.ui.conEdit = { contractId: '', no: '', storeId: store().StoreID === 'HQ' ? ((S.snap.stores || []).find((s) => s.Type === 'SHOP' && s.Status === 'ACTIVE') || {}).StoreID : store().StoreID,
      customerName: '', customerPhone: '', customerEmail: '', customerAddress: '', title: '', currency: 'USD',
      validUntil: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10), discount: '', depositPct: setting('DefaultDepositPct') === undefined ? 50 : setting('DefaultDepositPct'),
      notes: '', terms: setting('DocTerms') || '', items: [{ desc: '', qty: 1, unit: '', price: '' }] };
    render(); window.scrollTo(0, 0);
  },
  'con-edit': () => {
    const c = conById(S.ui.conId);
    S.ui.conEdit = { contractId: c.ContractID, no: c.InvoiceNo || c.QuoteNo, storeId: c.StoreID, customerName: c.CustomerName, customerPhone: c.CustomerPhone,
      customerEmail: c.CustomerEmail, customerAddress: c.CustomerAddress, title: c.Title, currency: c.Currency, validUntil: (c.ValidUntil || '').slice(0, 10),
      discount: num(c.Discount) || '', depositPct: num(c.DepositPct), notes: c.Notes || '', terms: c.Terms || '',
      items: c.Items.map((l) => ({ desc: l.desc, qty: l.qty, unit: l.unit, price: l.price })) };
    render(); window.scrollTo(0, 0);
  },
  'con-cancel-edit': () => { S.ui.conEdit = null; render(); },
  'con-line-add': () => { readConForm().items.push({ desc: '', qty: 1, unit: '', price: '' }); render(); const f = $('#con-form'); const n = S.ui.conEdit.items.length - 1; if (f && f['desc_' + n]) f['desc_' + n].focus(); },
  'con-line-del': (el) => { const e = readConForm(); e.items.splice(+el.dataset.i, 1); if (!e.items.length) e.items.push({ desc: '', qty: 1, unit: '', price: '' }); render(); },
  'con-status': async (el) => {
    const c = conById(S.ui.conId); const s = el.dataset.s;
    const ask = { INVOICED: 'Turn ' + c.QuoteNo + ' into an invoice?', CANCELLED: 'Cancel ' + (c.InvoiceNo || c.QuoteNo) + '?', DECLINED: 'Mark as declined by the customer?' }[s];
    if (ask && !confirm(ask)) return;
    try { const r = await adminCall('contractStatus', { contractId: c.ContractID, status: s }); putContract(r.contract); toast(CON_LABEL[r.contract.Status], 'ok'); render();
      if (s === 'INVOICED') openDoc(contractDoc(r.contract, 'INVOICE')); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'con-doc': (el) => openDoc(contractDoc(conById(S.ui.conId), el.dataset.k)),
  'con-receipt': (el) => { const c = conById(S.ui.conId); openDoc(paymentDoc(c, c.Payments.find((p) => p.PaymentID === el.dataset.id))); },
  'con-pay': () => { S.ui.payMethod = null; S.ui.payCur = null; S.ui.payRef = uuid(); showModal(payModal); },
  'pay-method': (el) => { S.ui.payMethod = el.dataset.m; refreshModal(); },
  'pay-cur': (el) => { S.ui.payCur = el.dataset.c; refreshModal(); },
  'con-void': async (el) => {
    const reason = prompt('Why is this payment being voided?');
    if (!reason) return;
    try { const r = await adminCall('contractPaymentVoid', { paymentId: el.dataset.id, reason }); putContract(r.contract); toast('Payment voided', 'ok'); render(); }
    catch (e) { toast(e.message, 'bad'); }
  }
});
Object.assign(FORMS, {
  contract: async (f) => {
    const e = readConForm();
    const body = { storeId: e.storeId, title: e.title.trim(), customerName: e.customerName.trim(), customerPhone: e.customerPhone.trim(), customerEmail: e.customerEmail.trim(),
      customerAddress: e.customerAddress.trim(), currency: e.currency, validUntil: e.validUntil || undefined, discount: num(e.discount), depositPct: e.depositPct === '' ? 0 : num(e.depositPct),
      notes: e.notes, terms: e.terms, items: e.items.filter((l) => String(l.desc).trim()).map((l) => ({ desc: l.desc.trim(), qty: num(l.qty), unit: l.unit.trim(), price: num(l.price) })) };
    const cust = customers().find((c) => c.Name.toLowerCase() === body.customerName.toLowerCase());
    if (cust) body.customerId = cust.CustomerID;
    if (e.contractId) body.contractId = e.contractId;
    try {
      const r = await adminCall('contractSave', body);
      putContract(r.contract); S.ui.conEdit = null; S.ui.conId = r.contract.ContractID; S.ui.conTab = 'Q';
      toast('Saved ' + (r.contract.InvoiceNo || r.contract.QuoteNo), 'ok'); render(); window.scrollTo(0, 0);
    } catch (err) { toast(err.message, 'bad'); }
  },
  'con-pay': async (f) => {
    const c = conById(S.ui.conId);
    const m = S.ui.payMethod || (c.Currency === 'USD' ? 'USD_CASH' : 'LRD_CASH');
    const cur = m === 'USD_CASH' ? 'USD' : m === 'LRD_CASH' ? 'LRD' : (S.ui.payCur || c.Currency);
    try {
      const r = await adminCall('contractPay', { contractId: c.ContractID, method: m, currency: cur, amount: num(f.amount.value),
        reference: f.reference ? f.reference.value.trim() : '', note: f.note.value.trim(), clientRef: S.ui.payRef });
      putContract(r.contract); render();
      toast('Payment saved — ' + r.receiptNo, 'ok');
      openDoc(paymentDoc(r.contract, r.contract.Payments.find((p) => p.PaymentID === r.paymentId)));
    } catch (err) { toast(err.message, 'bad'); }
  }
});


/* =====================================================================
 * Features: switch parts of the app on/off so a one-person shop sees only what it uses
 * ===================================================================== */
const FEATURE_LIST = [
  ['MultiStore', 'Several stores & warehouse', 'Transfers between stores, a warehouse, opening new stores and store-by-store reports', 'truck'],
  ['Staff', 'Staff accounts', 'Other people use the app with their own name and PIN: users, roles and who-sold-what', 'users'],
  ['Shifts', 'Till shifts', 'Open and close the till with a cash count at the end of the day', 'clock'],
  ['Credit', 'Customer credit', 'Sell on credit and keep a credit book with what each customer owes', 'book'],
  ['Suppliers', 'Suppliers & purchases', 'Record deliveries from suppliers, their invoice numbers and what you paid them', 'box'],
  ['Money', 'Expenses & other income', 'Record rent, transport, salaries and other money in or out', 'wallet'],
  ['OnlineShop', 'Online shop & orders', 'Your WhatsApp online shop and the Orders screen', 'bag'],
  ['Contracts', 'Quotations & invoices', 'Quotes, invoices with deposits and payments for contract work', 'file']
];
const PRESETS = [
  ['SOLO', 'Just me, one shop', 'I do everything myself. No staff accounts, shifts, other stores or transfers.', { MultiStore: false, Staff: false, Shifts: false }],
  ['SMALL', 'One shop with staff', 'Helpers sell with their own PIN; till shifts. No other stores.', { MultiStore: false, Staff: true, Shifts: true }],
  ['MULTI', 'Several stores', 'Everything: stores, warehouse, transfers, staff and shifts.', { MultiStore: true, Staff: true, Shifts: true }]
];
function canChangeFeatures() { return isOwner() || (can('FEATURES_MANAGE') && bool(setting('ManagersCanChangeFeatures') === undefined ? true : setting('ManagersCanChangeFeatures'))); }
function featureBanner() {
  if (setting('FeaturePreset') || !isOwner() || S.ui.featureBannerHidden || S.view === 'admin') return '';
  return `<div class="card feat-banner"><div class="grow"><b>Make the app fit your business</b><div class="muted small">Hide the menus you don't use — e.g. choose "Just me, one shop" if you work alone.</div></div>
    <button class="btn primary sm" data-act="features-open">Choose</button><button class="btn ghost sm" data-act="features-later">Later</button></div>`;
}
function adminFeatures() {
  const on = {}; FEATURE_LIST.forEach((f) => { on[f[0]] = feature(f[0]); });
  const preset = setting('FeaturePreset') || '';
  return `<div class="card"><h3>How does this business work?</h3>
      <div class="presets">${PRESETS.map((p) => `<button class="preset ${preset === p[0] ? 'on' : ''}" data-act="feature-preset" data-p="${p[0]}"><b>${esc(p[1])}</b><span>${esc(p[2])}</span></button>`).join('')}</div>
      <p class="muted small" style="margin:.6rem 0 0">A preset only changes stores, staff and shifts. Your other choices below stay as they are.</p></div>
    <div class="card" style="margin-top:1rem"><h3>Features ${preset === 'CUSTOM' ? '<span class="badge">custom</span>' : ''}</h3>
      <p class="muted small" style="margin-top:0">Switch off what you don't use and its menus disappear. Nothing is deleted — switch it back on any time.</p>
      ${FEATURE_LIST.map((f) => `<label class="feat-row"><span class="fi">${icon(f[3])}</span><span class="grow"><b>${esc(f[1])}</b><span class="muted small">${esc(f[2])}</span></span>
        <input type="checkbox" class="switch" data-act="feature-toggle" data-k="${f[0]}" ${on[f[0]] ? 'checked' : ''}></label>`).join('')}</div>
    ${isOwner() ? `<div class="card" style="margin-top:1rem"><label class="feat-row" style="border:0;padding:0"><span class="fi">${icon('shield')}</span><span class="grow"><b>Managers may change features</b>
        <span class="muted small">When off, only you (the owner) can change this page.</span></span>
        <input type="checkbox" class="switch" data-act="feature-managers" ${bool(setting('ManagersCanChangeFeatures') === undefined ? true : setting('ManagersCanChangeFeatures')) ? 'checked' : ''}></label></div>` : ''}`;
}
async function saveFeatures(body, msg) {
  if (!S.session.token) { toast('Needs internet: log out and in again while connected', 'bad'); render(); return; }
  try {
    const r = await adminCall('setFeatures', body);
    const put = (k, v) => { const row = (S.snap.settings || []).find((x) => x.Key === k); if (row) row.Value = v; else (S.snap.settings = S.snap.settings || []).push({ Key: k, Value: v }); };
    Object.keys(r.features).forEach((k) => put('Feature_' + k, r.features[k]));
    put('FeaturePreset', r.preset); put('ManagersCanChangeFeatures', r.managersCanChange);
    await persist.snap();
    toast(msg || 'Saved', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
  render();
}
Object.assign(ACT, {
  'features-open': () => { S.view = 'admin'; S.ui.adminTab = 'features'; render(); },
  'features-later': () => { S.ui.featureBannerHidden = true; render(); },
  'feature-preset': (el) => { const p = PRESETS.find((x) => x[0] === el.dataset.p); saveFeatures({ preset: 'CUSTOM', features: p[3] }, p[1] + ' — menus updated'); },
  'feature-toggle': (el) => saveFeatures({ features: { [el.dataset.k]: el.checked } }, (el.checked ? 'Switched on: ' : 'Hidden: ') + FEATURE_LIST.find((f) => f[0] === el.dataset.k)[1]),
  'feature-managers': (el) => saveFeatures({ managersCanChange: el.checked }, el.checked ? 'Managers may change features' : 'Only you can change features'),
  'nav-more': () => showModal(() => {
    const items = navItems();
    return `<div class="modal-head"><h2>More</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
      <div class="more-grid">${items.map((i) => `<button class="${S.view === i[0] ? 'on' : ''}" data-act="nav-pick" data-view="${i[0]}">${icon(i[1])}<span>${esc(i[2])}</span></button>`).join('')}</div>`;
  }),
  'nav-pick': (el) => { closeModal(); ACT.go(el); }
});
function intakeSimple() {
  return `<div class="modal-head"><h2>Add stock</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="intake">
      <input type="hidden" name="supplierId" value=""><input type="hidden" name="invoiceNo" value="">
      <div class="field"><label>Cost currency</label><select name="currency"><option>USD</option><option>LRD</option></select></div>
      <input type="hidden" name="paid" value="0">
      <label>Items</label>${linesEditor('intake')}
      <button class="btn primary block" type="submit">Add to stock</button></form>`;
}
boot();
