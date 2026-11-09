'use strict';

/**
 * IN/OUT Board — multi-tenant clock in/out system.
 *
 * Zero-dependency backend: Node.js built-in HTTP server + node:sqlite.
 *
 * Run:
 *   ADMIN_TOKEN=your-secret-token node server.js
 *   (defaults: PORT=3000, ADMIN_TOKEN=change-me-admin-token)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-admin-token';
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'inout.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(__dirname, 'assets');

fs.mkdirSync(DATA_DIR, { recursive: true });

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

CREATE INDEX IF NOT EXISTS idx_people_tenant ON people(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_person ON clock_events(person_id);
CREATE INDEX IF NOT EXISTS idx_events_time   ON clock_events(clocked_at);
`);

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

function isAdmin(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7) === ADMIN_TOKEN;
  }
  const headerToken = req.headers['x-admin-token'];
  return typeof headerToken === 'string' && headerToken === ADMIN_TOKEN;
}

function requireAdmin(res, req) {
  if (!isAdmin(req)) {
    sendJSON(res, 401, { error: 'Unauthorized: admin token required' });
    return false;
  }
  return true;
}

function serveStatic(res, urlPath) {
  // Only allow serving from public/ and assets/.
  let filePath = null;
  if (urlPath === '/' || urlPath === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (urlPath.startsWith('/assets/')) {
    filePath = path.join(ASSETS_DIR, path.basename(urlPath));
  } else {
    filePath = path.join(PUBLIC_DIR, urlPath);
  }

  const resolved = path.resolve(filePath);
  const pubRoot = path.resolve(PUBLIC_DIR);
  const assetsRoot = path.resolve(ASSETS_DIR);
  if (!resolved.startsWith(pubRoot) && !resolved.startsWith(assetsRoot)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
  // Returns, for every active person, their most recent clock event (or null).
  return db.prepare(`
    SELECT ce.*
    FROM clock_events ce
    JOIN (
      SELECT person_id, MAX(clocked_at) AS mx
      FROM clock_events
      GROUP BY person_id
    ) latest ON latest.person_id = ce.person_id AND latest.mx = ce.clocked_at
  `).all();
}

function buildStatus(search, tenantId) {
  const events = latestEventPerPerson();
  const eventByPerson = new Map();
  for (const e of events) eventByPerson.set(e.person_id, e);

  const clauses = ['p.active = 1'];
  const params = [];
  if (search) {
    clauses.push('(p.name LIKE ? OR p.phone LIKE ? OR t.name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (tenantId) {
    clauses.push('p.tenant_id = ?');
    params.push(tenantId);
  }

  const rows = db.prepare(`
    SELECT p.id, p.name, p.phone, p.tenant_id, t.name AS tenant_name
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
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      status: last ? last.direction : 'none',
      clocked_at: last ? last.clocked_at : null,
      notes: last ? last.notes : '',
    };
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // ---- Static files ------------------------------------------------------
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(res, url.pathname);
    }

    // ---- Health ------------------------------------------------------------
    if (route === 'GET /api/health') {
      return sendJSON(res, 200, { ok: true, time: nowMs() });
    }

    // ---- Tenants -----------------------------------------------------------
    if (route === 'GET /api/tenants') {
      const rows = db.prepare(
        'SELECT id, name, notes, created_at FROM tenants ORDER BY name COLLATE NOCASE'
      ).all();
      return sendJSON(res, 200, rows);
    }

    if (route === 'POST /api/tenants') {
      if (!requireAdmin(res, req)) return;
      const body = await readBody(req);
      if (!body.name || !String(body.name).trim()) {
        return sendJSON(res, 400, { error: 'name is required' });
      }
      const id = Number(
        db.prepare('INSERT INTO tenants (name, notes, created_at) VALUES (?, ?, ?)')
          .run(String(body.name).trim(), String(body.notes || ''), nowMs()).lastInsertRowid
      );
      return sendJSON(res, 201, { id, name: String(body.name).trim() });
    }

    if (route === 'PUT /api/tenants/:id' || route === 'DELETE /api/tenants/:id') {
      if (!requireAdmin(res, req)) return;
      const id = Number(url.pathname.split('/').pop());
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
        return sendJSON(res, 200, { ok: true });
      }
      const body = await readBody(req);
      db.prepare('UPDATE tenants SET name = ?, notes = ? WHERE id = ?')
        .run(String(body.name || '').trim(), String(body.notes || ''), id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- People ------------------------------------------------------------
    if (route === 'GET /api/people') {
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
        SELECT p.id, p.name, p.phone, p.tenant_id, p.active, t.name AS tenant_name
        FROM people p JOIN tenants t ON t.id = p.tenant_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY t.name COLLATE NOCASE, p.name COLLATE NOCASE
      `).all(...params);
      return sendJSON(res, 200, rows);
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
      const id = Number(url.pathname.split('/').pop());
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM people WHERE id = ?').run(id);
        return sendJSON(res, 200, { ok: true });
      }
      const body = await readBody(req);
      db.prepare('UPDATE people SET tenant_id = ?, name = ?, phone = ?, active = ? WHERE id = ?')
        .run(
          Number(body.tenant_id),
          String(body.name || '').trim(),
          String(body.phone || ''),
          body.active ? 1 : 0,
          id
        );
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

      const id = Number(
        db.prepare(
          'INSERT INTO clock_events (person_id, tenant_id, direction, clocked_at, notes) VALUES (?, ?, ?, ?, ?)'
        ).run(personId, person.tenant_id, direction, nowMs(), String(body.notes || '')).lastInsertRowid
      );
      return sendJSON(res, 201, { id, person_id: personId, direction, clocked_at: nowMs() });
    }

    if (route === 'GET /api/status') {
      const search = url.searchParams.get('search') || '';
      const tenantId = url.searchParams.get('tenant_id') || null;
      const result = buildStatus(search, tenantId ? Number(tenantId) : null);
      return sendJSON(res, 200, result);
    }

    if (route === 'GET /api/events') {
      if (!requireAdmin(res, req)) return;
      const personId = url.searchParams.get('person_id');
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
      let sql = `
        SELECT ce.id, ce.person_id, ce.tenant_id, ce.direction, ce.clocked_at, ce.notes,
               p.name AS person_name, t.name AS tenant_name
        FROM clock_events ce
        JOIN people p ON p.id = ce.person_id
        JOIN tenants t ON t.id = ce.tenant_id
      `;
      const params = [];
      if (personId) {
        sql += ' WHERE ce.person_id = ?';
        params.push(Number(personId));
      }
      sql += ' ORDER BY ce.clocked_at DESC LIMIT ?';
      params.push(limit);
      const rows = db.prepare(sql).all(...params);
      return sendJSON(res, 200, rows);
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
  console.log(`Admin token: ${ADMIN_TOKEN === 'change-me-admin-token' ? 'change-me-admin-token (default — set ADMIN_TOKEN in production)' : '(set from env)'}`);
});
