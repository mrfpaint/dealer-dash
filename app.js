// Dealer Dash — single-page PWA. No build step: plain ES modules served as-is.
//
// Offline model: a saved visit goes into an IndexedDB "outbox" (with its photos as
// Blobs) and is uploaded by sync() whenever the phone is online. Visit ids are made
// on the phone, so a re-sent visit just overwrites itself on the server.

const STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
const ROLE_LABEL = { rep: 'Field rep', manager: 'Area manager', head: 'Sales head', admin: 'Admin' };
const DEALER_TYPES = ['Regular', 'Special', 'Exclusive'];
const CREDIT_DAYS = [7, 15, 30, 60];
const CD_PERCENTS = [3.5, 5];

// ---------------------------------------------------------------------------
// Small helpers

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const cr = (n) => (n === null || n === undefined || n === '' ? '' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`);
const yn = (b) => (b === 1 ? 'Yes' : b === 0 ? 'No' : '—');
const isManager = () => ['manager', 'head', 'admin'].includes(user?.role);
const isLead = () => ['head', 'admin'].includes(user?.role);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = val;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 3000);
}

const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('dd.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dd.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('dd.' + k); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------------
// IndexedDB: outbox (visits waiting to upload) + kv (the unfinished form draft)

let dbPromise;
function idb() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('dealer-dash', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('outbox', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
async function store(name, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const outbox = {
  all: () => store('outbox', 'readonly', (s) => s.getAll()),
  get: (id) => store('outbox', 'readonly', (s) => s.get(id)),
  put: (item) => store('outbox', 'readwrite', (s) => s.put(item)),
  del: (id) => store('outbox', 'readwrite', (s) => s.delete(id)),
};
const kv = {
  get: (k) => store('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => store('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k) => store('kv', 'readwrite', (s) => s.delete(k)),
};
async function myOutbox() { return (await outbox.all()).filter((i) => i.user_id === user?.id); }

// ---------------------------------------------------------------------------
// API
//
// The page is on GitHub Pages and the API on a Cloudflare Worker. When testing
// locally, the page is served on :8796 and `wrangler dev` runs on :8795.
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8795'
  : 'https://dealer-dash.jofran81.workers.dev';

let token = ls.get('token');
let user = ls.get('user');
let masters = ls.get('masters');

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : res;
  if (res.status === 401 && token) { logout(false); throw Object.assign(new Error(data.error || 'Please log in'), { status: 401 }); }
  if (!res.ok) throw Object.assign(new Error((isJson && data.error) || res.statusText), { status: res.status });
  return data;
}

async function loadMasters() {
  try {
    masters = await api('/api/masters');
    ls.set('masters', masters);
  } catch (e) {
    if (!masters) throw e;
  }
  return masters;
}

function logout(navigate = true) {
  token = null; user = null;
  ls.del('token'); ls.del('user'); ls.del('myVisits');
  renderNav();
  if (navigate) location.hash = '#/login'; else route();
}

// ---------------------------------------------------------------------------
// Sync

let syncing = false;
async function sync({ quiet = false } = {}) {
  if (syncing || !token || !navigator.onLine) return updateNet();
  syncing = true;
  let done = 0, failed = 0;
  try {
    for (const item of await myOutbox()) {
      try {
        await api('/api/visits', { method: 'POST', body: item.visit });
        for (const kind of ['shop', 'card']) {
          const blob = item.photos?.[kind];
          if (blob) await api(`/api/photos/${item.id}/${kind}`, { method: 'PUT', raw: blob, headers: { 'content-type': blob.type || 'image/jpeg' } });
        }
        await outbox.del(item.id);
        done++;
      } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 401) break; // offline / server down: try again later
        item.error = e.message; // the server rejected this one; keep it so the rep can fix it
        await outbox.put(item);
        failed++;
      }
    }
  } finally {
    syncing = false;
  }
  await updateNet();
  if (done && !quiet) toast(`${done} visit${done > 1 ? 's' : ''} uploaded`);
  if (failed) toast(`${failed} visit${failed > 1 ? 's' : ''} could not be uploaded. Open it to fix.`, true);
  if ((done || failed) && /^#\/?$/.test(location.hash || '#/')) route();
}

async function updateNet() {
  const el = $('#net');
  const pending = token ? (await myOutbox()).length : 0;
  if (!navigator.onLine) { el.textContent = pending ? `Offline · ${pending} to upload` : 'Offline'; el.hidden = false; }
  else if (pending) { el.textContent = `${pending} to upload`; el.hidden = false; }
  else el.hidden = true;
}
addEventListener('online', () => sync());
addEventListener('offline', updateNet);
setInterval(() => sync({ quiet: false }), 60_000);

// ---------------------------------------------------------------------------
// Router + nav

function renderNav() {
  const links = !user ? [] : [
    ['#/', 'Home'],
    ['#/new', '+ Visit'],
    ...(isManager() ? [['#/dashboard', 'Dashboard']] : []),
    ...(user.role === 'admin' ? [['#/users', 'Users']] : []),
    ...(isLead() ? [['#/brands', 'Brands']] : []),
    ['#/account', 'Account'],
  ];
  const cur = location.hash || '#/';
  $('#nav').innerHTML = links.map(([h, l]) => `<a href="${h}" class="${cur === h ? 'active' : ''}">${l}</a>`).join('');
}

const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/?$/, viewHome],
  [/^#\/new$/, () => viewForm()],
  [/^#\/edit\/([\w-]+)$/, (id) => viewForm(id)],
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/users$/, viewUsers],
  [/^#\/brands$/, viewBrands],
  [/^#\/account$/, viewAccount],
];

async function route() {
  const hash = location.hash || '#/';
  if (!token && hash !== '#/login') { location.hash = '#/login'; return; }
  renderNav();
  closeModal();
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(...m.slice(1)); } catch (e) { app.innerHTML = `<div class="card">Could not load this page: ${esc(e.message)}</div>`; }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}
addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Login / first-time setup

async function viewLogin() {
  if (token) { location.hash = '#/'; return; }
  let needsSetup = false;
  try { needsSetup = (await api('/api/setup')).needed; } catch { /* offline: show normal login */ }
  app.innerHTML = `
    <div class="narrow" style="max-width:420px">
      <div class="card" style="margin-top:8vh">
        <h1>${needsSetup ? 'Set up Dealer Dash' : 'Log in'}</h1>
        ${needsSetup ? '<p class="muted">No users exist yet. Create the first admin account.</p>' : ''}
        <form id="loginForm">
          ${needsSetup ? '<label>Your name</label><input name="name" required autocomplete="name">' : ''}
          <label>Login (employee code or mobile)</label>
          <input name="login" required autocomplete="username" autocapitalize="none">
          <label>Password</label>
          <input name="password" type="password" required minlength="${needsSetup ? 6 : 1}" autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
          <button class="btn primary block mt">${needsSetup ? 'Create admin and continue' : 'Log in'}</button>
        </form>
      </div>
    </div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const res = await api(needsSetup ? '/api/setup' : '/api/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      token = res.token; user = res.user;
      ls.set('token', token); ls.set('user', user);
      await loadMasters().catch(() => {});
      location.hash = isLead() ? '#/dashboard' : '#/';
      sync({ quiet: true });
    } catch (err) {
      toast(err.status ? err.message : 'No network. You need internet to log in the first time.', true);
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Home: new visit + my visits (pending ones first)

async function viewHome() {
  const pending = await myOutbox();
  const draft = await kv.get('draft');
  app.innerHTML = `
    <div class="narrow">
      <h1>Hi ${esc(user.name.split(' ')[0])}</h1>
      ${draft?.f?.user_id === user.id ? `<div class="banner info spaced"><span>You have an unfinished visit${draft.f.shop_name ? ` (${esc(draft.f.shop_name)})` : ''}.</span><a class="btn small" href="#/new">Continue</a></div>` : ''}
      ${pending.length ? `<div class="banner warn spaced"><span><b>${pending.length}</b> visit${pending.length > 1 ? 's' : ''} saved on this phone, waiting to upload.</span><button class="btn small" id="syncNow">Upload now</button></div>` : ''}
      <a class="btn primary block big" href="#/new" id="newBtn">+ New dealer visit</a>
      <h2 class="mt">My recent visits</h2>
      <ul class="list" id="myList"><li class="muted">Loading…</li></ul>
    </div>`;
  if (draft?.f?.user_id === user.id) $('#newBtn').textContent = '+ Start another visit';
  $('#newBtn').onclick = async (e) => {
    e.preventDefault();
    if (draft?.f?.user_id === user.id && !confirm('Discard the unfinished visit and start a new one?')) return;
    await kv.del('draft');
    location.hash = '#/new';
  };
  const syncBtn = $('#syncNow');
  if (syncBtn) syncBtn.onclick = () => (navigator.onLine ? sync() : toast('Still offline. It will upload automatically when you have signal.'));

  let server = ls.get('myVisits') || [];
  const draw = () => {
    const pendingIds = new Set(pending.map((p) => p.id));
    const rows = [
      ...pending.map((p) => ({ ...p.visit, _pending: true, _error: p.error })),
      ...server.filter((v) => !pendingIds.has(v.id)),
    ];
    $('#myList').innerHTML = rows.length
      ? rows.map((v) => `
        <li data-open="${esc(v.id)}">
          <div class="top"><span class="name">${esc(v.shop_name)}</span>
            ${v._pending ? `<span class="pill pending">${v._error ? 'Needs fixing' : 'Not uploaded'}</span>` : v.interest ? `<span class="pill ${esc(v.interest)}">${esc(v.interest)}</span>` : ''}</div>
          <div class="meta">${esc([v.town, v.district, fmtDate(v.visit_date)].filter(Boolean).join(' · '))}${v.status && v.status !== 'New' ? ` · <span class="pill ${esc(v.status)}">${esc(v.status)}</span>` : ''}</div>
        </li>`).join('')
      : '<li class="empty">No visits yet. Tap “New dealer visit” at a shop to start.</li>';
  };
  draw();
  if (navigator.onLine) {
    try {
      server = (await api(`/api/visits?user=${encodeURIComponent(user.id)}&limit=30`)).visits;
      ls.set('myVisits', server);
      draw();
    } catch { /* keep cached list */ }
  }
  $('#myList').onclick = (e) => {
    const li = e.target.closest('[data-open]');
    if (!li) return;
    const p = pending.find((x) => x.id === li.dataset.open);
    if (p) showVisit(p.visit, { pending: p });
    else showVisit(server.find((v) => v.id === li.dataset.open));
  };
}

// ---------------------------------------------------------------------------
// Visit form

let f;           // the visit being edited
let photos;      // { shop: Blob|null, card: Blob|null }
let photoUrls = {};
let gps = { status: 'idle' };
let draftTimer;

function blankVisit() {
  return {
    id: uuid(), user_id: user.id, visit_date: today(), created_at: new Date().toISOString(),
    shop_name: '', owner_name: '', mobile1: '', mobile2: '', landline: '', address: '',
    pincode: '', area: '', town: '', district: '', state: '',
    brands: [],
    turnover_total: null, turnover_wood: null, turnover_metal: null, turnover_wall: null, turnover_others: null,
    has_tinting: null, tinting_type: null, tinting_brands: [], tinting_brand_other: '',
    cd_dealer: null, cd_percent: null, credit_days: null, purchase_from: null, payment_modes: [], payment_other: '',
    lat: null, lng: null, gps_accuracy: null,
    interest: null, remarks: '', followup_date: '',
  };
}

async function viewForm(editId) {
  if (!masters) {
    try { await loadMasters(); } catch {
      app.innerHTML = '<div class="card narrow">This phone has not downloaded the brand list yet. Connect to the internet once and open the app again.</div>';
      return;
    }
  } else if (navigator.onLine) loadMasters().catch(() => {});

  photos = { shop: null, card: null };
  gps = { status: 'idle' };
  if (editId) {
    const pending = await outbox.get(editId);
    if (pending) {
      f = { ...blankVisit(), ...pending.visit, _editing: true };
      photos = { ...photos, ...pending.photos };
    } else {
      const { visit } = await api(`/api/visits/${editId}`);
      if (visit.user_id !== user.id) { toast('You can only edit your own visits', true); location.hash = '#/'; return; }
      f = { ...blankVisit(), ...visit, _editing: true, _serverPhotos: { shop: visit.photo_shop, card: visit.photo_card } };
      for (const k of Object.keys(f)) if (f[k] === null && typeof blankVisit()[k] === 'string') f[k] = '';
    }
    gps.status = f.lat != null ? 'ok' : 'idle';
  } else {
    const draft = await kv.get('draft');
    if (draft?.f?.user_id === user.id) {
      f = draft.f;
      photos = draft.photos || photos;
      gps.status = f.lat != null ? 'ok' : 'idle';
    } else {
      f = blankVisit();
    }
  }
  setPhotoUrls();
  renderForm();
  if (f.lat == null) captureGps();
}

function setPhotoUrls() {
  Object.values(photoUrls).forEach((u) => u && u.startsWith('blob:') && URL.revokeObjectURL(u));
  photoUrls = {};
  for (const k of ['shop', 'card']) if (photos[k]) photoUrls[k] = URL.createObjectURL(photos[k]);
}

function saveDraftSoon() {
  if (f._editing) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => kv.set('draft', { f, photos }).catch(() => {}), 400);
}

const brandMaster = (name) => masters.brands.find((b) => b.name === name);

function field(name, label, o = {}) {
  const val = esc(getPath(f, name) ?? '');
  const attrs = `name="${name}" id="f_${name.replace(/\./g, '_')}" ${o.type ? `type="${o.type}"` : ''} ${o.ph ? `placeholder="${esc(o.ph)}"` : ''}
    ${o.inputmode ? `inputmode="${o.inputmode}"` : ''} ${o.max ? `maxlength="${o.max}"` : ''} ${o.list ? `list="${o.list}"` : ''} ${o.step ? `step="${o.step}" min="0"` : ''} autocomplete="off"`;
  return `<div><label for="f_${name.replace(/\./g, '_')}">${esc(label)}${o.req ? ' <span class="req">*</span>' : ''}</label>
    ${o.ta ? `<textarea ${attrs}>${val}</textarea>` : `<input ${attrs} value="${val}">`}${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
}

// options: array of values or [value, label]; numbers stay numbers.
function chips(name, options, { multi = false, cls = () => '' } = {}) {
  const cur = getPath(f, name);
  return `<div class="chips">${options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    const on = multi ? (cur || []).includes(v) : cur === v;
    return `<button type="button" class="chip ${cls(v)} ${on ? 'on' : ''}" data-chip="${name}" data-v="${esc(v)}" data-num="${typeof v === 'number' ? 1 : ''}" ${multi ? 'data-multi="1"' : ''}>${esc(l)}</button>`;
  }).join('')}</div>`;
}

function gpsHtml() {
  if (gps.status === 'ok' && f.lat != null) {
    return `<span class="dot ok"></span><span>Captured (±${Math.round(f.gps_accuracy || 0)} m) · <a href="https://maps.google.com/?q=${f.lat},${f.lng}" target="_blank" rel="noopener">view</a></span>
      <button type="button" class="link" data-action="gps">Re-capture</button>`;
  }
  if (gps.status === 'wait') return '<span class="dot wait"></span><span>Getting location…</span>';
  if (gps.status === 'bad') return `<span class="dot bad"></span><span>${esc(gps.msg)}</span><button type="button" class="link" data-action="gps">Try again</button>`;
  return '<span class="dot"></span><button type="button" class="link" data-action="gps">Capture location</button>';
}

function captureGps() {
  if (!navigator.geolocation) { gps = { status: 'bad', msg: 'Location not supported on this device' }; return updateGps(); }
  gps = { status: 'wait' };
  updateGps();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      f.lat = +pos.coords.latitude.toFixed(6);
      f.lng = +pos.coords.longitude.toFixed(6);
      f.gps_accuracy = Math.round(pos.coords.accuracy);
      gps = { status: 'ok' };
      updateGps();
      saveDraftSoon();
    },
    (err) => {
      gps = { status: 'bad', msg: err.code === 1 ? 'Location permission denied. Allow it in browser settings.' : 'Could not get location. Step outside and try again.' };
      updateGps();
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
  );
}
function updateGps() { const el = $('#gps'); if (el) el.innerHTML = gpsHtml(); }

function brandCard(b, i) {
  const bm = brandMaster(b.brand);
  const kind = b.dealer_type === 'Special' ? 'special' : b.dealer_type === 'Exclusive' ? 'exclusive' : null;
  const opts = kind ? (bm?.options || []).filter((o) => o.kind === kind && o.active) : [];
  const known = opts.some((o) => o.name === b.tier);
  const showOther = kind && (b._other || (b.tier && !known) || !opts.length);
  return `<div class="brand-card">
    <div class="title"><span>${esc(b.brand)}</span><button type="button" class="link" data-action="remove-brand" data-i="${i}">Remove</button></div>
    ${b.brand === 'Others' || b.brand === 'Local brand' ? field(`brands.${i}.other_name`, 'Brand name', { ph: 'Which brand?' }) : ''}
    <label>Dealer type</label>
    ${chips(`brands.${i}.dealer_type`, DEALER_TYPES.map((t) => [t, t === 'Special' ? 'Special dealer' : t === 'Exclusive' ? 'Exclusive outlet' : 'Regular dealer']))}
    ${kind && opts.length ? `<label>${kind === 'special' ? 'Classification' : 'Outlet type'}</label>
      <select data-tier="${i}" aria-label="${kind === 'special' ? 'Classification' : 'Outlet type'}">
        <option value="">Select…</option>
        ${opts.map((o) => `<option ${o.name === b.tier ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        <option value="__other" ${showOther ? 'selected' : ''}>Other (type it)</option>
      </select>` : ''}
    ${showOther ? field(`brands.${i}.tier`, kind === 'special' ? (opts.length ? 'Other classification' : 'Classification (if any)') : (opts.length ? 'Other outlet type' : 'Outlet type (if known)'), { ph: 'As told by the dealer' }) : ''}
  </div>`;
}

function renderForm() {
  const y = window.scrollY;
  const chosen = new Set(f.brands.map((b) => b.brand));
  const turnoverStep = { type: 'number', step: 'any', inputmode: 'decimal', ph: '0' };
  app.innerHTML = `
  <form class="narrow" id="visitForm" novalidate>
    <h1>${f._editing ? 'Edit visit' : 'New dealer visit'}</h1>

    <div class="card section"><h2><span class="num">1</span>Visit</h2>
      <div class="row">
        <div><label>Date of visit</label><input value="${fmtDate(f.visit_date)}" readonly></div>
        <div><label>Rep</label><input value="${esc(user.name)}" readonly></div>
      </div>
      <label>Shop location (GPS)</label><div class="gps" id="gps">${gpsHtml()}</div>
    </div>

    <div class="card section"><h2><span class="num">2</span>Shop &amp; dealer</h2>
      ${field('shop_name', 'Shop name', { req: 1, ph: 'e.g. Buhari Paints Ltd' })}
      ${field('owner_name', 'Name of the dealer', { ph: 'e.g. Joshy Francis' })}
      <div class="row">
        ${field('mobile1', 'Mobile 1', { req: 1, type: 'tel', inputmode: 'tel', max: 14, ph: '10 digits' })}
        ${field('mobile2', 'Mobile 2', { type: 'tel', inputmode: 'tel', max: 14 })}
      </div>
      <div id="dup"></div>
      ${field('landline', 'Landline', { type: 'tel', inputmode: 'tel', max: 15, ph: 'with STD code' })}
      ${field('address', 'Address', { ta: 1, ph: 'Door no., street, landmark' })}
      <div class="row">
        ${field('pincode', 'Pincode', { inputmode: 'numeric', max: 6, ph: '6 digits', hint: `<span id="pinHint">${pinInfo?.pin === f.pincode ? esc(pinInfo.hint) : ''}</span>` })}
        ${field('area', 'Area / locality', { list: 'areaList' })}
      </div>
      <div class="row">
        ${field('town', 'Town', { list: 'townList' })}
        ${field('district', 'District')}
      </div>
      <label for="f_state">State</label>
      <select name="state" id="f_state"><option value="">Select…</option>${STATES.map((s) => `<option ${s === f.state ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <datalist id="areaList">${(pinInfo?.areas || []).map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <datalist id="townList">${(pinInfo?.towns || []).map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
    </div>

    <div class="card section" id="sec_brands"><h2><span class="num">3</span>Brands sold <span class="req">*</span></h2>
      <div class="hint" style="margin-top:-.4rem;margin-bottom:.6rem">Tap every brand the shop sells.</div>
      <div class="chips">${masters.brands.filter((b) => b.active).map((b) =>
        `<button type="button" class="chip ${chosen.has(b.name) ? 'on' : ''}" data-action="toggle-brand" data-brand="${esc(b.name)}">${esc(b.name)}</button>`).join('')}</div>
      ${f.brands.map(brandCard).join('')}
    </div>

    <div class="card section"><h2><span class="num">4</span>Turnover (₹ crore per year)</h2>
      <div class="row">
        ${field('turnover_wood', 'Wood', turnoverStep)}
        ${field('turnover_metal', 'Metal', turnoverStep)}
        ${field('turnover_wall', 'Wall', turnoverStep)}
        ${field('turnover_others', 'Others', turnoverStep)}
      </div>
      ${field('turnover_total', 'Total turnover', { ...turnoverStep, hint: 'Adds up the four above automatically, or type the total if that is all the dealer tells you. 50 lakh = 0.5' })}
    </div>

    <div class="card section"><h2><span class="num">5</span>Tinting machine</h2>
      <label>Has a tinting machine?</label>
      ${chips('has_tinting', [[1, 'Yes'], [0, 'No']])}
      ${f.has_tinting === 1 ? `
        <label>Type</label>${chips('tinting_type', ['Water based', 'Dual mode', 'Both'])}
        <label>Machine brand</label>${chips('tinting_brands', masters.tintingBrands, { multi: true })}
        ${f.tinting_brands.includes('Others') ? field('tinting_brand_other', 'Other machine brand') : ''}` : ''}
    </div>

    <div class="card section"><h2><span class="num">6</span>Trade terms</h2>
      <label>Cash discount (CD) dealer?</label>
      ${chips('cd_dealer', [[1, 'CD dealer'], [0, 'Non-CD']])}
      ${f.cd_dealer === 1 ? `
        <label>CD %</label>
        <div class="chips">${CD_PERCENTS.map((p) => `<button type="button" class="chip ${f.cd_percent === p && !f._cdOther ? 'on' : ''}" data-action="cd" data-v="${p}">${p}%</button>`).join('')}
          <button type="button" class="chip ${f._cdOther || (f.cd_percent != null && !CD_PERCENTS.includes(f.cd_percent)) ? 'on' : ''}" data-action="cd" data-v="other">Other</button></div>
        ${f._cdOther || (f.cd_percent != null && !CD_PERCENTS.includes(f.cd_percent)) ? field('cd_percent', 'CD %', { type: 'number', step: 'any', inputmode: 'decimal' }) : ''}` : ''}
      <label>Credit days</label>
      <div class="chips">${CREDIT_DAYS.map((d) => `<button type="button" class="chip ${f.credit_days === d && !f._creditOther ? 'on' : ''}" data-action="credit" data-v="${d}">${d} days</button>`).join('')}
        <button type="button" class="chip ${f._creditOther || (f.credit_days != null && !CREDIT_DAYS.includes(f.credit_days)) ? 'on' : ''}" data-action="credit" data-v="other">Other</button></div>
      ${f._creditOther || (f.credit_days != null && !CREDIT_DAYS.includes(f.credit_days)) ? field('credit_days', 'Credit days', { type: 'number', step: '1', inputmode: 'numeric' }) : ''}
      <label>Buys from</label>
      ${chips('purchase_from', ['Direct company', 'Wholesaler', 'Both'])}
      <label>Payment method</label>
      ${chips('payment_modes', masters.paymentModes, { multi: true })}
      ${f.payment_modes.includes('Others') ? field('payment_other', 'Other payment method') : ''}
    </div>

    <div class="card section"><h2><span class="num">7</span>Photos</h2>
      <div class="photos">${['shop', 'card'].map((k) => `
        <label class="photo-slot" style="margin:0">
          ${photoUrls[k] ? `<img src="${photoUrls[k]}" alt=""><button type="button" class="x" data-action="photo-del" data-k="${k}">✕</button>`
            : f._serverPhotos?.[k] ? `<span>Photo uploaded<br><b>Tap to replace</b></span>`
            : `<span>📷<br>${k === 'shop' ? 'Shop front' : 'Visiting card'}</span>`}
          <input type="file" accept="image/*" capture="environment" data-photo="${k}">
        </label>`).join('')}</div>
    </div>

    <div class="card section"><h2><span class="num">8</span>Outcome</h2>
      <label>Interest in becoming an MRF dealer</label>
      ${chips('interest', ['Hot', 'Warm', 'Cold'], { cls: (v) => v.toLowerCase() })}
      ${field('followup_date', 'Follow-up date', { type: 'date' })}
      ${field('remarks', 'Remarks', { ta: 1, ph: 'Anything the sales head should know' })}
    </div>
  </form>
  <div class="savebar"><div class="inner">
    <button type="button" class="btn" data-action="discard">${f._editing ? 'Cancel' : 'Discard'}</button>
    <button type="button" class="btn primary" data-action="save">Save visit</button>
  </div></div>`;
  window.scrollTo(0, y);
}

// ---- form events (delegated on #app so they survive re-renders)

app.addEventListener('input', (e) => {
  const form = e.target.closest('#visitForm');
  if (!form || !e.target.name || e.target.dataset.tier) return;
  const el = e.target;
  let v = el.value;
  if (el.type === 'number') v = v === '' ? null : Number(v);
  if (el.name === 'pincode') { v = v.replace(/\D/g, '').slice(0, 6); el.value = v; }
  setPath(f, el.name, v);
  el.classList.remove('invalid');

  if (el.name.startsWith('turnover_') && el.name !== 'turnover_total' && !f._totalManual) {
    const parts = ['wood', 'metal', 'wall', 'others'].map((k) => f[`turnover_${k}`]).filter((n) => n != null);
    f.turnover_total = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null;
    $('#f_turnover_total').value = f.turnover_total ?? '';
  }
  if (el.name === 'turnover_total') f._totalManual = v != null;
  if (el.name === 'pincode' && v.length === 6) lookupPincode(v);
  saveDraftSoon();
});

app.addEventListener('change', (e) => {
  if (!e.target.closest('#visitForm')) return;
  const el = e.target;
  if (el.dataset.photo) return addPhoto(el.dataset.photo, el.files[0]);
  if (el.dataset.tier !== undefined) {
    const b = f.brands[+el.dataset.tier];
    b._other = el.value === '__other';
    b.tier = b._other ? '' : el.value;
    renderForm();
    saveDraftSoon();
    return;
  }
  if (el.tagName === 'SELECT') { setPath(f, el.name, el.value); saveDraftSoon(); }
  if (el.name === 'mobile1' || el.name === 'mobile2') checkDuplicate();
});

app.addEventListener('click', async (e) => {
  if (!e.target.closest('#visitForm, .savebar')) return;
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    const name = chip.dataset.chip;
    const v = chip.dataset.num ? Number(chip.dataset.v) : chip.dataset.v;
    if (chip.dataset.multi) {
      const arr = getPath(f, name) || [];
      setPath(f, name, arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    } else {
      setPath(f, name, getPath(f, name) === v ? null : v);
      if (/^brands\.\d+\.dealer_type$/.test(name)) {
        const b = f.brands[+name.split('.')[1]];
        b.tier = ''; b._other = false;
        if (!b.dealer_type) b.dealer_type = 'Regular';
      }
    }
    renderForm();
    saveDraftSoon();
    return;
  }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  switch (a.dataset.action) {
    case 'gps': captureGps(); break;
    case 'toggle-brand': {
      const name = a.dataset.brand;
      const idx = f.brands.findIndex((b) => b.brand === name);
      if (idx >= 0) f.brands.splice(idx, 1);
      else f.brands.push({ brand: name, dealer_type: 'Regular', tier: '', other_name: '' });
      renderForm(); saveDraftSoon(); break;
    }
    case 'remove-brand': f.brands.splice(+a.dataset.i, 1); renderForm(); saveDraftSoon(); break;
    case 'cd':
      if (a.dataset.v === 'other') { f._cdOther = true; f.cd_percent = null; }
      else { f._cdOther = false; f.cd_percent = Number(a.dataset.v); }
      renderForm(); saveDraftSoon(); break;
    case 'credit':
      if (a.dataset.v === 'other') { f._creditOther = true; f.credit_days = null; }
      else { f._creditOther = false; f.credit_days = Number(a.dataset.v); }
      renderForm(); saveDraftSoon(); break;
    case 'photo-del':
      e.preventDefault();
      photos[a.dataset.k] = null; setPhotoUrls(); renderForm(); saveDraftSoon(); break;
    case 'discard':
      if (f._editing) { history.back(); break; }
      if (!confirm('Discard this visit? Everything you entered will be lost.')) break;
      clearTimeout(draftTimer);
      await kv.del('draft'); location.hash = '#/'; break;
    case 'save': saveVisit(); break;
  }
});

async function addPhoto(kind, file) {
  if (!file) return;
  try {
    photos[kind] = await compressImage(file);
    setPhotoUrls(); renderForm(); saveDraftSoon();
  } catch {
    toast('Could not read that photo. Please try again.', true);
  }
}

// Shrinks a camera photo (often 3–8 MB) to about 150 KB so it uploads on weak signal.
async function compressImage(file, max = 1280, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

let pinInfo = null; // last pincode lookup, kept so re-renders don't lose the suggestions

async function lookupPincode(pin) {
  if (!navigator.onLine) return;
  try {
    const r = await api(`/api/pincode/${pin}`);
    if (f.pincode !== pin) return;
    pinInfo = r.found ? { pin, hint: `${r.district}, ${r.state}`, areas: r.areas, towns: r.towns } : { pin, hint: 'Pincode not found' };
    $('#pinHint').textContent = pinInfo.hint;
    if (!r.found) return;
    $('#areaList').innerHTML = r.areas.map((a) => `<option value="${esc(a)}">`).join('');
    $('#townList').innerHTML = r.towns.map((a) => `<option value="${esc(a)}">`).join('');
    if (!f.district) { f.district = r.district; $('#f_district').value = r.district; }
    const st = STATES.find((s) => s.toLowerCase() === String(r.state).toLowerCase());
    if (!f.state && st) { f.state = st; $('#f_state').value = st; }
    saveDraftSoon();
  } catch { /* lookup is only a convenience */ }
}

const cleanMobile = (m) => String(m || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

async function checkDuplicate() {
  const box = $('#dup');
  if (!box || !navigator.onLine) return;
  const nums = [f.mobile1, f.mobile2].map(cleanMobile).filter((m) => m.length === 10);
  const seen = new Map();
  for (const n of nums) {
    try {
      for (const m of (await api(`/api/visits/check?mobile=${n}&exclude=${f.id}`)).matches) seen.set(m.id, m);
    } catch { /* ignore */ }
  }
  box.innerHTML = seen.size ? `<div class="banner warn" style="margin-top:.6rem">Already visited: ${[...seen.values()].map((m) =>
    `<b>${esc(m.shop_name)}</b>${m.town ? `, ${esc(m.town)}` : ''} by ${esc(m.rep_name)} on ${fmtDate(m.visit_date)}`).join('; ')}. Save only if this is a new visit.</div>` : '';
}

function validate() {
  const errs = [];
  const bad = (name, msg) => { errs.push([name, msg]); $(`#f_${name}`)?.classList.add('invalid'); };
  if (!f.shop_name.trim()) bad('shop_name', 'Enter the shop name');
  const m1 = cleanMobile(f.mobile1);
  if (!/^[6-9]\d{9}$/.test(m1)) bad('mobile1', 'Enter a valid 10-digit mobile number');
  if (f.mobile2 && !/^[6-9]\d{9}$/.test(cleanMobile(f.mobile2))) bad('mobile2', 'Mobile 2 is not a valid 10-digit number');
  if (f.pincode && !/^\d{6}$/.test(f.pincode)) bad('pincode', 'Pincode must be 6 digits');
  if (!f.brands.length) errs.push(['brands', 'Select at least one brand the shop sells']);
  for (const k of ['wood', 'metal', 'wall', 'others', 'total']) if (f[`turnover_${k}`] < 0) bad(`turnover_${k}`, 'Turnover cannot be negative');
  if (f.cd_dealer === 1 && f.cd_percent != null && (f.cd_percent <= 0 || f.cd_percent > 20)) bad('cd_percent', 'CD % looks wrong');
  return errs;
}

async function saveVisit() {
  const errs = validate();
  if (errs.length) {
    toast(errs[0][1], true);
    const target = errs[0][0] === 'brands' ? $('#sec_brands') : $(`#f_${errs[0][0]}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (target?.focus && errs[0][0] !== 'brands') setTimeout(() => target.focus(), 300);
    return;
  }
  const visit = {};
  for (const [k, v] of Object.entries(f)) if (!k.startsWith('_')) visit[k] = v;
  visit.mobile1 = cleanMobile(f.mobile1);
  visit.mobile2 = cleanMobile(f.mobile2);
  visit.brands = f.brands.map(({ brand, dealer_type, tier, other_name }) => ({ brand, dealer_type, tier, other_name }));

  // Only new photos are queued; ones already on the server stay as they are.
  const existing = await outbox.get(f.id);
  await outbox.put({ id: f.id, user_id: user.id, visit, photos: { ...(existing?.photos || {}), ...photos }, saved_at: new Date().toISOString() });
  clearTimeout(draftTimer);
  if (!f._editing) await kv.del('draft');
  toast(navigator.onLine ? 'Visit saved. Uploading…' : 'Saved on this phone. It will upload when you have signal.');
  location.hash = '#/';
  sync({ quiet: true }).then(async () => {
    if (!(await outbox.get(visit.id))) toast('Visit uploaded ✓');
  });
}

// ---------------------------------------------------------------------------
// Visit detail (modal)

function closeModal() { $('.modal-bg')?.remove(); }

function brandsHtml(brands) {
  if (!brands?.length) return '—';
  return brands.map((b) => `<div><b>${esc(b.brand)}${b.other_name ? `: ${esc(b.other_name)}` : ''}</b> — ${esc(b.dealer_type === 'Regular' ? 'Regular dealer' : b.dealer_type === 'Special' ? 'Special dealer' : 'Exclusive outlet')}${b.tier ? ` (${esc(b.tier)})` : ''}</div>`).join('');
}

async function showVisit(v, { pending = null, onChange = null } = {}) {
  if (!v) return;
  closeModal();
  const canEdit = v.user_id === user.id;
  const canStatus = !pending && isManager();
  const kvRow = (k, val) => (val === null || val === undefined || val === '' ? '' : `<dt>${k}</dt><dd>${val}</dd>`);
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="head">
        <div><h2 style="margin:0">${esc(v.shop_name)}</h2>
          <div class="muted" style="font-size:.85rem">${fmtDate(v.visit_date)} · ${esc(v.rep_name || user.name)}</div></div>
        <button class="btn small" data-close>Close</button>
      </div>
      ${pending ? `<div class="banner warn">${pending.error ? `Upload failed: ${esc(pending.error)}. Edit the visit to fix it.` : 'Saved on this phone and not uploaded yet.'}</div>` : ''}
      <div class="card">
        <div class="chips" style="margin-bottom:.6rem">
          ${v.interest ? `<span class="pill ${esc(v.interest)}">${esc(v.interest)}</span>` : ''}
          ${v.status ? `<span class="pill ${esc(v.status)}">${esc(v.status)}</span>` : ''}
        </div>
        <dl class="kv">
          ${kvRow('Dealer name', esc(v.owner_name))}
          ${kvRow('Mobile', [v.mobile1, v.mobile2].filter(Boolean).map((m) => `<a href="tel:${esc(m)}">${esc(m)}</a>`).join(', '))}
          ${kvRow('Landline', esc(v.landline))}
          ${kvRow('Address', esc([v.address, v.area, v.town, v.district, v.state, v.pincode].filter(Boolean).join(', ')))}
          ${kvRow('Location', v.lat != null ? `<a href="https://maps.google.com/?q=${v.lat},${v.lng}" target="_blank" rel="noopener">Open in Google Maps</a> (±${Math.round(v.gps_accuracy || 0)} m)` : '')}
          ${kvRow('Brands sold', brandsHtml(v.brands))}
          ${kvRow('Turnover', [cr(v.turnover_total) && `<b>${cr(v.turnover_total)}</b>`,
            ...['wood', 'metal', 'wall', 'others'].filter((k) => v[`turnover_${k}`] != null).map((k) => `${k[0].toUpperCase() + k.slice(1)} ${cr(v[`turnover_${k}`])}`)].filter(Boolean).join(' · '))}
          ${kvRow('Tinting machine', v.has_tinting === 1 ? `Yes — ${esc(v.tinting_type || '')} ${esc([...(v.tinting_brands || []).filter((x) => x !== 'Others'), v.tinting_brand_other].filter(Boolean).join(', '))}` : v.has_tinting === 0 ? 'No' : '')}
          ${kvRow('CD dealer', v.cd_dealer === 1 ? `Yes${v.cd_percent != null ? ` — ${v.cd_percent}%` : ''}` : v.cd_dealer === 0 ? 'No' : '')}
          ${kvRow('Credit days', v.credit_days != null ? `${v.credit_days} days` : '')}
          ${kvRow('Buys from', esc(v.purchase_from))}
          ${kvRow('Payment', esc([...(v.payment_modes || []).filter((x) => x !== 'Others'), v.payment_other].filter(Boolean).join(', ')))}
          ${kvRow('Follow-up', fmtDate(v.followup_date))}
          ${kvRow('Remarks', esc(v.remarks).replace(/\n/g, '<br>'))}
          ${kvRow('Status note', v.status_note ? `${esc(v.status_note)} <span class="muted">— ${esc(v.status_by)}</span>` : '')}
        </dl>
      </div>
      <div class="card photo-view"><h3 style="margin-top:0">Photos</h3><div class="photos" id="photoBox"><span class="muted">None</span></div></div>
      ${canStatus ? `<div class="card"><h3 style="margin-top:0">Shortlisting</h3>
        <div class="row"><div><label>Status</label><select id="stSel">${masters.statuses.map((s) => `<option ${s === v.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Note</label><input id="stNote" value="${esc(v.status_note || '')}" placeholder="Optional"></div></div>
        <button class="btn primary mt" id="stSave">Update status</button></div>` : ''}
      ${canEdit ? `<a class="btn block" href="#/edit/${esc(v.id)}">Edit this visit</a>` : ''}
    </div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) closeModal(); });

  const box = $('#photoBox', bg);
  const imgs = [];
  for (const k of ['shop', 'card']) {
    let src = null;
    if (pending?.photos?.[k]) src = URL.createObjectURL(pending.photos[k]);
    else if (!pending && v[`photo_${k}`]) {
      try { src = URL.createObjectURL(await (await api(`/api/photos/${v.id}/${k}`)).blob()); } catch { /* offline */ }
    }
    if (src) imgs.push(`<a href="${src}" target="_blank"><img src="${src}" alt="${k === 'shop' ? 'Shop front' : 'Visiting card'}"></a>`);
  }
  if (imgs.length) box.innerHTML = imgs.join('');

  const stSave = $('#stSave', bg);
  if (stSave) stSave.onclick = async () => {
    stSave.disabled = true;
    try {
      await api(`/api/visits/${v.id}/status`, { method: 'POST', body: { status: $('#stSel', bg).value, note: $('#stNote', bg).value } });
      toast('Status updated');
      closeModal();
      onChange?.();
    } catch (e) { toast(e.message, true); stSave.disabled = false; }
  };
}

// ---------------------------------------------------------------------------
// Dashboard (managers / sales head)

let filters = ls.get('filters') || {};
let dashUsers = [];

async function viewDashboard() {
  if (!isManager()) { location.hash = '#/'; return; }
  if (!masters) await loadMasters();
  try { dashUsers = (await api('/api/users')).users; } catch { dashUsers = []; }
  const sel = (name, opts, ph = 'All') => `<div><label>${ph === 'All' ? name[0].toUpperCase() + name.slice(1).replace('_', ' ') : ph}</label>
    <select name="${name}"><option value="">All</option>${opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(filters[name] ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select></div>`;
  const inp = (name, label, type = 'text') => `<div><label>${label}</label><input name="${name}" type="${type}" value="${esc(filters[name] || '')}"></div>`;
  app.innerHTML = `
    <div class="spaced"><h1>Dealer prospects</h1>
      <div class="chips"><button class="btn small" id="resetF">Clear filters</button><button class="btn small primary" id="exportBtn">Export to Excel (CSV)</button></div></div>
    <details class="card" id="filterBox" ${Object.values(filters).some(Boolean) ? 'open' : ''}>
      <summary style="cursor:pointer;font-weight:700">Filters</summary>
      <form class="filters" id="filterForm">
        ${inp('q', 'Search (shop, dealer, mobile)')}
        ${inp('from', 'Visited from', 'date')}${inp('to', 'Visited to', 'date')}
        ${sel('user', dashUsers.filter((u) => u.visits > 0 || u.role === 'rep').map((u) => [u.id, u.name]), 'Rep')}
        ${sel('state', STATES, 'State')}
        ${inp('district', 'District')}${inp('town', 'Town / area')}
        ${sel('brand', masters.brands.map((b) => b.name), 'Sells brand')}
        ${sel('dealer_type', [['Regular', 'Regular dealer'], ['Special', 'Special dealer'], ['Exclusive', 'Exclusive outlet']], 'Dealer type')}
        ${inp('min_turnover', 'Min turnover (₹ Cr)', 'number')}
        ${sel('tinting', [['1', 'Has tinting'], ['0', 'No tinting']], 'Tinting machine')}
        ${sel('cd', [['1', 'CD dealer'], ['0', 'Non-CD']], 'Cash discount')}
        ${sel('interest', ['Hot', 'Warm', 'Cold'], 'Interest')}
        ${sel('status', masters.statuses, 'Status')}
        ${sel('sort', [['date', 'Latest visit'], ['turnover', 'Highest turnover'], ['shop', 'Shop name']], 'Sort by')}
      </form>
    </details>
    <div id="stats" class="stats"></div>
    <div class="grid2" id="charts"></div>
    <div class="toolbar"><h2 class="grow" style="margin:0" id="countLbl"></h2></div>
    <div class="scroll-x"><table class="data"><thead><tr>
      <th>Date</th><th>Shop</th><th>Location</th><th>Brands</th><th class="right">Turnover</th><th>Tinting</th><th>Interest</th><th>Status</th><th>Rep</th>
    </tr></thead><tbody id="rows"></tbody></table></div>
    <div class="right mt"><button class="btn" id="more" hidden>Load more</button></div>`;

  let offset = 0, all = [];
  const qs = (extra = {}) => new URLSearchParams(Object.entries({ ...filters, ...extra }).filter(([, v]) => v !== '' && v != null)).toString();

  async function loadSummary() {
    const s = await api(`/api/summary?${qs()}`);
    const t = s.totals;
    $('#stats').innerHTML = [
      [t.n, 'Dealers visited'], [t.hot || 0, 'Hot'], [t.warm || 0, 'Warm'], [t.tinting || 0, 'With tinting'],
      [t.shortlisted || 0, 'Shortlisted'], [t.converted || 0, 'Converted'], [t.turnover ? `₹${t.turnover} Cr` : '—', 'Total turnover'],
    ].map(([v, l]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join('');
    const bars = (title, rows) => {
      const max = Math.max(1, ...rows.map((r) => r.n));
      return `<div class="card bars"><h3 style="margin-top:0">${title}</h3>${rows.length ? rows.map((r) =>
        `<div class="bar"><span title="${esc(r.k)}">${esc(r.k)}</span><div class="track"><div class="fill" style="width:${(r.n / max) * 100}%"></div></div><span class="right">${r.n}</span></div>`).join('') : '<div class="muted">No data</div>'}</div>`;
    };
    $('#charts').innerHTML = bars('Competitor brands at visited shops', s.byBrand) + bars('By state', s.byState) + bars('By rep', s.byRep) + bars('By status', s.byStatus);
  }

  async function loadRows(reset) {
    if (reset) { offset = 0; all = []; }
    const r = await api(`/api/visits?${qs({ limit: 50, offset })}`);
    all = all.concat(r.visits);
    offset += r.visits.length;
    $('#countLbl').textContent = `${r.total} dealer${r.total === 1 ? '' : 's'}`;
    $('#more').hidden = offset >= r.total;
    $('#rows').innerHTML = all.length ? all.map((v) => `
      <tr class="click" data-id="${esc(v.id)}">
        <td>${fmtDate(v.visit_date)}</td>
        <td><b>${esc(v.shop_name)}</b><div class="muted">${esc(v.owner_name || '')}</div></td>
        <td>${esc([v.town || v.area, v.district].filter(Boolean).join(', '))}<div class="muted">${esc(v.state || '')}</div></td>
        <td>${v.brands.map((b) => esc(b.brand) + (b.dealer_type !== 'Regular' ? ` <span class="pill">${esc(b.tier || b.dealer_type)}</span>` : '')).join(', ')}</td>
        <td class="right">${cr(v.turnover_total)}</td>
        <td>${yn(v.has_tinting)}</td>
        <td>${v.interest ? `<span class="pill ${esc(v.interest)}">${esc(v.interest)}</span>` : ''}</td>
        <td><span class="pill ${esc(v.status)}">${esc(v.status)}</span></td>
        <td>${esc(v.rep_name)}</td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">No visits match these filters.</td></tr>';
  }

  const refresh = async () => {
    ls.set('filters', filters);
    try { await Promise.all([loadSummary(), loadRows(true)]); } catch (e) { toast(e.message, true); }
  };
  let t;
  $('#filterForm').addEventListener('input', (e) => {
    filters[e.target.name] = e.target.value;
    clearTimeout(t);
    t = setTimeout(refresh, e.target.type === 'text' || e.target.type === 'number' ? 400 : 0);
  });
  $('#resetF').onclick = () => { filters = {}; ls.set('filters', filters); viewDashboard(); };
  $('#more').onclick = () => loadRows(false);
  $('#rows').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) showVisit(all.find((v) => v.id === tr.dataset.id), { onChange: refresh });
  };
  $('#exportBtn').onclick = async () => {
    try {
      const res = await api(`/api/export?${qs()}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `dealer-dash-${today()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message, true); }
  };
  await refresh();
}

// ---------------------------------------------------------------------------
// Users (admin)

async function viewUsers() {
  if (user.role !== 'admin') { location.hash = '#/'; return; }
  const { users } = await api('/api/users');
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const managers = users.filter((u) => u.role !== 'rep' && u.active);
  const roleOpts = (cur) => Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  const mgrOpts = (cur, self) => `<option value="">— none —</option>` + managers.filter((m) => m.id !== self)
    .map((m) => `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)} (${ROLE_LABEL[m.role]})</option>`).join('');

  let last = null;
  try { last = (await api('/api/fieldone/status')).last; } catch { /* shown as never */ }
  const synced = users.filter((u) => u.source === 'fieldone');
  app.innerHTML = `
    <h1>Users</h1>
    <div class="card spaced">
      <div><b>FieldOne accounts:</b> ${synced.filter((u) => u.active).length} active.
        STs and BDOs log in as reps, ASMs and RSMs as managers, and NSH/SH/NH as sales heads, with the same username and password as FieldOne.<br>
        <span class="muted">${last ? `Last synced ${new Date(last.at).toLocaleString('en-IN')}: ${last.added} added, ${last.updated} updated, ${last.disabled} disabled${last.skipped?.length ? `, ${last.skipped.length} skipped (username already used here: ${esc(last.skipped.join(', '))})` : ''}.` : 'Not synced yet.'}
        Syncs automatically every night.</span></div>
      <button class="btn primary" id="syncBtn">Sync from FieldOne now</button>
    </div>
    <div class="card"><h2>Add a user</h2>
      <form id="addUser" class="filters">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Login (emp code / mobile)</label><input name="login" required autocapitalize="none"></div>
        <div><label>Role</label><select name="role">${roleOpts('rep')}</select></div>
        <div><label>Reports to</label><select name="manager_id">${mgrOpts('')}</select></div>
        <div><label>Region</label><input name="region" placeholder="e.g. Kerala South"></div>
        <div><label>Password</label><input name="password" required minlength="6" placeholder="min 6 characters"></div>
        <div style="align-self:end"><button class="btn primary block">Add user</button></div>
      </form>
      <div class="hint">For people who are not in FieldOne. Managers see visits by everyone who reports to them, directly or through others. The sales head and admins see everything.</div>
    </div>
    <div class="toolbar"><input id="userSearch" placeholder="Search name, login, region…" style="max-width:320px"></div>
    <div class="scroll-x"><table class="data"><thead><tr><th>Name</th><th>Login</th><th>Role</th><th>Reports to</th><th>Region</th><th class="right">Visits</th><th>Status</th></tr></thead>
    <tbody>${users.map((u) => `<tr class="click" data-id="${u.id}" data-search="${esc([u.name, u.login, u.region, byId[u.manager_id]?.name].join(' ').toLowerCase())}">
      <td><b>${esc(u.name)}</b>${u.source === 'fieldone' ? ' <span class="pill">FieldOne</span>' : ''}</td><td>${esc(u.login)}</td><td>${ROLE_LABEL[u.role]}</td>
      <td>${esc(byId[u.manager_id]?.name || '')}</td><td>${esc(u.region || '')}</td><td class="right">${u.visits}</td>
      <td>${u.active ? 'Active' : '<span class="pill">Disabled</span>'}</td></tr>`).join('')}</tbody></table></div>`;

  $('#userSearch').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    app.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = q && !tr.dataset.search.includes(q); });
  };
  $('#syncBtn').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Syncing…';
    try {
      const r = await api('/api/fieldone/sync', { method: 'POST' });
      toast(`Synced: ${r.added} added, ${r.updated} updated, ${r.disabled} disabled`);
      viewUsers();
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Sync from FieldOne now'; }
  };
  $('#addUser').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('User added');
      viewUsers();
    } catch (err) { toast(err.message, true); }
  };
  app.querySelector('tbody').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const u = byId[tr.dataset.id];
    if (u.source === 'fieldone') {
      toast(`${u.name} is managed by FieldOne. Change name, role, manager or password there; it syncs overnight.`);
      return;
    }
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" style="max-width:480px"><div class="head"><h2 style="margin:0">${esc(u.name)}</h2><button class="btn small" data-close>Close</button></div>
      <form class="card" id="editUser">
        <label>Name</label><input name="name" value="${esc(u.name)}">
        <label>Role</label><select name="role">${roleOpts(u.role)}</select>
        <label>Reports to</label><select name="manager_id">${mgrOpts(u.manager_id, u.id)}</select>
        <label>Region</label><input name="region" value="${esc(u.region || '')}">
        <label>New password (leave blank to keep)</label><input name="password" minlength="6">
        <label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" name="active" style="width:auto" ${u.active ? 'checked' : ''}> Active (can log in)</label>
        <button class="btn primary block mt">Save</button>
      </form></div>`;
    document.body.appendChild(bg);
    bg.addEventListener('click', (ev) => { if (ev.target === bg || ev.target.closest('[data-close]')) bg.remove(); });
    $('#editUser', bg).onsubmit = async (ev) => {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(ev.target));
      d.active = ev.target.active.checked ? 1 : 0;
      if (!d.password) delete d.password;
      try { await api(`/api/users/${u.id}`, { method: 'PATCH', body: d }); toast('Saved'); bg.remove(); viewUsers(); }
      catch (err) { toast(err.message, true); }
    };
  };
}

// ---------------------------------------------------------------------------
// Brands master (sales head / admin)

async function viewBrands() {
  if (!isLead()) { location.hash = '#/'; return; }
  await loadMasters();
  const optRow = (o) => `<li class="spaced" style="padding:.35rem 0;border-bottom:1px solid var(--line)">
      <span style="${o.active ? '' : 'text-decoration:line-through;color:var(--muted)'}">${esc(o.name)} ${o.verified ? '' : '<span class="pill draft">Unverified</span>'}</span>
      <span class="chips">
        ${o.verified ? '' : `<button class="btn small" data-opt="${o.id}" data-do="verify">Confirm</button>`}
        <button class="btn small" data-opt="${o.id}" data-do="rename">Rename</button>
        <button class="btn small" data-opt="${o.id}" data-do="toggle">${o.active ? 'Hide' : 'Show'}</button>
      </span></li>`;
  const unverified = masters.brands.flatMap((b) => b.options).filter((o) => !o.verified && o.active).length;
  app.innerHTML = `
    <h1>Brands &amp; dealer classifications</h1>
    ${unverified ? `<div class="banner warn"><b>${unverified}</b> entries are drafts from public sources and need checking. Tap <b>Confirm</b> if correct, <b>Rename</b> to fix the name, or <b>Hide</b> to remove it from the form.</div>` : ''}
    <div class="grid2">${masters.brands.map((b) => `
      <div class="card">
        <div class="spaced"><h2 style="margin:0;${b.active ? '' : 'color:var(--muted)'}">${esc(b.name)}</h2>
          <button class="btn small" data-brand="${b.id}" data-do="toggle-brand">${b.active ? 'Hide brand' : 'Show brand'}</button></div>
        ${['special', 'exclusive'].map((k) => `
          <h3>${k === 'special' ? 'Special dealer classifications' : 'Exclusive outlet types'}</h3>
          <ul class="list" style="margin:0">${b.options.filter((o) => o.kind === k).map(optRow).join('') || '<li class="muted" style="box-shadow:none;padding:.2rem 0;cursor:default">None yet. Reps can type one in.</li>'}</ul>
          <form class="chips mt" data-add="${b.id}" data-kind="${k}" style="flex-wrap:nowrap">
            <input name="name" placeholder="Add ${k === 'special' ? 'classification' : 'outlet type'}…"><button class="btn small">Add</button></form>`).join('')}
      </div>`).join('')}</div>
    <div class="card narrow"><h2>Add a brand</h2>
      <form id="addBrand" class="chips" style="flex-wrap:nowrap"><input name="name" placeholder="Brand name" required><button class="btn primary">Add</button></form></div>`;

  const all = Object.fromEntries(masters.brands.flatMap((b) => b.options).map((o) => [o.id, o]));
  app.onsubmit = async (e) => {
    const form = e.target;
    if (!form.dataset.add && form.id !== 'addBrand') return;
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    try {
      if (form.id === 'addBrand') await api('/api/brands', { method: 'POST', body: { name } });
      else await api('/api/brand-options', { method: 'POST', body: { brand_id: +form.dataset.add, kind: form.dataset.kind, name } });
      viewBrands();
    } catch (err) { toast(err.message, true); }
  };
  app.onclick = async (e) => {
    const btn = e.target.closest('[data-do]');
    if (!btn || location.hash !== '#/brands') return;
    try {
      if (btn.dataset.do === 'toggle-brand') {
        const b = masters.brands.find((x) => x.id === +btn.dataset.brand);
        await api('/api/brands', { method: 'POST', body: { ...b, active: !b.active } });
      } else {
        const o = all[btn.dataset.opt];
        const upd = { id: o.id, name: o.name, verified: o.verified, active: o.active };
        if (btn.dataset.do === 'verify') upd.verified = 1;
        if (btn.dataset.do === 'toggle') upd.active = !o.active;
        if (btn.dataset.do === 'rename') {
          const n = prompt('New name', o.name);
          if (!n || n.trim() === o.name) return;
          upd.name = n.trim();
          upd.verified = 1;
        }
        await api('/api/brand-options', { method: 'POST', body: upd });
      }
      viewBrands();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------------------------------------------------------------------
// Account

function viewAccount() {
  app.innerHTML = `
    <div class="narrow">
      <h1>Account</h1>
      <div class="card"><dl class="kv"><dt>Name</dt><dd>${esc(user.name)}</dd><dt>Login</dt><dd>${esc(user.login)}</dd>
        <dt>Role</dt><dd>${ROLE_LABEL[user.role]}</dd>${user.region ? `<dt>Region</dt><dd>${esc(user.region)}</dd>` : ''}</dl></div>
      ${user.source === 'fieldone'
        ? '<div class="card"><h2>Password</h2><p class="muted" style="margin:0">You log in with your FieldOne username and password. To change it, change it in FieldOne; Dealer Dash picks it up overnight.</p></div>'
        : `<div class="card"><h2>Change password</h2>
        <form id="pwForm"><label>Current password</label><input name="old" type="password" required autocomplete="current-password">
          <label>New password</label><input name="new" type="password" required minlength="6" autocomplete="new-password">
          <button class="btn primary mt">Change password</button></form></div>`}
      <div class="card"><h2>Install on your phone</h2>
        <p class="muted" style="margin:0">Android (Chrome): menu ⋮ → <b>Add to Home screen</b>. iPhone (Safari): Share → <b>Add to Home Screen</b>. The app then opens full-screen and works without signal.</p></div>
      <button class="btn block" id="logoutBtn">Log out</button>
    </div>`;
  if ($('#pwForm')) $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Password changed'); e.target.reset(); }
    catch (err) { toast(err.message, true); }
  };
  $('#logoutBtn').onclick = async () => {
    const pending = await myOutbox();
    if (pending.length && !confirm(`${pending.length} visit(s) are not uploaded yet. They stay on this phone and upload after you log in again. Log out?`)) return;
    logout();
  };
}

// ---------------------------------------------------------------------------
// Boot

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
if (token) {
  if (navigator.onLine) {
    api('/api/me').then((r) => { user = r.user; ls.set('user', user); renderNav(); }).catch(() => {});
    loadMasters().catch(() => {});
  }
  sync({ quiet: true });
}
