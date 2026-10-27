// Dealer Dash — Cloudflare Worker (API for the PWA hosted on GitHub Pages)
//
// Bindings (see wrangler.toml): DB (D1), PHOTOS (R2, optional).
// Secret: TOKEN_SECRET.
// Var: ALLOWED_ORIGINS — sites allowed to call the API (GitHub Pages + local dev).
// Binding: FIELDONE_DB — FieldOne's D1 database, whose staff tables supply most user
//      accounts (synced nightly by the cron trigger and on demand from the Users page).

const TOKEN_DAYS = 30;            // long, so reps stay logged in while offline
const PBKDF2_ITER = 50000;        // kept moderate for the Workers CPU limit
const MAX_PHOTO_BYTES = 1_500_000;

// Same roles and names as FieldOne.
const ROLES = ['st', 'bdo', 'asm', 'rsm', 'sh', 'nh', 'nsh', 'admin'];
const MANAGER_ROLES = ['asm', 'rsm', 'sh', 'nh', 'nsh', 'admin']; // dashboard + shortlisting
const HEAD_ROLES = ['sh', 'nh', 'nsh', 'admin'];                  // edit brand lists
// Each FieldOne login screen only accepts its own kind of account.
const LOGIN_SCREENS = {
  nsh: { roles: ['nsh'], label: 'NSH' },
  shnh: { roles: ['sh', 'nh'], label: 'SH / NH' },
  rsm: { roles: ['rsm'], label: 'RSM' },
  asm: { roles: ['asm'], label: 'ASM' },
  bdo: { roles: ['bdo', 'st'], label: 'BDO / ST' },
  admin: { roles: ['admin'], label: 'Admin' },
};
const STATUSES = ['New', 'Shortlisted', 'In talks', 'Converted', 'Not suitable'];
const TINTING_BRANDS = ['COROB', 'AGS', 'Idex', 'Santint', 'Fast & Fluid', 'Others'];
const PAYMENT_MODES = ['Cheque', 'RTGS / NEFT', 'UPI', 'Cash', 'Others'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Dealer Dash API. The app is at https://mrfpaint.github.io/dealer-dash/', { status: 404 });
    }

    // Browsers must come from an allowed origin. No Origin header (curl) is let
    // through — the bearer token is what actually protects the data.
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (origin && !cors['Access-Control-Allow-Origin']) {
      return json({ error: 'Origin not allowed' }, 403);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      res = await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message }, err.status);
      else { console.error(err); res = json({ error: 'Server error' }, 500); }
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncFieldOne(env).catch((e) => console.error('FieldOne sync failed:', e.message)));
  },
};

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function body(request) {
  try { return await request.json(); } catch { fail(400, 'Invalid JSON'); }
}

// ---------------------------------------------------------------------------
// Routing

async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // Public
  if (p === '/api/setup' && m === 'GET') return json({ needed: !(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first()) });
  if (p === '/api/setup' && m === 'POST') return setup(req, env);
  if (p === '/api/login' && m === 'POST') return login(req, env);

  const me = await authenticate(req, env);

  if (p === '/api/me' && m === 'GET') return json({ user: publicUser(me) });
  if (p === '/api/password' && m === 'POST') return changePassword(req, env, me);
  if (p === '/api/masters' && m === 'GET') return masters(env);
  if (p.startsWith('/api/pincode/') && m === 'GET') return pincode(p.split('/').pop());

  if (p === '/api/visits' && m === 'POST') return saveVisit(req, env, me);
  if (p === '/api/visits' && m === 'GET') return listVisits(env, me, url.searchParams);
  if (p === '/api/visits/check' && m === 'GET') return checkDuplicate(env, me, url.searchParams);
  if (p === '/api/summary' && m === 'GET') return summary(env, me, url.searchParams);
  if (p === '/api/export' && m === 'GET') return exportCsv(env, me, url.searchParams);

  let mm;
  if ((mm = p.match(/^\/api\/visits\/([\w-]{8,64})$/)) && m === 'GET') return getVisit(env, me, mm[1]);
  if ((mm = p.match(/^\/api\/visits\/([\w-]{8,64})\/status$/)) && m === 'POST') return setStatus(req, env, me, mm[1]);
  if ((mm = p.match(/^\/api\/photos\/([\w-]{8,64})\/(shop|card)$/))) {
    if (m === 'PUT') return putPhoto(req, env, me, mm[1], mm[2]);
    if (m === 'GET') return getPhoto(env, me, mm[1], mm[2]);
  }

  if (p === '/api/fieldone/sync' && m === 'POST') { requireRole(me, 'admin'); return json(await syncFieldOne(env)); }
  if (p === '/api/fieldone/status' && m === 'GET') {
    requireRole(me, 'admin');
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'fieldone_sync'").first();
    return json({ last: row ? JSON.parse(row.value) : null });
  }

  if (p === '/api/users' && m === 'GET') return listUsers(env, me);
  if (p === '/api/users' && m === 'POST') return createUser(req, env, me);
  if ((mm = p.match(/^\/api\/users\/([\w-]+)$/)) && m === 'PATCH') return updateUser(req, env, me, mm[1]);

  if (p === '/api/brands' && m === 'POST') return saveBrand(req, env, me);
  if (p === '/api/brand-options' && m === 'POST') return saveBrandOption(req, env, me);

  fail(404, 'Not found');
}

// ---------------------------------------------------------------------------
// Auth

const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const te = new TextEncoder();

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64u.dec(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64u.enc(salt), hash: b64u.enc(bits) };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacKey(env) {
  if (!env.TOKEN_SECRET) fail(500, 'TOKEN_SECRET is not configured');
  return crypto.subtle.importKey('raw', te.encode(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Passwords of FieldOne-synced users. The nightly sync re-checks every one of them,
// so a fast keyed hash is used (PBKDF2 for ~250 users would blow the Worker CPU
// limit); the key is derived from TOKEN_SECRET and never stored in D1. Lower-cased,
// because FieldOne itself compares passwords case-insensitively.
const SYNCED_SALT = 'fieldone';
async function syncedPasswordKey(env) {
  if (!env.TOKEN_SECRET) fail(500, 'TOKEN_SECRET is not configured');
  return crypto.subtle.importKey('raw', te.encode(env.TOKEN_SECRET + '|fieldone-passwords'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function syncedPasswordHash(env, password, key) {
  key ||= await syncedPasswordKey(env);
  return b64u.enc(await crypto.subtle.sign('HMAC', key, te.encode(String(password).trim().toLowerCase())));
}

async function passwordMatches(env, user, password) {
  const hash = user.pass_salt === SYNCED_SALT
    ? await syncedPasswordHash(env, password)
    : (await hashPassword(String(password), user.pass_salt)).hash;
  return timingSafeEqual(hash, user.pass_hash);
}

async function makeToken(env, userId) {
  const payload = b64u.enc(te.encode(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_DAYS * 86400e3 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), te.encode(payload));
  return `${payload}.${b64u.enc(sig)}`;
}

async function authenticate(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig) fail(401, 'Please log in');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64u.dec(sig), te.encode(payload)); } catch { /* bad base64 */ }
  if (!ok) fail(401, 'Please log in');
  const { uid, exp } = JSON.parse(new TextDecoder().decode(b64u.dec(payload)));
  if (Date.now() > exp) fail(401, 'Session expired, please log in again');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
  if (!user || !user.active) fail(401, 'Account disabled');
  return user;
}

const publicUser = (u) => ({
  id: u.id, login: u.login, name: u.name, role: u.role, manager_id: u.manager_id, region: u.region, active: u.active, source: u.source || null,
});
const isLead = (u) => u.role === 'nsh' || u.role === 'admin'; // sees every visit
const requireRole = (u, ...roles) => { if (!roles.includes(u.role)) fail(403, 'Not allowed for your role'); };

async function setup(req, env) {
  if (await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first()) fail(403, 'Already set up');
  const b = await body(req);
  const user = await insertUser(env, { login: b.login, name: b.name, password: b.password, role: 'admin' });
  return json({ token: await makeToken(env, user.id), user: publicUser(user) });
}

async function login(req, env) {
  const b = await body(req);
  const screen = LOGIN_SCREENS[b.as];
  if (!screen) fail(400, 'Choose your role first');
  const bad = `Invalid ${screen.label} credentials.`;
  const user = await env.DB.prepare('SELECT * FROM users WHERE login = ?').bind(String(b.login || '').trim()).first();
  if (!user || !user.active) fail(401, bad);
  if (!(await passwordMatches(env, user, b.password || ''))) fail(401, bad);
  if (!screen.roles.includes(user.role)) {
    const own = Object.values(LOGIN_SCREENS).find((s) => s.roles.includes(user.role));
    // "an" before letters whose name starts with a vowel sound: an ASM, an RSM, an NSH, a BDO.
    fail(401, `This is ${/^[AEFHILMNORSX]/.test(own.label) ? 'an' : 'a'} ${own.label} account — please use the ${own.label} login.`);
  }
  return json({ token: await makeToken(env, user.id), user: publicUser(user) });
}

async function changePassword(req, env, me) {
  if (me.source === 'fieldone') fail(400, 'Your password comes from FieldOne. Change it there; Dealer Dash picks it up overnight.');
  const b = await body(req);
  if (!(await passwordMatches(env, me, b.old || ''))) fail(400, 'Current password is wrong');
  await setPassword(env, me.id, b.new);
  return json({ ok: true });
}

async function setPassword(env, userId, password) {
  if (!password || String(password).length < 6) fail(400, 'Password must be at least 6 characters');
  const { salt, hash } = await hashPassword(String(password));
  await env.DB.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?').bind(salt, hash, userId).run();
}

// ---------------------------------------------------------------------------
// Users

async function insertUser(env, u) {
  const login = str(u.login, 40), name = str(u.name, 80);
  if (!login || !name) fail(400, 'Login and name are required');
  if (!ROLES.includes(u.role)) fail(400, 'Invalid role');
  if (!u.password || String(u.password).length < 6) fail(400, 'Password must be at least 6 characters');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE login = ?').bind(login).first()) fail(400, `Login "${login}" is already taken`);
  const id = crypto.randomUUID();
  const { salt, hash } = await hashPassword(String(u.password));
  await env.DB.prepare(
    'INSERT INTO users (id, login, name, role, manager_id, region, pass_salt, pass_hash) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, login, name, u.role, u.manager_id || null, str(u.region, 60), salt, hash).run();
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

// Everyone whose visits `me` may see: themselves plus everyone reporting up to them.
function teamCte(me) {
  if (isLead(me)) return { sql: 'WITH team(id) AS (SELECT id FROM users)', args: [] };
  return {
    sql: 'WITH RECURSIVE team(id) AS (SELECT ? UNION SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id)',
    args: [me.id],
  };
}

async function listUsers(env, me) {
  const t = teamCte(me);
  const { results } = await env.DB.prepare(
    `${t.sql} SELECT u.*, (SELECT COUNT(*) FROM visits v WHERE v.user_id = u.id) AS visits
     FROM users u WHERE u.id IN (SELECT id FROM team) ORDER BY u.active DESC, u.name`
  ).bind(...t.args).all();
  return json({ users: results.map((u) => ({ ...publicUser(u), visits: u.visits })) });
}

async function createUser(req, env, me) {
  requireRole(me, 'admin');
  const user = await insertUser(env, await body(req));
  return json({ user: publicUser(user) });
}

async function updateUser(req, env, me, id) {
  requireRole(me, 'admin');
  const b = await body(req);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!user) fail(404, 'User not found');
  if (user.source === 'fieldone') fail(400, 'This account is managed by FieldOne. Make the change there; it syncs overnight.');
  if (b.role !== undefined && !ROLES.includes(b.role)) fail(400, 'Invalid role');
  if (b.manager_id === id) fail(400, 'A user cannot report to themselves');
  if (id === me.id && (b.active === 0 || (b.role && b.role !== 'admin'))) fail(400, 'You cannot disable or demote yourself');
  await env.DB.prepare(
    'UPDATE users SET name = ?, role = ?, manager_id = ?, region = ?, active = ? WHERE id = ?'
  ).bind(
    b.name !== undefined ? str(b.name, 80) || user.name : user.name,
    b.role ?? user.role,
    b.manager_id !== undefined ? b.manager_id || null : user.manager_id,
    b.region !== undefined ? str(b.region, 60) : user.region,
    b.active !== undefined ? (b.active ? 1 : 0) : user.active,
    id
  ).run();
  if (b.password) await setPassword(env, id, b.password);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// FieldOne account sync
//
// Roles and reporting lines are FieldOne's: ST and BDO under their ASM, ASM under
// their RSM. RSM rows whose region is a whole zone are the heads (All India → NSH,
// South → SH, North → NH). Like FieldOne, a South-* RSM falls under SH, a North-*,
// East-* or West-* RSM under NH, and SH / NH under NSH.
// Synced accounts are matched by FieldOne id, then by username, so a promotion
// (BDO row closed, new ASM row) keeps the same Dealer Dash account and visits.
// Accounts created by hand in Dealer Dash are never touched.

const FIELDONE_TABLES = ['RSMs', 'ASMs', 'STs', 'BDOs'];
const ROLE_RANK = { st: 1, bdo: 1, asm: 2, rsm: 3, sh: 4, nh: 4, nsh: 5 };

// Rows come back as the same text the FieldOne app sees (NULL → '').
async function readFieldOneTable(env, table) {
  if (!env.FIELDONE_DB) fail(500, 'FIELDONE_DB binding is not configured');
  if (!FIELDONE_TABLES.includes(table)) fail(500, 'Unknown FieldOne table');
  const { results } = await env.FIELDONE_DB.prepare(`SELECT * FROM ${table}`).all();
  return results.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)])));
}

// Same rules FieldOne's own login uses: a blank status counts as active, and an
// RSM row whose region is a whole zone is a head.
const isLiveRow = (r) => !['inactive', 'purged', 'vacant'].includes(String(r.status || '').trim().toLowerCase())
  && String(r.username || '').trim() && String(r.password || '').trim();
function rsmRole(r) {
  const g = String(r.region || '').trim().toLowerCase();
  return g === 'all india' || g === 'all' ? 'nsh' : g === 'south' ? 'sh' : g === 'north' ? 'nh' : 'rsm';
}
// FieldOne's ZONE_PREFIXES: which head an ordinary RSM falls under, by region.
function zoneHeadRole(r) {
  const g = String(r.region || '').trim().toLowerCase();
  if (g.startsWith('south')) return 'sh';
  if (['north', 'east', 'west'].some((p) => g.startsWith(p))) return 'nh';
  return 'nsh';
}

async function syncFieldOne(env) {
  const tables = {};
  for (const t of FIELDONE_TABLES) tables[t] = await readFieldOneTable(env, t); // any failure → nothing changes

  // One Dealer Dash account per username; if someone is in two tables the higher role wins.
  const wanted = new Map();
  const add = (table, r, role, managerExt) => {
    const login = String(r.username).trim();
    const prev = wanted.get(login.toLowerCase());
    if (prev && ROLE_RANK[prev.role] >= ROLE_RANK[role]) return;
    wanted.set(login.toLowerCase(), {
      ext_id: `${table}:${r.id}`, login, name: str(r.name, 80) || login, role, managerExt,
      region: str(r.region, 60), password: r.password,
    });
  };
  const rsms = tables.RSMs.filter(isLiveRow);
  const headExt = (role) => { const h = rsms.find((r) => rsmRole(r) === role); return h ? `RSMs:${h.id}` : null; };
  for (const r of rsms) {
    const role = rsmRole(r);
    const mgr = role === 'nsh' ? null
      : role === 'sh' || role === 'nh' ? headExt('nsh')
      : r.rsmId ? `RSMs:${r.rsmId}` : headExt(zoneHeadRole(r)) || headExt('nsh');
    add('RSMs', r, role, mgr);
  }
  for (const r of tables.ASMs.filter(isLiveRow)) add('ASMs', r, 'asm', r.rsmId ? `RSMs:${r.rsmId}` : null);
  for (const r of tables.STs.filter(isLiveRow)) add('STs', r, 'st', r.asmId ? `ASMs:${r.asmId}` : null);
  for (const r of tables.BDOs.filter(isLiveRow)) add('BDOs', r, 'bdo', r.asmId ? `ASMs:${r.asmId}` : null);

  const existing = (await env.DB.prepare('SELECT * FROM users').all()).results;
  const synced = existing.filter((u) => u.source === 'fieldone');
  const activeSynced = synced.filter((u) => u.active).length;
  // A half-empty read of FieldOne must never lock out half the field force.
  if (activeSynced >= 20 && wanted.size < activeSynced * 0.6) {
    fail(502, `FieldOne returned only ${wanted.size} active staff but ${activeSynced} are active here. Sync stopped to be safe.`);
  }

  const byId = new Map(existing.map((u) => [u.id, u]));
  const byExt = new Map(synced.filter((u) => u.ext_id).map((u) => [u.ext_id, u]));
  const byLogin = new Map(existing.map((u) => [u.login.toLowerCase(), u]));
  const key = await syncedPasswordKey(env);
  const stmts = [];
  const extToId = new Map();
  const result = { added: 0, updated: 0, disabled: 0, unchanged: 0, managersChanged: 0, withoutManager: 0, skipped: [] };

  for (const w of wanted.values()) {
    let u = byExt.get(w.ext_id);
    const owner = byLogin.get(w.login.toLowerCase());
    if (!u && owner?.source === 'fieldone') u = owner;
    if (owner && owner !== u) { result.skipped.push(w.login); continue; } // username already used by a hand-made account
    const hash = await syncedPasswordHash(env, w.password, key);
    if (u) {
      extToId.set(w.ext_id, u.id);
      const same = u.login === w.login && u.name === w.name && u.role === w.role && (u.region || null) === w.region
        && u.pass_salt === SYNCED_SALT && u.pass_hash === hash && u.active === 1 && u.ext_id === w.ext_id;
      if (same) { result.unchanged++; continue; }
      stmts.push(env.DB.prepare('UPDATE users SET login = ?, name = ?, role = ?, region = ?, pass_salt = ?, pass_hash = ?, active = 1, ext_id = ? WHERE id = ?')
        .bind(w.login, w.name, w.role, w.region, SYNCED_SALT, hash, w.ext_id, u.id));
      result.updated++;
    } else {
      const id = crypto.randomUUID();
      extToId.set(w.ext_id, id);
      stmts.push(env.DB.prepare("INSERT INTO users (id, login, name, role, region, pass_salt, pass_hash, source, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'fieldone', ?)")
        .bind(id, w.login, w.name, w.role, w.region, SYNCED_SALT, hash, w.ext_id));
      result.added++;
    }
  }

  const kept = new Set(extToId.values());
  for (const u of synced) {
    if (u.active && !kept.has(u.id)) {
      stmts.push(env.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(u.id));
      result.disabled++;
    }
  }

  // Reporting lines last, once every account exists.
  for (const w of wanted.values()) {
    const id = extToId.get(w.ext_id);
    if (!id) continue;
    const mgr = (w.managerExt && extToId.get(w.managerExt)) || null;
    if (!mgr && w.role !== 'nsh') result.withoutManager++;
    if ((byId.get(id)?.manager_id ?? null) !== mgr) {
      stmts.push(env.DB.prepare('UPDATE users SET manager_id = ? WHERE id = ?').bind(mgr, id));
      if (byId.has(id)) result.managersChanged++;
    }
  }

  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  result.active = extToId.size;
  result.at = new Date().toISOString();
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fieldone_sync', ?)").bind(JSON.stringify(result)).run();
  return result;
}

// ---------------------------------------------------------------------------
// Masters

async function masters(env) {
  const [brands, options] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, sort, active FROM brands ORDER BY sort, name'),
    env.DB.prepare('SELECT id, brand_id, kind, name, sort, verified, active FROM brand_options ORDER BY sort, name'),
  ]);
  const list = brands.results.map((b) => ({ ...b, options: options.results.filter((o) => o.brand_id === b.id) }));
  return json({ brands: list, tintingBrands: TINTING_BRANDS, paymentModes: PAYMENT_MODES, statuses: STATUSES });
}

async function saveBrand(req, env, me) {
  if (!HEAD_ROLES.includes(me.role)) fail(403, 'Only NSH, SH, NH or Admin can edit brands');
  const b = await body(req);
  const name = str(b.name, 60);
  if (!name) fail(400, 'Brand name is required');
  if (b.id) {
    await env.DB.prepare('UPDATE brands SET name = ?, sort = ?, active = ? WHERE id = ?')
      .bind(name, int(b.sort) ?? 100, b.active ? 1 : 0, b.id).run();
  } else {
    await env.DB.prepare('INSERT INTO brands (name, sort) VALUES (?, ?)').bind(name, int(b.sort) ?? 135).run();
  }
  return json({ ok: true });
}

async function saveBrandOption(req, env, me) {
  if (!HEAD_ROLES.includes(me.role)) fail(403, 'Only NSH, SH, NH or Admin can edit brands');
  const b = await body(req);
  const name = str(b.name, 60);
  if (!name) fail(400, 'Name is required');
  if (b.id) {
    await env.DB.prepare('UPDATE brand_options SET name = ?, verified = ?, active = ? WHERE id = ?')
      .bind(name, b.verified ? 1 : 0, b.active ? 1 : 0, b.id).run();
  } else {
    if (!['special', 'exclusive'].includes(b.kind)) fail(400, 'Invalid type');
    await env.DB.prepare('INSERT INTO brand_options (brand_id, kind, name, verified) VALUES (?, ?, ?, 1)')
      .bind(b.brand_id, b.kind, name).run();
  }
  return json({ ok: true });
}

// India Post pincode lookup, proxied so the browser avoids CORS and we can cache it.
async function pincode(pin) {
  if (!/^\d{6}$/.test(pin)) fail(400, 'Pincode must be 6 digits');
  const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { cf: { cacheTtl: 86400 * 30, cacheEverything: true } });
  if (!res.ok) fail(502, 'Pincode service unavailable');
  const data = await res.json().catch(() => null);
  const offices = data?.[0]?.PostOffice || [];
  if (!offices.length) return json({ found: false });
  return json({
    found: true,
    district: offices[0].District,
    state: offices[0].State,
    areas: [...new Set(offices.map((o) => o.Name))],
    towns: [...new Set(offices.map((o) => o.Block).filter((x) => x && x !== 'NA'))],
  });
}

// ---------------------------------------------------------------------------
// Visits

function str(v, max = 200) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const bool = (v) => (v === true || v === 1 || v === '1' ? 1 : v === false || v === 0 || v === '0' ? 0 : null);
const pick = (v, allowed) => (allowed.includes(v) ? v : null);
const strList = (v, allowed) => JSON.stringify((Array.isArray(v) ? v : []).filter((x) => allowed.includes(x)));
const phone = (v) => { const s = str(v, 20); return s ? s.replace(/[^\d+]/g, '') : null; };

async function saveVisit(req, env, me) {
  const v = await body(req);
  if (!/^[\w-]{8,64}$/.test(v.id || '')) fail(400, 'Missing visit id');
  const shop = str(v.shop_name, 120);
  if (!shop) fail(400, 'Shop name is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.visit_date || '')) fail(400, 'Invalid visit date');

  const existing = await env.DB.prepare('SELECT user_id FROM visits WHERE id = ?').bind(v.id).first();
  if (existing && existing.user_id !== me.id) fail(403, 'This visit belongs to someone else');

  const brandNames = new Set((await env.DB.prepare('SELECT name FROM brands').all()).results.map((b) => b.name));
  const brands = (Array.isArray(v.brands) ? v.brands : [])
    .filter((b) => b && brandNames.has(b.brand))
    .slice(0, 20)
    .map((b) => ({
      brand: b.brand,
      other_name: b.brand === 'Others' || b.brand === 'Local brand' ? str(b.other_name, 60) : null,
      dealer_type: pick(b.dealer_type, ['Regular', 'Special', 'Exclusive']) || 'Regular',
      tier: b.dealer_type === 'Regular' ? null : str(b.tier, 60),
    }));

  const row = {
    id: v.id,
    user_id: me.id,
    rep_name: me.name,
    visit_date: v.visit_date,
    created_at: str(v.created_at, 40) || new Date().toISOString(),
    shop_name: shop,
    owner_name: str(v.owner_name, 80),
    address: str(v.address, 300),
    area: str(v.area, 80),
    town: str(v.town, 80),
    district: str(v.district, 80),
    state: str(v.state, 60),
    pincode: str(v.pincode, 6),
    mobile1: phone(v.mobile1),
    mobile2: phone(v.mobile2),
    landline: phone(v.landline),
    brands_json: JSON.stringify(brands),
    turnover_total: num(v.turnover_total),
    turnover_wood: num(v.turnover_wood),
    turnover_metal: num(v.turnover_metal),
    turnover_wall: num(v.turnover_wall),
    turnover_others: num(v.turnover_others),
    has_tinting: bool(v.has_tinting),
    tinting_type: v.has_tinting ? pick(v.tinting_type, ['Water based', 'Dual mode', 'Both']) : null,
    tinting_brands: v.has_tinting ? strList(v.tinting_brands, TINTING_BRANDS) : '[]',
    tinting_brand_other: v.has_tinting ? str(v.tinting_brand_other, 60) : null,
    cd_dealer: bool(v.cd_dealer),
    cd_percent: v.cd_dealer ? num(v.cd_percent) : null,
    credit_days: int(v.credit_days),
    purchase_from: pick(v.purchase_from, ['Direct company', 'Wholesaler', 'Both']),
    payment_modes: strList(v.payment_modes, PAYMENT_MODES),
    payment_other: str(v.payment_other, 60),
    lat: num(v.lat),
    lng: num(v.lng),
    gps_accuracy: num(v.gps_accuracy),
    interest: pick(v.interest, ['Hot', 'Warm', 'Cold']),
    remarks: str(v.remarks, 1000),
    followup_date: /^\d{4}-\d{2}-\d{2}$/.test(v.followup_date || '') ? v.followup_date : null,
  };
  const cols = Object.keys(row);
  const updates = cols.filter((c) => c !== 'id' && c !== 'user_id').map((c) => `${c} = excluded.${c}`);
  await env.DB.prepare(
    `INSERT INTO visits (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
     ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}, synced_at = datetime('now')`
  ).bind(...Object.values(row)).run();
  return json({ ok: true, id: row.id });
}

// Build the WHERE clause shared by list / summary / export.
function visitFilter(me, q) {
  const t = teamCte(me);
  const where = ['v.user_id IN (SELECT id FROM team)'];
  const args = [...t.args];
  const add = (sql, ...a) => { where.push(sql); args.push(...a); };

  if (q.get('from')) add('v.visit_date >= ?', q.get('from'));
  if (q.get('to')) add('v.visit_date <= ?', q.get('to'));
  if (q.get('user')) add('v.user_id = ?', q.get('user'));
  if (q.get('state')) add('v.state = ?', q.get('state'));
  if (q.get('district')) add('v.district LIKE ?', `%${q.get('district')}%`);
  if (q.get('town')) add('(v.town LIKE ? OR v.area LIKE ?)', `%${q.get('town')}%`, `%${q.get('town')}%`);
  if (q.get('interest')) add('v.interest = ?', q.get('interest'));
  if (q.get('status')) add('v.status = ?', q.get('status'));
  if (q.get('tinting') === '1') add('v.has_tinting = 1');
  if (q.get('tinting') === '0') add('(v.has_tinting = 0 OR v.has_tinting IS NULL)');
  if (q.get('cd') === '1') add('v.cd_dealer = 1');
  if (q.get('cd') === '0') add('(v.cd_dealer = 0 OR v.cd_dealer IS NULL)');
  if (q.get('min_turnover')) add('v.turnover_total >= ?', Number(q.get('min_turnover')));
  if (q.get('brand') || q.get('dealer_type')) {
    const cond = [];
    if (q.get('brand')) { cond.push("json_extract(j.value, '$.brand') = ?"); args.push(q.get('brand')); }
    if (q.get('dealer_type')) { cond.push("json_extract(j.value, '$.dealer_type') = ?"); args.push(q.get('dealer_type')); }
    where.push(`EXISTS (SELECT 1 FROM json_each(v.brands_json) j WHERE ${cond.join(' AND ')})`);
  }
  if (q.get('q')) {
    const like = `%${q.get('q')}%`;
    add('(v.shop_name LIKE ? OR v.owner_name LIKE ? OR v.mobile1 LIKE ? OR v.mobile2 LIKE ? OR v.town LIKE ?)', like, like, like, like, like);
  }
  return { cte: t.sql, where: where.join(' AND '), args };
}

const SORTS = {
  date: 'v.visit_date DESC, v.created_at DESC',
  turnover: 'v.turnover_total IS NULL, v.turnover_total DESC',
  shop: 'v.shop_name COLLATE NOCASE',
};

async function listVisits(env, me, q) {
  const f = visitFilter(me, q);
  const limit = Math.min(int(q.get('limit')) || 50, 500);
  const offset = Math.max(int(q.get('offset')) || 0, 0);
  const order = SORTS[q.get('sort')] || SORTS.date;
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`${f.cte} SELECT v.* FROM visits v WHERE ${f.where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...f.args, limit, offset),
    env.DB.prepare(`${f.cte} SELECT COUNT(*) AS n FROM visits v WHERE ${f.where}`).bind(...f.args),
  ]);
  return json({ visits: rows.results.map(parseVisit), total: count.results[0].n });
}

function parseVisit(v) {
  return {
    ...v,
    brands: JSON.parse(v.brands_json || '[]'),
    tinting_brands: JSON.parse(v.tinting_brands || '[]'),
    payment_modes: JSON.parse(v.payment_modes || '[]'),
  };
}

async function visibleVisit(env, me, id) {
  const t = teamCte(me);
  const v = await env.DB.prepare(`${t.sql} SELECT v.* FROM visits v WHERE v.id = ? AND v.user_id IN (SELECT id FROM team)`)
    .bind(...t.args, id).first();
  if (!v) fail(404, 'Visit not found');
  return v;
}

async function getVisit(env, me, id) {
  return json({ visit: parseVisit(await visibleVisit(env, me, id)) });
}

async function setStatus(req, env, me, id) {
  requireRole(me, ...MANAGER_ROLES);
  await visibleVisit(env, me, id);
  const b = await body(req);
  if (!STATUSES.includes(b.status)) fail(400, 'Invalid status');
  await env.DB.prepare("UPDATE visits SET status = ?, status_note = ?, status_by = ?, status_at = datetime('now') WHERE id = ?")
    .bind(b.status, str(b.note, 500), me.name, id).run();
  return json({ ok: true });
}

// Has anyone already visited a shop with this mobile number? Checked company-wide
// (not just the rep's team) so two reps don't scout the same dealer unknowingly.
async function checkDuplicate(env, me, q) {
  const mobile = phone(q.get('mobile'));
  if (!mobile || mobile.length < 8) return json({ matches: [] });
  const { results } = await env.DB.prepare(
    `SELECT id, shop_name, town, rep_name, visit_date FROM visits
     WHERE (mobile1 = ?1 OR mobile2 = ?1) AND id != ?2 ORDER BY visit_date DESC LIMIT 5`
  ).bind(mobile, q.get('exclude') || '').all();
  return json({ matches: results });
}

async function summary(env, me, q) {
  const f = visitFilter(me, q);
  const base = `${f.cte} SELECT %s FROM visits v WHERE ${f.where}`;
  const stmt = (sel, tail = '') => env.DB.prepare(base.replace('%s', sel) + tail).bind(...f.args);
  const [totals, byState, byRep, byBrand, byStatus] = await env.DB.batch([
    stmt(`COUNT(*) n, SUM(v.interest='Hot') hot, SUM(v.interest='Warm') warm, SUM(v.interest='Cold') cold,
          SUM(v.has_tinting=1) tinting, SUM(v.status='Shortlisted') shortlisted, SUM(v.status='Converted') converted,
          ROUND(SUM(v.turnover_total), 2) turnover`),
    stmt("COALESCE(v.state,'(not given)') k, COUNT(*) n", ' GROUP BY k ORDER BY n DESC LIMIT 10'),
    stmt('v.rep_name k, COUNT(*) n', ' GROUP BY v.user_id ORDER BY n DESC LIMIT 10'),
    env.DB.prepare(`${f.cte} SELECT json_extract(j.value,'$.brand') k, COUNT(*) n FROM visits v, json_each(v.brands_json) j
                    WHERE ${f.where} GROUP BY k ORDER BY n DESC`).bind(...f.args),
    stmt('v.status k, COUNT(*) n', ' GROUP BY k ORDER BY n DESC'),
  ]);
  return json({
    totals: totals.results[0],
    byState: byState.results, byRep: byRep.results, byBrand: byBrand.results, byStatus: byStatus.results,
  });
}

const EXPORT_COLS = [
  ['Visit date', 'visit_date'], ['Visited by', 'rep_name'], ['Shop name', 'shop_name'], ['Dealer name', 'owner_name'],
  ['Address', 'address'], ['Area', 'area'], ['Town', 'town'], ['District', 'district'], ['State', 'state'],
  ['Pincode', 'pincode'], ['Mobile 1', 'mobile1'], ['Mobile 2', 'mobile2'], ['Landline', 'landline'],
  ['Brands sold', (v) => v.brands.map(brandLabel).join('; ')],
  ['Turnover total (Cr)', 'turnover_total'], ['Wood (Cr)', 'turnover_wood'], ['Metal (Cr)', 'turnover_metal'],
  ['Wall (Cr)', 'turnover_wall'], ['Others (Cr)', 'turnover_others'],
  ['Tinting machine', (v) => yn(v.has_tinting)], ['Tinting type', 'tinting_type'],
  ['Tinting brands', (v) => [...v.tinting_brands, v.tinting_brand_other].filter(Boolean).join(', ')],
  ['CD dealer', (v) => yn(v.cd_dealer)], ['CD %', 'cd_percent'], ['Credit days', 'credit_days'],
  ['Purchases from', 'purchase_from'],
  ['Payment modes', (v) => [...v.payment_modes, v.payment_other].filter(Boolean).join(', ')],
  ['Interest', 'interest'], ['Remarks', 'remarks'], ['Follow-up date', 'followup_date'],
  ['Status', 'status'], ['Status note', 'status_note'],
  ['Latitude', 'lat'], ['Longitude', 'lng'],
  ['Map', (v) => (v.lat != null ? `https://maps.google.com/?q=${v.lat},${v.lng}` : '')],
  ['Visit ID', 'id'],
];
const yn = (b) => (b === 1 ? 'Yes' : b === 0 ? 'No' : '');
function brandLabel(b) {
  const name = b.other_name ? `${b.brand}: ${b.other_name}` : b.brand;
  return b.dealer_type === 'Regular' ? name : `${name} (${b.dealer_type}${b.tier ? ': ' + b.tier : ''})`;
}

async function exportCsv(env, me, q) {
  const f = visitFilter(me, q);
  const { results } = await env.DB.prepare(`${f.cte} SELECT v.* FROM visits v WHERE ${f.where} ORDER BY ${SORTS.date} LIMIT 20000`)
    .bind(...f.args).all();
  const cell = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    // Leading =,+,-,@ would make Excel treat the cell as a formula.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [EXPORT_COLS.map((c) => cell(c[0])).join(',')];
  for (const r of results.map(parseVisit)) {
    lines.push(EXPORT_COLS.map(([, k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dealer-dash-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Photos — R2 when bound, else a D1 table.

async function putPhoto(req, env, me, visitId, kind) {
  const visit = await env.DB.prepare('SELECT user_id FROM visits WHERE id = ?').bind(visitId).first();
  if (!visit) fail(404, 'Save the visit before uploading photos');
  if (visit.user_id !== me.id) fail(403, 'This visit belongs to someone else');
  const type = req.headers.get('content-type') || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) fail(400, 'Photo must be JPEG, PNG or WebP');
  const data = await req.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_PHOTO_BYTES) fail(400, 'Photo is too large');
  const key = `${visitId}/${kind}`;
  if (env.PHOTOS) await env.PHOTOS.put(key, data, { httpMetadata: { contentType: type } });
  else await env.DB.prepare('INSERT OR REPLACE INTO photos (key, type, data) VALUES (?, ?, ?)').bind(key, type, data).run();
  await env.DB.prepare(`UPDATE visits SET photo_${kind} = 1 WHERE id = ?`).bind(visitId).run();
  return json({ ok: true });
}

async function getPhoto(env, me, visitId, kind) {
  await visibleVisit(env, me, visitId);
  const key = `${visitId}/${kind}`;
  const headers = { 'cache-control': 'private, max-age=86400' };
  if (env.PHOTOS) {
    const obj = await env.PHOTOS.get(key);
    if (!obj) fail(404, 'No photo');
    return new Response(obj.body, { headers: { ...headers, 'content-type': obj.httpMetadata?.contentType || 'image/jpeg' } });
  }
  const row = await env.DB.prepare('SELECT type, data FROM photos WHERE key = ?').bind(key).first();
  if (!row) fail(404, 'No photo');
  return new Response(new Uint8Array(row.data), { headers: { ...headers, 'content-type': row.type } });
}
