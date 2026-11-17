#!/usr/bin/env node
'use strict';

// End-to-end smoke test: boots the real server on a throwaway port + data dir
// and exercises auth, the kiosk, profiles and settings. Run with:  npm test

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');

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
    for (const p of ['/api/tenants', '/api/people', '/api/status', '/api/events', '/api/admin/overview', '/api/admin/users', '/api/admin/settings', '/api/admin/update-status']) {
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
    // modern browsers: Sec-Fetch-Site decides, regardless of what Host the proxy forwards
    assert.equal((await call('POST', '/api/tenants', { name: 'x' }, { headers: { Origin: 'https://board.example.com', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call('POST', '/api/tenants', { name: 'x' }, { headers: { Origin: 'https://board.example.com', 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  });

  await t('behind a proxy: same-origin browser writes still work', async () => {
    // Public URL differs from the internal Host the app sees (Cloudflare tunnel case).
    const ok = await call('POST', '/api/auth/login', { username: 'tester', password: PASS },
      { jar: false, headers: { Origin: 'https://board.example.com', 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(ok.status, 200);
    // Older clients without Sec-Fetch-Site: Origin vs Host fails (403) unless proxy trust is configured.
    const old = await call('POST', '/api/auth/login', { username: 'tester', password: PASS },
      { jar: false, headers: { Origin: 'https://board.example.com' } });
    assert.equal(old.status, 403);
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

  await t('directory is public and groups people by tenant; contact info is hidden by default', async () => {
    const r = (await call('GET', '/api/directory', undefined, { jar: false })).data;
    assert.equal(r.mode, 'browse'); assert.equal(r.layout, 'table');
    const plaza = r.tenants.find((x) => x.name === 'Plaza North 2');
    assert.ok(plaza, 'tenant listed'); assert.equal(plaza.people.length, 1);
    const p = plaza.people[0];
    assert.equal(p.name, 'Dana Whitfield'); assert.equal(p.phone, ''); assert.equal(p.email, '');
    assert.ok(r.tenants.length >= 2, 'seeded Main Office is listed too');
    // search matches names (and tenant names) but never phone numbers
    assert.equal((await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0].people.length, 1);
    assert.deepEqual((await call('GET', '/api/directory?q=555', undefined, { jar: false })).data.tenants, []);
    // none of the private fields leak
    const keys = Object.keys(p).sort();
    assert.deepEqual(keys, ['avatar_kind', 'avatar_url', 'clocked_at', 'email', 'id', 'name', 'office', 'phone', 'status', 'title']);
  });

  await t('visibility: person-controlled contact details appear only when switched on', async () => {
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, phone: '555-0101', email: 'dana@example.com', office: 'Suite 204', show_phone: true });
    let p = (await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0].people[0];
    assert.equal(p.phone, '555-0101'); assert.equal(p.email, ''); assert.equal(p.office, 'Suite 204');
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, show_email: true, show_office: false });
    p = (await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0].people[0];
    assert.equal(p.email, 'dana@example.com'); assert.equal(p.office, ''); assert.equal(p.phone, '555-0101');
    // bulk hide phones for the whole tenant
    const bulk = await call('POST', '/api/admin/visibility', { field: 'show_phone', value: false, tenant_id: tenantId });
    assert.equal(bulk.data.updated, 1);
    p = (await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0].people[0];
    assert.equal(p.phone, '');
    assert.equal((await call('POST', '/api/admin/visibility', { field: 'password_hash', value: true })).status, 400, 'field is whitelisted');
    assert.equal((await call('POST', '/api/admin/visibility', { field: 'show_phone', value: true }, { jar: false })).status, 401);
  });

  await t('tenant company details, logo and avatar choice (photo vs logo vs initials)', async () => {
    assert.equal((await call('PUT', `/api/tenants/${tenantId}`, { name: 'Plaza North 2', notes: '', office: 'Floor 2', phone: '555-9000', email: 'hello@plaza.example', website: 'plaza.example' })).status, 200);
    assert.equal((await call('PUT', `/api/tenants/${tenantId}`, { name: 'x', website: 'javascript:alert(1)' })).status, 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const logo = await call('PUT', `/api/tenants/${tenantId}/logo`, png, { raw: true, headers: { 'Content-Type': 'image/png' } });
    assert.equal(logo.status, 200);
    assert.equal((await call('PUT', `/api/tenants/${tenantId}/logo`, Buffer.from('<svg onload=alert(1)>'), { raw: true, headers: { 'Content-Type': 'image/png' } })).status, 400);
    let d = (await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0];
    assert.equal(d.logo_url, logo.data.logo_url); assert.equal(d.website, 'https://plaza.example'); assert.equal(d.office, 'Floor 2');
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, avatar_mode: 'logo' });
    assert.equal((await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0].people[0].avatar_url, logo.data.logo_url);
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, avatar_mode: 'initials' });
    assert.equal((await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants[0].people[0].avatar_url, null);
    assert.equal((await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, avatar_mode: 'bogus' })).status, 400);
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, avatar_mode: 'photo' });
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

    // the person controls what the public sees about them
    const jar = { Cookie: pc, 'Content-Type': 'application/json' };
    const put = (url, body) => fetch(BASE + url, { method: 'PUT', headers: jar, body: JSON.stringify(body) });
    const r1 = await put('/api/me', { office: 'Suite 9', show_phone: true, show_office: true, avatar_mode: 'initials', is_manager: true });
    assert.equal(r1.status, 200);
    const mine = await r1.json();
    assert.equal(mine.is_manager, false, 'people cannot make themselves managers');
    assert.equal(mine.show_phone, true); assert.equal(mine.avatar_mode, 'initials');
    assert.equal((await put('/api/me/tenant', { office: 'Hacked' })).status, 403, 'non-manager cannot edit the company');
    // admin promotes them; now they can
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, is_manager: true });
    const ok = await put('/api/me/tenant', { office: 'Floor 3', phone: '555-1234' });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).tenant.office, 'Floor 3');
    assert.equal((await put('/api/me/tenant', { website: 'not a url' })).status, 400);
    await call('PUT', `/api/people/${personId}`, { name: 'Dana Whitfield', tenant_id: tenantId, active: true, is_manager: false });
    assert.equal((await put('/api/me/tenant', { office: 'Again' })).status, 403, 'demoted manager loses access');
  });

  await t('settings: whitelist enforced; layout + mode change the public directory', async () => {
    assert.equal((await call('PUT', '/api/admin/settings', { kiosk_layout: 'evil' })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { nope: 'x' })).status, 400);
    await call('PUT', '/api/admin/settings', { kiosk_layout: 'tiles', kiosk_mode: 'search' });
    let d = (await call('GET', '/api/directory', undefined, { jar: false })).data;
    assert.equal(d.layout, 'tiles'); assert.deepEqual(d.tenants, [], 'search-only mode lists nobody until you search');
    assert.equal((await call('GET', '/api/directory?q=dana', undefined, { jar: false })).data.tenants.length, 1);
    await call('PUT', '/api/admin/settings', { kiosk_layout: 'cards', kiosk_mode: 'browse' });
    d = (await call('GET', '/api/directory', undefined, { jar: false })).data;
    assert.equal(d.layout, 'cards'); assert.ok(d.tenants.length >= 2);
    for (const l of ['table', 'list', 'cards', 'tiles', 'board']) assert.equal((await call('PUT', '/api/admin/settings', { kiosk_layout: l })).status, 200, l);
  });

  await t('settings: theme (light/dark/system) persists and appears in directory', async () => {
    for (const v of ['light', 'dark', 'system']) {
      assert.equal((await call('PUT', '/api/admin/settings', { theme: v })).status, 200, `set theme ${v}`);
    }
    assert.equal((await call('PUT', '/api/admin/settings', { theme: 'neon' })).status, 400, 'reject invalid theme');
    await call('PUT', '/api/admin/settings', { theme: 'dark' });
    const d = (await call('GET', '/api/directory', undefined, { jar: false })).data;
    assert.equal(d.theme, 'dark', 'directory includes theme');
    await call('PUT', '/api/admin/settings', { theme: 'system' }); // reset
  });

  await t('update-check endpoint returns JSON (may not reach GitHub)', async () => {
    const r = await call('GET', '/api/admin/update-check');
    assert.equal(r.status, 200);
    assert.ok('current_version' in r.data || 'error' in r.data, 'response has version or error');
    // unauthenticated should be rejected
    assert.equal((await call('GET', '/api/admin/update-check', undefined, { jar: false })).status, 401);
    assert.equal((await call('POST', '/api/admin/update', {}, { jar: false })).status, 401);
    assert.equal((await call('POST', '/api/admin/update', {})).status, 400, 'manual Node launches cannot install software');
    assert.equal((await call('GET', '/api/admin/update-status')).data.supported, false);
  });

  await t('static pages + security headers; path traversal blocked', async () => {
    for (const p of ['/', '/admin', '/me']) assert.equal((await call('GET', p, undefined, { jar: false })).status, 200, p);
    const r = await call('GET', '/', undefined, { jar: false });
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.notEqual((await call('GET', '/photos/../data/inout.sqlite', undefined, { jar: false })).status, 200);
  });

  await t('malformed Host is rejected without crashing the server', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(BASE + '/api/health', { headers: { Host: '[' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    });
    assert.equal(status, 400);
    assert.equal((await call('GET', '/api/health')).data.ok, true);
  });

  await t('CSV export: admin only, UTF-8 BOM, every person with their settings', async () => {
    assert.equal((await call('GET', '/api/people.csv', undefined, { jar: false })).status, 401);
    const r = await call('GET', '/api/people.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const raw = new Uint8Array(await (await fetch(BASE + '/api/people.csv', { headers: { Cookie: cookie } })).arrayBuffer());
    assert.deepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads accents correctly');
    const lines = r.data.replace(/^﻿/, '').trim().split(/\r\n/);
    assert.equal(lines[0], 'id,name,tenant,title,office,phone,email,active,show_office,show_phone,show_email,avatar_mode,manager,bio');
    assert.ok(lines.length >= 12, 'seeded roster + Dana');
    assert.ok(lines.some((l) => l.includes('Dana Whitfield')));
  });

  await t('CSV import: dry run changes nothing; apply creates, updates, creates tenants, reports bad rows', async () => {
    const countPeople = async () => (await call('GET', '/api/people')).data.length;
    const before = await countPeople();
    const danaId = personId;
    const csv = [
      'Name,Company,Job Title,Phone,Email,Show Phone,Active',
      'Ana "The Boss" Lopez,CSV Co,"Owner, CEO",605-555-1111,ana@csv.example,yes,yes',
      'Bo Chen,CSV Co,Analyst,,bo@csv.example,no,',
      ',CSV Co,Nobody,,,,',
      'Cy Dunn,CSV Co,Intern,,not-an-email,,',
      'Di Evans,CSV Co,Intern,,,maybe,',
      'Dana Whitfield,Plaza North 2,Senior Lead,605-555-9999,,,',
    ].join('\r\n');
    const post = (q) => call('POST', '/api/people/import' + q, csv, { raw: true, headers: { 'Content-Type': 'text/csv' } });

    assert.equal((await call('POST', '/api/people/import', csv, { raw: true, jar: false, headers: { 'Content-Type': 'text/csv' } })).status, 401);
    const dry = (await post('?dry_run=1')).data;
    assert.equal(dry.dry_run, true);
    assert.equal(dry.created, 2); assert.equal(dry.updated, 1); assert.equal(dry.skipped, 3);
    assert.deepEqual(dry.tenants_created, ['CSV Co']);
    assert.deepEqual(dry.errors.map((e) => e.row).sort(), [4, 5, 6]);
    assert.equal(await countPeople(), before, 'dry run wrote nothing');
    assert.equal((await call('GET', '/api/tenants')).data.some((x) => x.name === 'CSV Co'), false);

    const real = (await post('')).data;
    assert.equal(real.created, 2); assert.equal(real.updated, 1);
    assert.equal(await countPeople(), before + 2);
    const people = (await call('GET', '/api/people')).data;
    const ana = people.find((p) => p.name === 'Ana "The Boss" Lopez');
    assert.equal(ana.title, 'Owner, CEO'); assert.equal(ana.show_phone, true); assert.equal(ana.tenant_name, 'CSV Co');
    const bo = people.find((p) => p.name === 'Bo Chen'); assert.equal(bo.show_phone, false);
    const dana = (await call('GET', `/api/people/${danaId}`)).data;
    assert.equal(dana.title, 'Senior Lead'); assert.equal(dana.phone, '605-555-9999');
    assert.equal(dana.office, 'Suite 9', 'a column that is not in the file is left alone');
    assert.equal(dana.email, '', 'a column that IS in the file is authoritative: a blank cell clears the value');
    // importing the same file again updates instead of duplicating
    const again = (await post('')).data;
    assert.equal(again.created, 0); assert.equal(again.updated, 3);
    assert.equal(await countPeople(), before + 2);
  });

  await t('CSV import: semicolons, default tenant, quoted newlines, id matching, round trip with formula guard', async () => {
    const tenants = (await call('GET', '/api/tenants')).data;
    const tid = tenants.find((x) => x.name === 'CSV Co').id;
    const post = (csv, q = '') => call('POST', '/api/people/import' + q, csv, { raw: true, headers: { 'Content-Type': 'text/csv' } });
    // no tenant column and no default -> every row rejected
    const none = (await post('name;phone\nEd Fox;1')).data;
    assert.equal(none.created, 0); assert.equal(none.skipped, 1);
    // with a default tenant, semicolon separated, quoted newline in the bio
    const ok = (await post('name;bio;phone\nEd Fox;"line1\nline2";+1 605 555 0000', `?default_tenant_id=${tid}`)).data;
    assert.equal(ok.created, 1);
    const ed = (await call('GET', '/api/people')).data.find((p) => p.name === 'Ed Fox');
    assert.equal(ed.tenant_name, 'CSV Co'); assert.equal(ed.phone, '+1 605 555 0000');
    // export guards '+' against spreadsheet formulas; importing the export restores the original text
    const exp = (await call('GET', '/api/people.csv')).data;
    assert.ok(exp.includes("'+1 605 555 0000"), 'leading + is neutralised in the export');
    const back = (await post(exp)).data;
    assert.equal(back.created, 0); assert.equal(back.errors.length, 0);
    assert.equal((await call('GET', '/api/people')).data.find((p) => p.name === 'Ed Fox').phone, '+1 605 555 0000');
    // matching by id moves a person to another tenant
    const main = tenants.find((x) => x.name === 'Main Office');
    await post(`id,name,tenant\n${ed.id},Ed Fox,Main Office`);
    assert.equal((await call('GET', '/api/people')).data.find((p) => p.name === 'Ed Fox').tenant_id, main.id);
    // garbage in
    assert.equal((await post('just one line')).status, 400);
    assert.equal((await post('foo,bar\n1,2')).status, 400);
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

  await t('address discovery lists real addresses and builds correct URLs', async () => {
    const net = require('../scripts/netinfo');
    const info = await net.discover();
    assert.ok(Array.isArray(info.addresses));
    for (const a of info.addresses) assert.ok(a.address && ['IPv4', 'IPv6'].includes(a.family));
    // a manual preferred address only reorders, it never removes the others
    const first = info.addresses[0];
    if (first) assert.equal((await net.discover(first.address)).addresses.length, info.addresses.length);
    assert.equal(net.urlFor('https', '172.20.20.15', 8443, '/admin'), 'https://172.20.20.15:8443/admin');
    assert.equal(net.urlFor('https', '172.20.20.15', 443), 'https://172.20.20.15/');
    assert.equal(net.urlFor('http', 'fd00::5', 3000), 'http://[fd00::5]:3000/');
  });

  await t('INOUT_ENV_FILE supplies settings but never overrides the real environment', async () => {
    const { spawnSync } = require('node:child_process');
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-env-'));
    const envFile = path.join(d2, 'inout-board.env');
    fs.writeFileSync(envFile, ['# comment', `DATA_DIR=${d2}`, 'ADMIN_USER="fileadmin"', 'ADMIN_PASSWORD=from-file-pass', 'PORT=1'].join('\r\n'));
    // PORT in the file would be unusable; the real env value must win. Stop right after startup.
    const code = `process.on('exit',()=>{});require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});setTimeout(()=>process.exit(0),800)`;
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], {
      env: { ...process.env, INOUT_ENV_FILE: envFile, PORT: String(PORT + 1000), HOST: '127.0.0.1' }, encoding: 'utf8', timeout: 15000,
    });
    assert.match(r.stdout, /Created first admin account "fileadmin"/);
    assert.match(r.stdout, new RegExp(`listening on http://127.0.0.1:${PORT + 1000}`));
    assert.ok(fs.existsSync(path.join(d2, 'inout.sqlite')), 'DATA_DIR from file was used');
    fs.rmSync(d2, { recursive: true, force: true });
  });

  await t('default admin/admin works once, then a new password is forced before anything else', async () => {
    const { spawn } = require('node:child_process');
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-default-'));
    const port3 = PORT + 2000;
    const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port3), HOST: '127.0.0.1', DATA_DIR: d3, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin' },
      stdio: 'ignore',
    });
    try {
      const base = `http://127.0.0.1:${port3}`;
      for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* starting */ } await sleep(100); }
      let jar = '';
      const api = async (method, url, body) => {
        const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: jar } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const set = r.headers.get('set-cookie'); if (set) jar = set.split(';')[0];
        let data; try { data = await r.json(); } catch { data = {}; }
        return { status: r.status, data };
      };
      const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
      assert.equal(login.status, 200);
      assert.equal(login.data.must_change, true);
      assert.equal((await api('GET', '/api/auth/me')).data.must_change, true);
      // everything except the password change is refused, and says why
      for (const u of ['/api/tenants', '/api/people', '/api/admin/overview', '/api/admin/settings', '/api/admin/users']) {
        const r = await api('GET', u);
        assert.equal(r.status, 403, u); assert.equal(r.data.must_change, true, u);
      }
      assert.equal((await api('POST', '/api/auth/password', { next: 'short' })).status, 400);
      assert.equal((await api('POST', '/api/auth/password', { next: 'admin' })).status, 400);
      assert.equal((await api('POST', '/api/auth/password', { next: 'a-much-better-passphrase' })).status, 200);
      assert.equal((await api('GET', '/api/auth/me')).data.must_change, false);
      assert.equal((await api('GET', '/api/admin/overview')).status, 200);
      // the old default no longer signs in; the new password does
      jar = '';
      assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'admin' })).status, 401);
      const again = await api('POST', '/api/auth/login', { username: 'admin', password: 'a-much-better-passphrase' });
      assert.equal(again.status, 200); assert.equal(again.data.must_change, false);
    } finally {
      srv.kill();
      await sleep(200);
      fs.rmSync(d3, { recursive: true, force: true });
    }
  });

  await t('a strong ADMIN_PASSWORD is not forced to change', async () => {
    // the main test server was started with a non-default password
    const me = await call('POST', '/api/auth/login', { username: 'tester', password: PASS });
    assert.equal(me.status, 200);
    assert.equal(me.data.must_change, false);
    cookie = me.set.split(';')[0];
    assert.equal((await call('GET', '/api/admin/overview')).status, 200);
  });

  await t('reset-admin recovers a locked-out install (admin/admin, forced change) and can set a chosen password', async () => {
    const { spawn, execFileSync } = require('node:child_process');
    const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-reset-'));
    const port4 = PORT + 3000;
    const start = () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port4), HOST: '127.0.0.1', DATA_DIR: d4, ADMIN_USER: 'owner', ADMIN_PASSWORD: 'unknown-long-original-pass' },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port4}`;
    const up = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* starting */ } await sleep(100); } };
    const login = async (u, p) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      let data = {}; try { data = await r.json(); } catch { /* none */ }
      return { status: r.status, data };
    };
    const reset = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'reset-admin.js'), ...args], { env: { ...process.env, DATA_DIR: d4 }, encoding: 'utf8' });
    let srv = start();
    try {
      await up();
      assert.equal((await login('admin', 'admin')).status, 401, 'no admin/admin yet');
      srv.kill(); await sleep(300);
      assert.match(reset(), /Created admin "admin"/);
      srv = start(); await up();
      const a = await login('admin', 'admin');
      assert.equal(a.status, 200); assert.equal(a.data.must_change, true);
      assert.equal((await login('owner', 'unknown-long-original-pass')).status, 200, 'other admins are untouched');
      srv.kill(); await sleep(300);
      assert.match(reset('owner', 'a-brand-new-passphrase'), /Reset the password for admin "owner"/);
      assert.throws(() => reset('owner', 'short'), /at least 10/);
      srv = start(); await up();
      assert.equal((await login('owner', 'unknown-long-original-pass')).status, 401);
      const o = await login('owner', 'a-brand-new-passphrase');
      assert.equal(o.status, 200); assert.equal(o.data.must_change, false);
    } finally {
      srv.kill(); await sleep(200);
      fs.rmSync(d4, { recursive: true, force: true });
    }
  });

  await t('built-in HTTPS: private CA signs a certificate that covers the addresses, is reused, and re-issued when they change', async () => {
    const crypto = require('node:crypto');
    const tlscert = require('../scripts/tlscert');
    const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-tls-'));
    try {
      const a = tlscert.ensure({ dir: d5, ips: ['127.0.0.1', '192.168.6.235'], dns: ['localhost', 'front-desk'] });
      assert.equal(a.reissued, true);
      const ca = new crypto.X509Certificate(a.caPem);
      const leaf = new crypto.X509Certificate(a.cert);
      assert.ok(leaf.verify(ca.publicKey), 'server certificate is signed by the CA');
      assert.equal(leaf.issuer, ca.subject);
      assert.ok(leaf.checkIP('192.168.6.235') && leaf.checkIP('127.0.0.1'), 'IP SANs');
      assert.ok(leaf.checkHost('localhost') && leaf.checkHost('front-desk'), 'DNS SANs');
      assert.ok(!leaf.ca && ca.ca, 'leaf is not a CA, root is');
      assert.ok(new Date(leaf.validTo) > new Date(Date.now() + 300 * 86400000), 'valid for most of a year');
      assert.ok(!a.caPem.includes('PRIVATE'), 'CA certificate text carries no key');
      const b = tlscert.ensure({ dir: d5, ips: ['127.0.0.1', '192.168.6.235'], dns: ['localhost', 'front-desk'] });
      assert.equal(b.reissued, false, 'unchanged addresses reuse the certificate');
      const c = tlscert.ensure({ dir: d5, ips: ['10.1.2.3'], dns: ['localhost'] });
      assert.equal(c.reissued, true, 'new address re-issues');
      assert.equal(c.caPem, a.caPem, 'same CA, so devices keep trusting it');
      assert.ok(new crypto.X509Certificate(c.cert).checkIP('10.1.2.3'));
    } finally { fs.rmSync(d5, { recursive: true, force: true }); }
  });

  await t('built-in HTTPS adopts the CA of an older Caddy-based install', async () => {
    const crypto = require('node:crypto');
    const tlscert = require('../scripts/tlscert');
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-legacy-'));
    const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-tls2-'));
    try {
      const old = tlscert.createCa('Caddy Local Authority - 2026 ECC Root');
      fs.writeFileSync(path.join(legacy, 'root.crt'), old.certPem);
      fs.writeFileSync(path.join(legacy, 'root.key'), old.keyPem);
      const r = tlscert.ensure({ dir: d6, ips: ['127.0.0.1'], dns: ['localhost'], legacyDir: legacy });
      assert.equal(r.caPem, old.certPem, 'same CA certificate');
      assert.ok(new crypto.X509Certificate(r.cert).verify(new crypto.X509Certificate(old.certPem).publicKey));
    } finally { fs.rmSync(legacy, { recursive: true, force: true }); fs.rmSync(d6, { recursive: true, force: true }); }
  });

  await t('HTTPS=auto serves the app over TLS, trusts only its CA, serves /ca.crt, gzips assets, sets Secure cookies', async () => {
    const { spawn } = require('node:child_process');
    const https = require('node:https');
    const zlib = require('node:zlib');
    const d7 = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-https-'));
    const p7 = PORT + 2000;
    const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(p7), HOST: '127.0.0.1', DATA_DIR: d7, HTTPS: 'auto', ADMIN_USER: 'tester', ADMIN_PASSWORD: PASS },
      stdio: 'ignore',
    });
    const get = (urlPath, { ca, headers = {}, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: p7, path: urlPath, method, headers, ca, servername: 'localhost' }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
    try {
      const caFile = path.join(d7, 'tls', 'ca.crt');
      for (let i = 0; i < 60 && !fs.existsSync(path.join(d7, 'tls', 'server.crt')); i++) await sleep(100);
      await sleep(300);
      const ca = fs.readFileSync(caFile);
      const h = await get('/api/health', { ca });
      assert.equal(h.res.statusCode, 200);
      await assert.rejects(get('/api/health', {}), /self.signed|unable to verify|certificate/i, 'untrusted without the CA');
      const dl = await get('/ca.crt', { ca });
      assert.equal(dl.res.headers['content-type'], 'application/x-x509-ca-cert');
      assert.equal(dl.body.toString(), ca.toString());
      assert.ok(!dl.body.toString().includes('PRIVATE'));
      const js = await get('/app.js', { ca, headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(js.res.headers['content-encoding'], 'gzip');
      assert.equal(zlib.gunzipSync(js.body).toString(), fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'));
      const plain = await get('/app.js', { ca });
      assert.equal(plain.res.headers['content-encoding'], undefined);
      const login = await get('/api/auth/login', { ca, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: PASS }) });
      assert.equal(login.res.statusCode, 200);
      assert.match(String(login.res.headers['set-cookie']), /; Secure/);
    } finally { srv.kill(); await sleep(200); fs.rmSync(d7, { recursive: true, force: true }); }
  });

  console.log(`\n${passed} checks passed`);
})().then(() => finish(0)).catch((e) => { console.error('\nServer log:\n' + log); finish(1); });

function finish(code) {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
