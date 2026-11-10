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

  await t('static pages + security headers; path traversal blocked', async () => {
    for (const p of ['/', '/admin', '/me']) assert.equal((await call('GET', p, undefined, { jar: false })).status, 200, p);
    const r = await call('GET', '/', undefined, { jar: false });
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.notEqual((await call('GET', '/photos/../data/inout.sqlite', undefined, { jar: false })).status, 200);
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

  console.log(`\n${passed} checks passed`);
})().then(() => finish(0)).catch((e) => { console.error('\nServer log:\n' + log); finish(1); });

function finish(code) {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
