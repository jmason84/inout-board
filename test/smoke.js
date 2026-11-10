#!/usr/bin/env node
'use strict';

// End-to-end smoke test: boots the real server on a throwaway port + data dir
// and exercises auth, the kiosk, profiles and settings. Run with:  npm test

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-test-'));
const PASS = 'smoke-test-password';

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_USER: 'tester', ADMIN_PASSWORD: PASS },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function call(method, url, body, { jar = true, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (jar && cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, set, headers: res.headers };
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); throw e; }
}

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await call('GET', '/api/health')).status === 200) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  await t('health is public', async () => assert.equal((await call('GET', '/api/health')).data.ok, true));

  await t('private endpoints require login', async () => {
    for (const p of ['/api/tenants', '/api/people', '/api/status', '/api/events', '/api/admin/overview', '/api/admin/users', '/api/admin/settings']) {
      assert.equal((await call('GET', p, undefined, { jar: false })).status, 401, p);
    }
  });

  await t('bad login rejected, good login sets HttpOnly SameSite=Strict cookie', async () => {
    assert.equal((await call('POST', '/api/auth/login', { username: 'tester', password: 'nope' })).status, 401);
    const r = await call('POST', '/api/auth/login', { username: 'TESTER', password: PASS });
    assert.equal(r.status, 200);
    assert.match(r.set, /HttpOnly/); assert.match(r.set, /SameSite=Strict/);
    cookie = r.set.split(';')[0];
  });

  await t('cross-origin writes are blocked', async () => {
    const r = await call('POST', '/api/tenants', { name: 'x' }, { headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
  });

  let tenantId, personId;
  await t('tenants + people CRUD (incl. :id routes)', async () => {
    tenantId = (await call('POST', '/api/tenants', { name: 'Plaza North', notes: 'n' })).data.id;
    assert.ok(tenantId);
    assert.equal((await call('PUT', `/api/tenants/${tenantId}`, { name: 'Plaza North 2', notes: '' })).status, 200);
    personId = (await call('POST', '/api/people', { name: 'Dana Whitfield', tenant_id: tenantId, phone: '555' })).data.id;
    assert.equal((await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, phone: '555', active: true, title: 'Lead' })).status, 200);
    assert.equal((await call('GET', `/api/people/${personId}`)).data.title, 'Lead');
  });

  await t('kiosk search is public, limited fields, name-only matching', async () => {
    const r = await call('GET', '/api/kiosk/search?q=dana', undefined, { jar: false });
    assert.equal(r.data.length, 1);
    assert.deepEqual(Object.keys(r.data[0]).sort(), ['clocked_at', 'id', 'name', 'photo_url', 'status', 'tenant_name', 'title']);
    assert.deepEqual((await call('GET', '/api/kiosk/search?q=555', undefined, { jar: false })).data, []);
    assert.deepEqual((await call('GET', '/api/kiosk/search?q=', undefined, { jar: false })).data, []);
  });

  await t('public clock in/out, duplicate rejected, shifts computed', async () => {
    assert.equal((await call('POST', '/api/clock', { person_id: personId, direction: 'in' }, { jar: false })).status, 201);
    assert.equal((await call('POST', '/api/clock', { person_id: personId, direction: 'in' }, { jar: false })).status, 409);
    assert.equal((await call('POST', '/api/clock', { person_id: personId, direction: 'out' }, { jar: false })).status, 201);
    const s = (await call('GET', `/api/sessions?person_id=${personId}`)).data;
    assert.equal(s.sessions.length, 1); assert.equal(s.sessions[0].open, false);
    assert.match((await call('GET', '/api/events.csv')).data, /Dana Whitfield/);
  });

  await t('photo upload validates file type', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    assert.equal((await call('PUT', `/api/people/${personId}/photo`, svg, { raw: true, headers: { 'Content-Type': 'image/png' } })).status, 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const r = await call('PUT', `/api/people/${personId}/photo`, png, { raw: true, headers: { 'Content-Type': 'image/png' } });
    assert.equal(r.status, 200);
    assert.equal((await call('GET', r.data.photo_url, undefined, { jar: false })).status, 200);
  });

  await t('person sign-in is separate from admin', async () => {
    const acc = (await call('POST', `/api/people/${personId}/access`)).data;
    assert.ok(acc.handle && acc.temp_password);
    const login = await call('POST', '/api/me/login', { handle: acc.handle, password: acc.temp_password }, { jar: false });
    assert.equal(login.status, 200); assert.equal(login.data.must_change, true);
    const pc = login.set.split(';')[0];
    const me = await fetch(BASE + '/api/people', { headers: { Cookie: pc } });
    assert.equal(me.status, 401, 'person cookie must not open admin endpoints');
  });

  await t('settings: whitelist enforced, layout + mode change kiosk config', async () => {
    assert.equal((await call('PUT', '/api/admin/settings', { kiosk_layout: 'evil' })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { nope: 'x' })).status, 400);
    await call('PUT', '/api/admin/settings', { kiosk_layout: 'tiles', kiosk_mode: 'browse' });
    assert.deepEqual((await call('GET', '/api/kiosk/config', undefined, { jar: false })).data, { layout: 'tiles', mode: 'browse' });
    assert.equal((await call('GET', '/api/kiosk/search?q=', undefined, { jar: false })).data.length >= 1, true);
  });

  await t('static pages + security headers; path traversal blocked', async () => {
    for (const p of ['/', '/admin', '/me']) assert.equal((await call('GET', p, undefined, { jar: false })).status, 200, p);
    const r = await call('GET', '/', undefined, { jar: false });
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.notEqual((await call('GET', '/photos/../data/inout.sqlite', undefined, { jar: false })).status, 200);
  });

  await t('logout ends the session', async () => {
    await call('POST', '/api/auth/logout');
    assert.equal((await call('GET', '/api/tenants')).status, 401);
  });

  await t('backup script produces a restorable copy', async () => {
    const out = path.join(dataDir, 'bk');
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'backup.js'), out], { env: { ...process.env, DATA_DIR: dataDir } });
    const dirs = fs.readdirSync(out);
    assert.equal(dirs.length, 1);
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(path.join(out, dirs[0], 'inout.sqlite'));
    assert.equal(copy.prepare('SELECT COUNT(*) c FROM people WHERE name = ?').get('Dana Whitfield').c, 1);
    copy.close();
    assert.ok(fs.readdirSync(path.join(out, dirs[0], 'uploads')).length >= 1, 'photos backed up');
  });

  console.log(`\n${passed} checks passed`);
})().then(() => finish(0)).catch((e) => { console.error('\nServer log:\n' + log); finish(1); });

function finish(code) {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
