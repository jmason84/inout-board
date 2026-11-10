'use strict';

/**
 * IN/OUT Board — multi-tenant clock in/out system.
 *
 * Zero-dependency backend: Node.js built-in HTTP server + node:sqlite.
 *
 * Run:
 *   ADMIN_USER=you ADMIN_PASSWORD='a-long-passphrase' node server.js
 *   (first start only creates that admin; if ADMIN_PASSWORD is unset a random
 *    one is generated and printed once. defaults: PORT=3000, ADMIN_USER=admin)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'inout.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(__dirname, 'assets');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clock_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tenant_id  INTEGER NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  clocked_at INTEGER NOT NULL,
  notes      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS person_sessions (
  token_hash TEXT PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_people_tenant ON people(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_person ON clock_events(person_id);
CREATE INDEX IF NOT EXISTS idx_events_time   ON clock_events(clocked_at);
`);

// Additive migrations for profile fields (safe on existing databases).
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('people', 'email', "TEXT NOT NULL DEFAULT ''");
addColumn('people', 'title', "TEXT NOT NULL DEFAULT ''");
addColumn('people', 'bio', "TEXT NOT NULL DEFAULT ''");
addColumn('people', 'photo', 'TEXT');
addColumn('people', 'handle', 'TEXT');
addColumn('people', 'pass_hash', 'TEXT');
addColumn('people', 'must_change', 'INTEGER NOT NULL DEFAULT 0');
addColumn('people', 'profile_updated_at', 'INTEGER');
addColumn('people', 'office', "TEXT NOT NULL DEFAULT ''");
addColumn('people', 'show_phone', 'INTEGER NOT NULL DEFAULT 0');
addColumn('people', 'show_email', 'INTEGER NOT NULL DEFAULT 0');
addColumn('people', 'show_office', 'INTEGER NOT NULL DEFAULT 1');
addColumn('people', 'avatar_mode', "TEXT NOT NULL DEFAULT 'photo'");
addColumn('people', 'is_manager', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tenants', 'logo', 'TEXT');
addColumn('tenants', 'office', "TEXT NOT NULL DEFAULT ''");
addColumn('tenants', 'phone', "TEXT NOT NULL DEFAULT ''");
addColumn('tenants', 'email', "TEXT NOT NULL DEFAULT ''");
addColumn('tenants', 'website', "TEXT NOT NULL DEFAULT ''");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_people_handle ON people(handle) WHERE handle IS NOT NULL');

// Seed a default tenant + the original board roster (only when empty).
function seed() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM tenants').get();
  if (c > 0) return;

  const now = Date.now();
  const insTenant = db.prepare('INSERT INTO tenants (name, notes, created_at) VALUES (?, ?, ?)');
  const tenantId = Number(insTenant.run('Main Office', 'Default tenant (seeded)', now).lastInsertRowid);

  const insPerson = db.prepare(
    'INSERT INTO people (tenant_id, name, phone, active, created_at) VALUES (?, ?, ?, 1, ?)'
  );
  const roster = [
    ['AA Carlyle', '381-3198'],
    ['Justin', '381-3198'],
    ['Audrea Amstutz', '858-8276'],
    ['CPA Neal Dawn', '343-7700'],
    ['CPA Short Amy', '430-4189'],
    ['Candace Raine', '307-429-221'],
    ['Cecilia Malsom', '593-6490'],
    ['Crystal Hollenbeck', ''],
    ['FBFS LuAnn Hintz', '348-3470'],
    ['FBFS Tom Berger', '348-3470'],
    ['HW HenzlikDean', '721-9328'],
  ];
  for (const [name, phone] of roster) {
    insPerson.run(tenantId, name, phone, now);
  }
  console.log('Seeded default tenant and %d people.', roster.length);
}
seed();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Auth: admin accounts (scrypt) + server-side sessions (HttpOnly cookie)
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword('not-a-real-password'); // equalise timing for unknown users

function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }

function bootstrapAdmin() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get();
  if (c > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(12).toString('base64url'); generated = true; }
  db.prepare('INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), Date.now());
  console.log(`Created first admin account "${username}".`);
  if (generated) console.log(`  Generated password (shown once, change it after login): ${password}`);
}
bootstrapAdmin();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecureReq(req) {
  return COOKIE_SECURE || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}

function sessionCookie(req, value, maxAgeSec) {
  return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isSecureReq(req) ? '; Secure' : ''}`;
}

// Returns { id, username } for a valid session, else null.
function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, s.expires_at
    FROM sessions s JOIN admin_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(sid));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
    return null;
  }
  return { id: row.id, username: row.username };
}

function requireAdmin(res, req) {
  const user = currentUser(req);
  if (!user) {
    sendJSON(res, 401, { error: 'Login required' });
    return null;
  }
  req.user = user;
  return user;
}

// Login throttling: 8 failures per IP per 15 minutes.
const loginFails = new Map();
function throttled(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (e.reset < Date.now()) { loginFails.delete(ip); return false; }
  return e.count >= 8;
}
function noteFailure(ip) {
  const e = loginFails.get(ip);
  if (!e || e.reset < Date.now()) loginFails.set(ip, { count: 1, reset: Date.now() + 15 * 60 * 1000 });
  else e.count++;
}
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

// Cookie auth needs a CSRF guard on state-changing requests.
// Behind a proxy or tunnel (Cloudflare, nginx...) the Host header the app sees is the
// internal one, so we can't just compare Origin to Host. Order of checks:
//   1. Sec-Fetch-Site (sent by every modern browser, set by the browser, not by page script):
//      allow same-origin / none, block same-site siblings and cross-site.
//   2. Otherwise compare Origin to Host, to X-Forwarded-Host (only when TRUST_PROXY=1),
//      and to any ALLOWED_ORIGINS (comma-separated) the admin configured.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  const hosts = [req.headers.host];
  if (TRUST_PROXY) hosts.push(String(req.headers['x-forwarded-host'] || '').split(',')[0].trim());
  const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean)
    .map((v) => { try { return new URL(v).host; } catch { return v; } });
  return hosts.includes(originHost) || extra.includes(originHost);
}

function serveStatic(res, urlPath) {
  // Only allow serving from public/ and assets/.
  let filePath = null;
  if (urlPath === '/' || urlPath === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (urlPath === '/admin' || urlPath === '/admin/') {
    filePath = path.join(PUBLIC_DIR, 'admin.html');
  } else if (urlPath.startsWith('/assets/')) {
    filePath = path.join(ASSETS_DIR, path.basename(urlPath));
  } else {
    filePath = path.join(PUBLIC_DIR, urlPath);
  }

  const resolved = path.resolve(filePath);
  const pubRoot = path.resolve(PUBLIC_DIR);
  const assetsRoot = path.resolve(ASSETS_DIR);
  if (!resolved.startsWith(pubRoot + path.sep) && !resolved.startsWith(assetsRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'same-origin',
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function latestEventPerPerson() {
  // One row per person: their most recent clock event (ties broken by id).
  return db.prepare(`
    SELECT * FROM (
      SELECT ce.*, ROW_NUMBER() OVER (
        PARTITION BY ce.person_id ORDER BY ce.clocked_at DESC, ce.id DESC
      ) AS rn
      FROM clock_events ce
    ) WHERE rn = 1
  `).all();
}

// Which picture to show for someone: their photo, their company's logo, or none (initials).
function resolveAvatar(p) {
  if (p.avatar_mode === 'initials') return null;
  if (p.avatar_mode === 'logo') return photoUrl(p.tenant_logo);
  return photoUrl(p.photo);
}

function avatarKind(p) {
  return resolveAvatar(p) ? (p.avatar_mode === 'logo' ? 'logo' : 'photo') : null;
}

function buildStatus(search, tenantId, matchPhone = true) {
  const events = latestEventPerPerson();
  const eventByPerson = new Map();
  for (const e of events) eventByPerson.set(e.person_id, e);

  const clauses = ['p.active = 1'];
  const params = [];
  if (search) {
    const like = `%${search}%`;
    if (matchPhone) {
      clauses.push('(p.name LIKE ? OR p.phone LIKE ? OR p.email LIKE ? OR t.name LIKE ?)');
      params.push(like, like, like, like);
    } else {
      clauses.push('(p.name LIKE ? OR t.name LIKE ?)');
      params.push(like, like);
    }
  }
  if (tenantId) {
    clauses.push('p.tenant_id = ?');
    params.push(tenantId);
  }

  const rows = db.prepare(`
    SELECT p.id, p.name, p.phone, p.email, p.office, p.title, p.photo, p.avatar_mode, p.is_manager,
           p.show_phone, p.show_email, p.show_office, p.tenant_id,
           t.name AS tenant_name, t.logo AS tenant_logo
    FROM people p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY t.name COLLATE NOCASE, p.name COLLATE NOCASE
  `).all(...params);

  return rows.map((r) => {
    const last = eventByPerson.get(r.id);
    return {
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      office: r.office,
      title: r.title,
      photo_url: photoUrl(r.photo),
      avatar_url: resolveAvatar(r),
      avatar_kind: avatarKind(r),
      avatar_mode: r.avatar_mode,
      show_phone: !!r.show_phone,
      show_email: !!r.show_email,
      show_office: !!r.show_office,
      is_manager: !!r.is_manager,
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      status: last ? last.direction : 'none',
      clocked_at: last ? last.clocked_at : null,
      notes: last ? last.notes : '',
    };
  });
}

// What the PUBLIC directory may show: contact details only when the person opted in.
function publicPerson(p) {
  return {
    id: p.id, name: p.name, title: p.title,
    status: p.status, clocked_at: p.clocked_at,
    avatar_url: p.avatar_url, avatar_kind: p.avatar_kind,
    phone: p.show_phone ? p.phone : '',
    email: p.show_email ? p.email : '',
    office: p.show_office ? p.office : '',
  };
}

function publicTenant(t) {
  return { id: t.id, name: t.name, office: t.office, phone: t.phone, email: t.email, website: t.website, logo_url: photoUrl(t.logo) };
}

function buildDirectory(search, tenantId) {
  const people = buildStatus(search, tenantId, false).slice(0, 500);
  const tenantRows = new Map(db.prepare('SELECT id, name, office, phone, email, website, logo FROM tenants').all().map((t) => [t.id, t]));
  const groups = new Map();
  for (const p of people) {
    if (!groups.has(p.tenant_id)) groups.set(p.tenant_id, { ...publicTenant(tenantRows.get(p.tenant_id)), people: [] });
    groups.get(p.tenant_id).people.push(publicPerson(p));
  }
  return [...groups.values()].map((g) => ({ ...g, total: g.people.length, in_count: g.people.filter((p) => p.status === 'in').length }));
}

// ---------------------------------------------------------------------------
// Reporting helpers (admin dashboard)
// ---------------------------------------------------------------------------

function parseRange(url) {
  const from = Number(url.searchParams.get('from')) || 0;
  const to = Number(url.searchParams.get('to')) || Number.MAX_SAFE_INTEGER;
  return { from, to };
}

function queryEvents({ tenantId, personId, from, to, direction, limit, offset }) {
  const clauses = ['ce.clocked_at >= ?', 'ce.clocked_at <= ?'];
  const params = [from, to];
  if (tenantId) { clauses.push('ce.tenant_id = ?'); params.push(tenantId); }
  if (personId) { clauses.push('ce.person_id = ?'); params.push(personId); }
  if (direction) { clauses.push('ce.direction = ?'); params.push(direction); }
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM clock_events ce WHERE ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT ce.id, ce.person_id, ce.tenant_id, ce.direction, ce.clocked_at, ce.notes,
           p.name AS person_name, t.name AS tenant_name
    FROM clock_events ce
    JOIN people p ON p.id = ce.person_id
    JOIN tenants t ON t.id = ce.tenant_id
    WHERE ${where}
    ORDER BY ce.clocked_at DESC, ce.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { total, rows };
}

// Pair IN -> OUT events into sessions (shifts) with durations.
function buildSessions({ tenantId, personId, from, to }) {
  const clauses = ['ce.clocked_at >= ?', 'ce.clocked_at <= ?'];
  const params = [from, to];
  if (tenantId) { clauses.push('ce.tenant_id = ?'); params.push(tenantId); }
  if (personId) { clauses.push('ce.person_id = ?'); params.push(personId); }
  const events = db.prepare(`
    SELECT ce.person_id, ce.tenant_id, ce.direction, ce.clocked_at,
           p.name AS person_name, t.name AS tenant_name
    FROM clock_events ce
    JOIN people p ON p.id = ce.person_id
    JOIN tenants t ON t.id = ce.tenant_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY ce.person_id, ce.clocked_at, ce.id
  `).all(...params);

  const now = nowMs();
  const sessions = [];
  let open = null;
  let currentPerson = null;
  const flush = () => {
    if (open) {
      open.clock_out = null;
      open.duration_ms = Math.max(0, now - open.clock_in);
      open.open = true;
      sessions.push(open);
      open = null;
    }
  };
  for (const e of events) {
    if (e.person_id !== currentPerson) { flush(); currentPerson = e.person_id; }
    if (e.direction === 'in') {
      if (open) flush(); // double IN: treat previous as still open/unclosed
      open = {
        person_id: e.person_id, person_name: e.person_name,
        tenant_id: e.tenant_id, tenant_name: e.tenant_name,
        clock_in: e.clocked_at,
      };
    } else if (open) {
      sessions.push({ ...open, clock_out: e.clocked_at, duration_ms: e.clocked_at - open.clock_in, open: false });
      open = null;
    }
  }
  flush();
  sessions.sort((a, b) => b.clock_in - a.clock_in);
  return sessions;
}

function csvEscape(v) {
  const s = String(v ?? '');
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function sendCSV(res, filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function filtersFrom(url) {
  const { from, to } = parseRange(url);
  return {
    tenantId: Number(url.searchParams.get('tenant_id')) || null,
    personId: Number(url.searchParams.get('person_id')) || null,
    direction: ['in', 'out'].includes(url.searchParams.get('direction')) ? url.searchParams.get('direction') : null,
    from, to,
  };
}

// ---------------------------------------------------------------------------
// Profiles: photos, person accounts, validation
// ---------------------------------------------------------------------------

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PERSON_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function photoUrl(photo) { return photo ? `/photos/${photo}` : null; }

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Identify an image by its magic bytes (never trust the client's Content-Type; no SVG).
function detectImageExt(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

function unlinkPhoto(name) {
  if (name && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
}

function setPhoto(personId, buf) {
  const ext = detectImageExt(buf);
  if (!ext) return { error: 'Photo must be a JPEG, PNG or WebP image' };
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'Photo is too large (max 2 MB)' };
  const name = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  const old = db.prepare('SELECT photo FROM people WHERE id = ?').get(personId);
  db.prepare('UPDATE people SET photo = ?, profile_updated_at = ? WHERE id = ?').run(name, nowMs(), personId);
  unlinkPhoto(old && old.photo);
  return { photo_url: photoUrl(name) };
}

function clearPhoto(personId) {
  const old = db.prepare('SELECT photo FROM people WHERE id = ?').get(personId);
  db.prepare('UPDATE people SET photo = NULL, profile_updated_at = ? WHERE id = ?').run(nowMs(), personId);
  unlinkPhoto(old && old.photo);
}

function servePhoto(res, name) {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(UPLOAD_DIR, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable', // filename changes on every upload
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// Validate the profile fields a person (or an admin) may set. Only keys present are returned.
// Booleans come back as 0/1, ready for SQLite. `is_manager` can only be set by an admin.
const AVATAR_MODES = ['photo', 'logo', 'initials'];
const BOOL_FIELDS = ['show_phone', 'show_email', 'show_office'];

function cleanProfile(body, { admin = false } = {}) {
  const out = {};
  const limits = { title: 80, phone: 40, email: 120, bio: 600, office: 80 };
  for (const [k, max] of Object.entries(limits)) {
    if (body[k] === undefined) continue;
    const v = String(body[k] ?? '').trim();
    if (v.length > max) return { error: `${k.replace('_', ' ')} must be ${max} characters or fewer` };
    if (k === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: 'Enter a valid email address' };
    out[k] = v;
  }
  for (const k of [...BOOL_FIELDS, ...(admin ? ['is_manager'] : [])]) {
    if (body[k] !== undefined) out[k] = body[k] === true || body[k] === 1 || body[k] === '1' ? 1 : 0;
  }
  if (body.avatar_mode !== undefined) {
    if (!AVATAR_MODES.includes(body.avatar_mode)) return { error: 'avatar_mode must be photo, logo or initials' };
    out.avatar_mode = body.avatar_mode;
  }
  return { fields: out };
}

function updateProfileFields(personId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  // keys come only from cleanProfile's fixed whitelist
  db.prepare(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')}, profile_updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), nowMs(), personId);
}

// Company details (admin, or a person flagged as their tenant's manager).
function cleanTenantFields(body) {
  const out = {};
  const limits = { office: 80, phone: 40, email: 120, website: 200 };
  for (const [k, max] of Object.entries(limits)) {
    if (body[k] === undefined) continue;
    let v = String(body[k] ?? '').trim();
    if (v.length > max) return { error: `${k} must be ${max} characters or fewer` };
    if (k === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: 'Enter a valid email address' };
    if (k === 'website' && v) {
      // refuse other schemes (javascript:, data:, ...); allow bare domains and host:port
      if (/^[a-z][a-z0-9+.\-]*:(?!\d)/i.test(v) && !/^https?:\/\//i.test(v)) return { error: 'Enter a valid website address' };
      if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
      if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(v)) return { error: 'Enter a valid website address' };
    }
    out[k] = v;
  }
  return { fields: out };
}

function updateTenantFields(tenantId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE tenants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), tenantId);
}

function setTenantLogo(tenantId, buf) {
  const ext = detectImageExt(buf);
  if (!ext) return { error: 'Logo must be a JPEG, PNG or WebP image' };
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'Logo is too large (max 2 MB)' };
  const name = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  const old = db.prepare('SELECT logo FROM tenants WHERE id = ?').get(tenantId);
  db.prepare('UPDATE tenants SET logo = ? WHERE id = ?').run(name, tenantId);
  unlinkPhoto(old && old.logo);
  return { logo_url: photoUrl(name) };
}

function clearTenantLogo(tenantId) {
  const old = db.prepare('SELECT logo FROM tenants WHERE id = ?').get(tenantId);
  db.prepare('UPDATE tenants SET logo = NULL WHERE id = ?').run(tenantId);
  unlinkPhoto(old && old.logo);
}

function profileRow(row) {
  return {
    id: row.id, name: row.name, tenant_id: row.tenant_id, tenant_name: row.tenant_name,
    phone: row.phone, email: row.email, title: row.title, bio: row.bio, office: row.office,
    photo_url: photoUrl(row.photo), handle: row.handle || null,
    show_phone: !!row.show_phone, show_email: !!row.show_email, show_office: !!row.show_office,
    avatar_mode: row.avatar_mode, is_manager: !!row.is_manager,
    avatar_url: resolveAvatar({ photo: row.photo, avatar_mode: row.avatar_mode, tenant_logo: row.tenant_logo }),
    avatar_kind: avatarKind({ photo: row.photo, avatar_mode: row.avatar_mode, tenant_logo: row.tenant_logo }),
    tenant: {
      id: row.tenant_id, name: row.tenant_name, logo_url: photoUrl(row.tenant_logo),
      office: row.tenant_office, phone: row.tenant_phone, email: row.tenant_email, website: row.tenant_website,
    },
    has_access: !!row.pass_hash, must_change: !!row.must_change, active: row.active,
    profile_updated_at: row.profile_updated_at || null,
  };
}

function getProfile(personId) {
  const row = db.prepare(`
    SELECT p.*, t.name AS tenant_name, t.logo AS tenant_logo, t.office AS tenant_office,
           t.phone AS tenant_phone, t.email AS tenant_email, t.website AS tenant_website
    FROM people p JOIN tenants t ON t.id = p.tenant_id WHERE p.id = ?
  `).get(personId);
  return row ? profileRow(row) : null;
}

function makeHandle(name, personId) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30) || 'user';
  let candidate = base;
  for (let i = 2; db.prepare('SELECT id FROM people WHERE handle = ? AND id != ?').get(candidate, personId); i++) candidate = `${base}${i}`;
  return candidate;
}

// Person (non-admin) session, separate cookie from admin sessions.
function currentPerson(req) {
  const sid = parseCookies(req).psid;
  if (!sid) return null;
  const row = db.prepare(`
    SELECT p.id, ps.expires_at FROM person_sessions ps JOIN people p ON p.id = ps.person_id
    WHERE ps.token_hash = ? AND p.active = 1 AND p.pass_hash IS NOT NULL
  `).get(sha256(sid));
  if (!row) return null;
  if (row.expires_at < nowMs()) { db.prepare('DELETE FROM person_sessions WHERE token_hash = ?').run(sha256(sid)); return null; }
  return { id: row.id };
}

function requirePerson(res, req) {
  const person = currentPerson(req);
  if (!person) { sendJSON(res, 401, { error: 'Please sign in' }); return null; }
  return person;
}

function personCookie(req, value, maxAgeSec) {
  return `psid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isSecureReq(req) ? '; Secure' : ''}`;
}

// Photos must be removed from disk when their person rows are cascade-deleted.
function photosForTenant(tenantId) {
  const files = db.prepare('SELECT photo FROM people WHERE tenant_id = ? AND photo IS NOT NULL').all(tenantId).map((r) => r.photo);
  const t = db.prepare('SELECT logo FROM tenants WHERE id = ?').get(tenantId);
  if (t && t.logo) files.push(t.logo);
  return files;
}

// ---------------------------------------------------------------------------
// Settings (admin-controlled, whitelisted)
// ---------------------------------------------------------------------------

const SETTING_DEFAULTS = { kiosk_layout: 'table', kiosk_mode: 'browse' };
const SETTING_OPTIONS = {
  kiosk_layout: ['table', 'list', 'cards', 'tiles', 'board'],
  kiosk_mode: ['search', 'browse'],
};

function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (SETTING_OPTIONS[r.key] && SETTING_OPTIONS[r.key].includes(r.value)) out[r.key] = r.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Normalise /api/<resource>/<numeric id> to /api/<resource>/:id for routing.
  const idMatch = url.pathname.match(/^\/api\/(tenants|people|events|admin\/users)\/(\d+)$/);
  const subMatch = url.pathname.match(/^\/api\/(people|tenants)\/(\d+)\/(photo|access|logo)$/);
  const route = idMatch
    ? `${req.method} /api/${idMatch[1]}/:id`
    : subMatch ? `${req.method} /api/${subMatch[1]}/:id/${subMatch[3]}`
    : `${req.method} ${url.pathname}`;
  const routeId = idMatch ? Number(idMatch[2]) : (subMatch ? Number(subMatch[2]) : null);

  try {
    // ---- Static files ------------------------------------------------------
    if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
      return servePhoto(res, url.pathname.slice('/photos/'.length));
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (url.pathname === '/me' || url.pathname === '/me/') return serveStatic(res, '/me.html');
      return serveStatic(res, url.pathname);
    }

    // ---- CSRF guard for state-changing requests -----------------------------
    if (req.method !== 'GET' && !sameOrigin(req)) {
      return sendJSON(res, 403, { error: 'Cross-origin request blocked' });
    }

    // ---- Auth --------------------------------------------------------------
    if (route === 'POST /api/auth/login') {
      const ip = clientIp(req);
      if (throttled(ip)) return sendJSON(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = db.prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ?').get(username);
      const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && !!user;
      if (!ok) { noteFailure(ip); return sendJSON(res, 401, { error: 'Invalid username or password' }); }
      loginFails.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      const now = nowMs();
      db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sha256(token), user.id, now, now + SESSION_TTL_MS);
      db.prepare('UPDATE admin_users SET last_login = ? WHERE id = ?').run(now, user.id);
      res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, { username: user.username });
    }

    if (route === 'POST /api/auth/logout') {
      const sid = parseCookies(req).sid;
      if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return sendJSON(res, 200, { ok: true });
    }

    if (route === 'GET /api/auth/me') {
      const user = currentUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Login required' });
      return sendJSON(res, 200, { username: user.username });
    }

    if (route === 'POST /api/auth/password') {
      const user = requireAdmin(res, req); if (!user) return;
      const body = await readBody(req);
      const row = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(user.id);
      if (!verifyPassword(String(body.current || ''), row.password_hash)) {
        return sendJSON(res, 400, { error: 'Current password is incorrect' });
      }
      const next = String(body.next || '');
      if (next.length < 10) return sendJSON(res, 400, { error: 'New password must be at least 10 characters' });
      db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
      // Sign out every other session for this account.
      const sid = parseCookies(req).sid;
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, sha256(sid));
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Admin accounts ----------------------------------------------------
    if (route === 'GET /api/admin/users') {
      if (!requireAdmin(res, req)) return;
      return sendJSON(res, 200, db.prepare(
        'SELECT id, username, created_at, last_login FROM admin_users ORDER BY username COLLATE NOCASE').all());
    }

    if (route === 'POST /api/admin/users') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9._@-]{3,40}$/.test(username)) {
        return sendJSON(res, 400, { error: 'Username must be 3-40 characters (letters, numbers, . _ @ -)' });
      }
      if (password.length < 10) return sendJSON(res, 400, { error: 'Password must be at least 10 characters' });
      if (db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username)) {
        return sendJSON(res, 409, { error: 'That username already exists' });
      }
      const id = Number(db.prepare('INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(username, hashPassword(password), nowMs()).lastInsertRowid);
      return sendJSON(res, 201, { id, username });
    }

    if (route === 'DELETE /api/admin/users/:id') {
      const user = requireAdmin(res, req); if (!user) return;
      if (routeId === user.id) return sendJSON(res, 400, { error: "You can't delete your own account" });
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get();
      if (c <= 1) return sendJSON(res, 400, { error: 'At least one admin must remain' });
      db.prepare('DELETE FROM admin_users WHERE id = ?').run(routeId);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Admin: a tenant's logo ---------------------------------------------------
    if (route === 'PUT /api/tenants/:id/logo') {
      if (!requireAdmin(res, req)) return;
      if (!db.prepare('SELECT id FROM tenants WHERE id = ?').get(routeId)) return sendJSON(res, 404, { error: 'tenant not found' });
      const r = setTenantLogo(routeId, await readRaw(req, MAX_PHOTO_BYTES + 1024));
      return r.error ? sendJSON(res, 400, r) : sendJSON(res, 200, r);
    }
    if (route === 'DELETE /api/tenants/:id/logo') {
      if (!requireAdmin(res, req)) return;
      clearTenantLogo(routeId);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Admin: a person's photo & account access ----------------------------
    if (route === 'PUT /api/people/:id/photo') {
      if (!requireAdmin(res, req)) return;
      if (!db.prepare('SELECT id FROM people WHERE id = ?').get(routeId)) return sendJSON(res, 404, { error: 'person not found' });
      const r = setPhoto(routeId, await readRaw(req, MAX_PHOTO_BYTES + 1024));
      return r.error ? sendJSON(res, 400, r) : sendJSON(res, 200, r);
    }
    if (route === 'DELETE /api/people/:id/photo') {
      if (!requireAdmin(res, req)) return;
      clearPhoto(routeId);
      return sendJSON(res, 200, { ok: true });
    }
    if (route === 'POST /api/people/:id/access') {
      // Create or reset a person's sign-in. Returns a one-time temporary password.
      if (!requireAdmin(res, req)) return;
      const person = db.prepare('SELECT id, name, handle FROM people WHERE id = ?').get(routeId);
      if (!person) return sendJSON(res, 404, { error: 'person not found' });
      const handle = person.handle || makeHandle(person.name, person.id);
      const temp = crypto.randomBytes(9).toString('base64url');
      db.prepare('UPDATE people SET handle = ?, pass_hash = ?, must_change = 1 WHERE id = ?').run(handle, hashPassword(temp), person.id);
      db.prepare('DELETE FROM person_sessions WHERE person_id = ?').run(person.id);
      return sendJSON(res, 200, { handle, temp_password: temp });
    }
    if (route === 'DELETE /api/people/:id/access') {
      if (!requireAdmin(res, req)) return;
      db.prepare('UPDATE people SET pass_hash = NULL, must_change = 0 WHERE id = ?').run(routeId);
      db.prepare('DELETE FROM person_sessions WHERE person_id = ?').run(routeId);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Person self-service (/me) -------------------------------------------
    if (route === 'POST /api/me/login') {
      const ip = 'p:' + clientIp(req);
      if (throttled(ip)) return sendJSON(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const body = await readBody(req);
      const handle = String(body.handle || '').trim().toLowerCase();
      const row = db.prepare('SELECT id, pass_hash, active FROM people WHERE handle = ?').get(handle);
      const ok = verifyPassword(String(body.password || ''), row && row.pass_hash ? row.pass_hash : DUMMY_HASH)
        && !!row && !!row.pass_hash && row.active === 1;
      if (!ok) { noteFailure(ip); return sendJSON(res, 401, { error: 'Invalid sign-in or password' }); }
      loginFails.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      const now = nowMs();
      db.prepare('INSERT INTO person_sessions (token_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sha256(token), row.id, now, now + PERSON_SESSION_TTL_MS);
      res.setHeader('Set-Cookie', personCookie(req, token, PERSON_SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, getProfile(row.id));
    }
    if (route === 'POST /api/me/logout') {
      const sid = parseCookies(req).psid;
      if (sid) db.prepare('DELETE FROM person_sessions WHERE token_hash = ?').run(sha256(sid));
      res.setHeader('Set-Cookie', personCookie(req, '', 0));
      return sendJSON(res, 200, { ok: true });
    }
    if (route === 'GET /api/me') {
      const me = requirePerson(res, req); if (!me) return;
      return sendJSON(res, 200, getProfile(me.id));
    }
    if (route === 'PUT /api/me') {
      const me = requirePerson(res, req); if (!me) return;
      const prof = cleanProfile(await readBody(req)); // is_manager is admin-only, ignored here
      if (prof.error) return sendJSON(res, 400, { error: prof.error });
      updateProfileFields(me.id, prof.fields);
      return sendJSON(res, 200, getProfile(me.id));
    }
    // A person flagged as their tenant's manager can maintain the company profile.
    if (route === 'PUT /api/me/tenant' || route === 'PUT /api/me/tenant/logo' || route === 'DELETE /api/me/tenant/logo') {
      const me = requirePerson(res, req); if (!me) return;
      const row = db.prepare('SELECT tenant_id, is_manager FROM people WHERE id = ?').get(me.id);
      if (!row.is_manager) return sendJSON(res, 403, { error: 'Only a tenant manager can change the company profile' });
      if (route === 'PUT /api/me/tenant') {
        const tf = cleanTenantFields(await readBody(req));
        if (tf.error) return sendJSON(res, 400, { error: tf.error });
        updateTenantFields(row.tenant_id, tf.fields);
        return sendJSON(res, 200, getProfile(me.id));
      }
      if (route === 'DELETE /api/me/tenant/logo') { clearTenantLogo(row.tenant_id); return sendJSON(res, 200, { ok: true }); }
      const r = setTenantLogo(row.tenant_id, await readRaw(req, MAX_PHOTO_BYTES + 1024));
      return r.error ? sendJSON(res, 400, r) : sendJSON(res, 200, r);
    }
    if (route === 'PUT /api/me/photo') {
      const me = requirePerson(res, req); if (!me) return;
      const r = setPhoto(me.id, await readRaw(req, MAX_PHOTO_BYTES + 1024));
      return r.error ? sendJSON(res, 400, r) : sendJSON(res, 200, r);
    }
    if (route === 'DELETE /api/me/photo') {
      const me = requirePerson(res, req); if (!me) return;
      clearPhoto(me.id);
      return sendJSON(res, 200, { ok: true });
    }
    if (route === 'POST /api/me/password') {
      const me = requirePerson(res, req); if (!me) return;
      const body = await readBody(req);
      const row = db.prepare('SELECT pass_hash FROM people WHERE id = ?').get(me.id);
      if (!verifyPassword(String(body.current || ''), row.pass_hash)) return sendJSON(res, 400, { error: 'Current password is incorrect' });
      const next = String(body.next || '');
      if (next.length < 8) return sendJSON(res, 400, { error: 'New password must be at least 8 characters' });
      db.prepare('UPDATE people SET pass_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(next), me.id);
      db.prepare('DELETE FROM person_sessions WHERE person_id = ? AND token_hash != ?').run(me.id, sha256(parseCookies(req).psid));
      return sendJSON(res, 200, { ok: true });
    }
    if (route === 'GET /api/me/shifts') {
      const me = requirePerson(res, req); if (!me) return;
      const sessions = buildSessions({ tenantId: null, personId: me.id, from: nowMs() - 30 * 86400000, to: Number.MAX_SAFE_INTEGER });
      return sendJSON(res, 200, sessions.slice(0, 30).map(({ clock_in, clock_out, duration_ms, open }) => ({ clock_in, clock_out, duration_ms, open })));
    }

    // ---- Settings ------------------------------------------------------------
    if (route === 'GET /api/admin/settings') {
      if (!requireAdmin(res, req)) return;
      return sendJSON(res, 200, getSettings());
    }
    if (route === 'PUT /api/admin/settings') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(body)) {
        if (!SETTING_OPTIONS[k]) return sendJSON(res, 400, { error: `Unknown setting: ${k}` });
        if (!SETTING_OPTIONS[k].includes(v)) return sendJSON(res, 400, { error: `Invalid value for ${k}` });
        up.run(k, v);
      }
      return sendJSON(res, 200, getSettings());
    }

    // ---- Public directory: everyone, grouped by tenant, honouring each person's privacy choices ----
    if (route === 'GET /api/directory') {
      const st = getSettings();
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      const tenantId = Number(url.searchParams.get('tenant_id')) || null;
      const base = { layout: st.kiosk_layout, mode: st.kiosk_mode };
      if (!q && st.kiosk_mode !== 'browse') return sendJSON(res, 200, { ...base, tenants: [] });
      return sendJSON(res, 200, { ...base, tenants: buildDirectory(q, tenantId) });
    }

    // ---- Admin: bulk-set what people show publicly ---------------------------------
    if (route === 'POST /api/admin/visibility') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      if (!BOOL_FIELDS.includes(body.field)) return sendJSON(res, 400, { error: 'field must be show_phone, show_email or show_office' });
      const val = body.value === true ? 1 : 0;
      const tid = Number(body.tenant_id) || null;
      const r = tid
        ? db.prepare(`UPDATE people SET ${body.field} = ? WHERE tenant_id = ?`).run(val, tid)
        : db.prepare(`UPDATE people SET ${body.field} = ?`).run(val);
      return sendJSON(res, 200, { updated: Number(r.changes) });
    }

    // ---- Health ------------------------------------------------------------
    if (route === 'GET /api/health') {
      return sendJSON(res, 200, { ok: true, time: nowMs() });
    }

    // ---- Tenants -----------------------------------------------------------
    if (route === 'GET /api/tenants') {
      if (!requireAdmin(res, req)) return;
      const rows = db.prepare(
        'SELECT id, name, notes, office, phone, email, website, logo, created_at FROM tenants ORDER BY name COLLATE NOCASE'
      ).all();
      return sendJSON(res, 200, rows.map(({ logo, ...t }) => ({ ...t, logo_url: photoUrl(logo) })));
    }

    if (route === 'POST /api/tenants') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      if (!body.name || !String(body.name).trim()) {
        return sendJSON(res, 400, { error: 'name is required' });
      }
      const tf = cleanTenantFields(body);
      if (tf.error) return sendJSON(res, 400, { error: tf.error });
      const id = Number(
        db.prepare('INSERT INTO tenants (name, notes, created_at) VALUES (?, ?, ?)')
          .run(String(body.name).trim(), String(body.notes || ''), nowMs()).lastInsertRowid
      );
      updateTenantFields(id, tf.fields);
      return sendJSON(res, 201, { id, name: String(body.name).trim() });
    }

    if (route === 'PUT /api/tenants/:id' || route === 'DELETE /api/tenants/:id') {
      if (!requireAdmin(res, req)) return;
      const id = routeId;
      if (req.method === 'DELETE') {
        const photos = photosForTenant(id);
        db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
        photos.forEach(unlinkPhoto);
        return sendJSON(res, 200, { ok: true });
      }
      const body = await readBody(req);
      if (!String(body.name || '').trim()) return sendJSON(res, 400, { error: 'name is required' });
      const tf = cleanTenantFields(body);
      if (tf.error) return sendJSON(res, 400, { error: tf.error });
      db.prepare('UPDATE tenants SET name = ?, notes = ? WHERE id = ?')
        .run(String(body.name || '').trim(), String(body.notes || ''), id);
      updateTenantFields(id, tf.fields);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- People ------------------------------------------------------------
    if (route === 'GET /api/people') {
      if (!requireAdmin(res, req)) return;
      const search = url.searchParams.get('search') || '';
      const tenantId = url.searchParams.get('tenant_id') || null;
      const clauses = ['1=1'];
      const params = [];
      if (search) {
        clauses.push('(p.name LIKE ? OR p.phone LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like);
      }
      if (tenantId) {
        clauses.push('p.tenant_id = ?');
        params.push(Number(tenantId));
      }
      const rows = db.prepare(`
        SELECT p.id, p.name, p.phone, p.email, p.office, p.title, p.photo, p.handle, p.tenant_id, p.active,
               p.show_phone, p.show_email, p.show_office, p.avatar_mode, p.is_manager,
               (p.pass_hash IS NOT NULL) AS has_access, t.name AS tenant_name, t.logo AS tenant_logo
        FROM people p JOIN tenants t ON t.id = p.tenant_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY t.name COLLATE NOCASE, p.name COLLATE NOCASE
      `).all(...params);
      return sendJSON(res, 200, rows.map(({ photo, tenant_logo, ...r }) => ({
        ...r, photo_url: photoUrl(photo), avatar_url: resolveAvatar({ photo, avatar_mode: r.avatar_mode, tenant_logo }),
        avatar_kind: avatarKind({ photo, avatar_mode: r.avatar_mode, tenant_logo }),
        has_access: !!r.has_access, show_phone: !!r.show_phone, show_email: !!r.show_email, show_office: !!r.show_office, is_manager: !!r.is_manager,
      })));
    }

    if (route === 'GET /api/people/:id') {
      if (!requireAdmin(res, req)) return;
      const prof = getProfile(routeId);
      return prof ? sendJSON(res, 200, prof) : sendJSON(res, 404, { error: 'person not found' });
    }

    if (route === 'POST /api/people') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      if (!body.name || !String(body.name).trim()) {
        return sendJSON(res, 400, { error: 'name is required' });
      }
      const tenantId = Number(body.tenant_id);
      const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) return sendJSON(res, 400, { error: 'tenant_id does not exist' });
      const id = Number(
        db.prepare(
          'INSERT INTO people (tenant_id, name, phone, active, created_at) VALUES (?, ?, ?, 1, ?)'
        ).run(tenantId, String(body.name).trim(), String(body.phone || ''), nowMs()).lastInsertRowid
      );
      return sendJSON(res, 201, { id, name: String(body.name).trim() });
    }

    if (route === 'PUT /api/people/:id' || route === 'DELETE /api/people/:id') {
      if (!requireAdmin(res, req)) return;
      const id = routeId;
      if (req.method === 'DELETE') {
        const old = db.prepare('SELECT photo FROM people WHERE id = ?').get(id);
        db.prepare('DELETE FROM people WHERE id = ?').run(id);
        unlinkPhoto(old && old.photo);
        return sendJSON(res, 200, { ok: true });
      }
      const body = await readBody(req);
      if (!String(body.name || '').trim()) return sendJSON(res, 400, { error: 'name is required' });
      if (!db.prepare('SELECT id FROM tenants WHERE id = ?').get(Number(body.tenant_id))) {
        return sendJSON(res, 400, { error: 'tenant_id does not exist' });
      }
      const prof = cleanProfile(body, { admin: true });
      if (prof.error) return sendJSON(res, 400, { error: prof.error });
      db.prepare('UPDATE people SET tenant_id = ?, name = ?, active = ? WHERE id = ?')
        .run(Number(body.tenant_id), String(body.name || '').trim(), body.active ? 1 : 0, id);
      updateProfileFields(id, prof.fields);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Clock in / out ----------------------------------------------------
    if (route === 'POST /api/clock') {
      const body = await readBody(req);
      const personId = Number(body.person_id);
      const direction = String(body.direction || '').toLowerCase();
      if (!['in', 'out'].includes(direction)) {
        return sendJSON(res, 400, { error: 'direction must be "in" or "out"' });
      }
      const person = db.prepare(
        'SELECT id, tenant_id FROM people WHERE id = ? AND active = 1'
      ).get(personId);
      if (!person) return sendJSON(res, 404, { error: 'person not found or inactive' });

      const last = db.prepare(
        'SELECT direction FROM clock_events WHERE person_id = ? ORDER BY clocked_at DESC, id DESC LIMIT 1'
      ).get(personId);
      if (last && last.direction === direction) {
        return sendJSON(res, 409, { error: `Already clocked ${direction.toUpperCase()}` });
      }
      const id = Number(
        db.prepare(
          'INSERT INTO clock_events (person_id, tenant_id, direction, clocked_at, notes) VALUES (?, ?, ?, ?, ?)'
        ).run(personId, person.tenant_id, direction, nowMs(), '').lastInsertRowid
      );
      return sendJSON(res, 201, { id, person_id: personId, direction, clocked_at: nowMs() });
    }

    if (route === 'GET /api/status') {
      if (!requireAdmin(res, req)) return;
      const search = url.searchParams.get('search') || '';
      const tenantId = url.searchParams.get('tenant_id') || null;
      const result = buildStatus(search, tenantId ? Number(tenantId) : null);
      return sendJSON(res, 200, result);
    }

    if (route === 'GET /api/events') {
      if (!requireAdmin(res, req)) return;
      const f = filtersFrom(url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const { total, rows } = queryEvents({ ...f, limit, offset });
      // Back-compat: plain array unless paging metadata requested.
      if (url.searchParams.get('paged') === '1') return sendJSON(res, 200, { total, rows });
      return sendJSON(res, 200, rows);
    }

    if (route === 'GET /api/events.csv') {
      if (!requireAdmin(res, req)) return;
      const { rows } = queryEvents({ ...filtersFrom(url), limit: 100000, offset: 0 });
      return sendCSV(res, 'clock-events.csv',
        ['Time', 'Person', 'Tenant', 'Direction', 'Notes'],
        rows.map((e) => [new Date(e.clocked_at).toISOString(), e.person_name, e.tenant_name, e.direction.toUpperCase(), e.notes]));
    }

    if (route === 'GET /api/sessions' || route === 'GET /api/sessions.csv') {
      if (!requireAdmin(res, req)) return;
      const sessions = buildSessions(filtersFrom(url));
      if (url.pathname.endsWith('.csv')) {
        return sendCSV(res, 'time-sessions.csv',
          ['Person', 'Tenant', 'Clock in', 'Clock out', 'Minutes', 'Still in'],
          sessions.map((x) => [x.person_name, x.tenant_name, new Date(x.clock_in).toISOString(),
            x.clock_out ? new Date(x.clock_out).toISOString() : '', Math.round(x.duration_ms / 60000), x.open ? 'yes' : 'no']));
      }
      const totalMs = sessions.reduce((a, x) => a + x.duration_ms, 0);
      return sendJSON(res, 200, { sessions, total_ms: totalMs });
    }

    // Manual / corrected entry by an admin (e.g. someone forgot to clock out).
    if (route === 'POST /api/events') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      const direction = String(body.direction || '').toLowerCase();
      const at = Number(body.clocked_at);
      if (!['in', 'out'].includes(direction)) return sendJSON(res, 400, { error: 'direction must be "in" or "out"' });
      if (!Number.isFinite(at) || at <= 0) return sendJSON(res, 400, { error: 'clocked_at (ms) is required' });
      const person = db.prepare('SELECT id, tenant_id FROM people WHERE id = ?').get(Number(body.person_id));
      if (!person) return sendJSON(res, 404, { error: 'person not found' });
      const id = Number(db.prepare(
        'INSERT INTO clock_events (person_id, tenant_id, direction, clocked_at, notes) VALUES (?, ?, ?, ?, ?)'
      ).run(person.id, person.tenant_id, direction, at, String(body.notes || 'Manual entry (admin)')).lastInsertRowid);
      return sendJSON(res, 201, { id });
    }

    if (route === 'DELETE /api/events/:id') {
      if (!requireAdmin(res, req)) return;
      db.prepare('DELETE FROM clock_events WHERE id = ?').run(routeId);
      return sendJSON(res, 200, { ok: true });
    }

    // Dashboard overview: totals, per-tenant roll-up, and recent activity.
    if (route === 'GET /api/admin/overview') {
      if (!requireAdmin(res, req)) return;
      const status = buildStatus('', null);
      const startOfDay = Number(url.searchParams.get('day_start')) || new Date().setHours(0, 0, 0, 0);
      const todaySessions = buildSessions({ from: startOfDay, to: Number.MAX_SAFE_INTEGER, tenantId: null, personId: null });
      const tenants = db.prepare('SELECT id, name, notes, created_at FROM tenants ORDER BY name COLLATE NOCASE').all();
      const perTenant = tenants.map((t) => {
        const ppl = status.filter((p) => p.tenant_id === t.id);
        return {
          ...t,
          people: ppl.length,
          in_count: ppl.filter((p) => p.status === 'in').length,
          out_count: ppl.filter((p) => p.status !== 'in').length,
          today_ms: todaySessions.filter((x) => x.tenant_id === t.id).reduce((a, x) => a + x.duration_ms, 0),
        };
      });
      const recent = queryEvents({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 10, offset: 0 }).rows;
      return sendJSON(res, 200, {
        totals: {
          tenants: tenants.length,
          people: status.length,
          in_now: status.filter((p) => p.status === 'in').length,
          today_ms: todaySessions.reduce((a, x) => a + x.duration_ms, 0),
        },
        tenants: perTenant,
        recent,
      });
    }

    // ---- Reset all to OUT (admin convenience) ------------------------------
    if (route === 'POST /api/reset') {
      if (!requireAdmin(res, req)) return;
      // Clock everyone OUT now (one event per active person currently IN).
      const people = db.prepare(
        'SELECT id, tenant_id FROM people WHERE active = 1'
      ).all();
      const latest = latestEventPerPerson();
      const inMap = new Map();
      for (const e of latest) inMap.set(e.person_id, e.direction);
      const t = nowMs();
      const ins = db.prepare(
        'INSERT INTO clock_events (person_id, tenant_id, direction, clocked_at, notes) VALUES (?, ?, ?, ?, ?)'
      );
      let count = 0;
      for (const p of people) {
        if (inMap.get(p.id) === 'in') {
          ins.run(p.id, p.tenant_id, 'out', t, 'End-of-day reset');
          count++;
        }
      }
      return sendJSON(res, 200, { ok: true, clocked_out: count });
    }

    // ---- 404 ---------------------------------------------------------------
    return sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err && err.message === 'Invalid JSON') {
      return sendJSON(res, 400, { error: 'Invalid JSON body' });
    }
    if (err && err.message === 'Body too large') {
      return sendJSON(res, 413, { error: 'Body too large' });
    }
    console.error(err);
    return sendJSON(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`IN/OUT Board server listening on http://${HOST}:${PORT}`);
  console.log('Kiosk: /   Admin console: /admin');
});
