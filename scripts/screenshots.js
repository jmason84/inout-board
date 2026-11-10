#!/usr/bin/env node
'use strict';

/**
 * Regenerates the screenshots in docs/screenshots/ from a throwaway copy of the app
 * filled with fictional demo data (scripts/seed-demo.js).
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/screenshots.js
 *
 * Playwright is only needed for this script; the app itself has no dependencies.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('This script needs Playwright:  npm i --no-save playwright && npx playwright install chromium'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { user: 'demo', pass: 'demo-pass-123' };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-shots-'));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_USER: ADMIN.user, ADMIN_PASSWORD: ADMIN.pass },
  stdio: 'ignore',
});
function finish(code) { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(code); }

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await sleep(100); }
  const seeded = execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js')], { env: { ...process.env, BASE, ADMIN_USER: ADMIN.user, ADMIN_PASSWORD: ADMIN.pass } }).toString();
  const handle = /sign-in "([^"]+)"/.exec(seeded)[1];
  const temp = /password "([^"]+)"/.exec(seeded)[1];

  const browser = await chromium.launch();
  const shot = async (page, name, opts = {}) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, name + '.png'), ...opts }); console.log('  ', name + '.png'); };

  // ------------------------------------------------------------------ public board
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 });
  const home = await desktop.newPage();
  for (const layout of ['table', 'cards', 'tiles', 'list', 'board']) {
    await home.goto(`${BASE}/?layout=${layout}`); await home.waitForSelector('.tenant');
    await home.evaluate(() => window.scrollTo(0, 0));
    await shot(home, `home-${layout}`);
  }
  // text size
  await home.goto(`${BASE}/?layout=cards`); await home.waitForSelector('.tenant');
  await home.evaluate(() => IOPrefs.setSize('large')); await shot(home, 'home-large-text');
  await home.evaluate(() => IOPrefs.setSize(''));

  const dark = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, colorScheme: 'dark' })).newPage();
  await dark.goto(`${BASE}/?layout=table`); await dark.waitForSelector('.tenant'); await shot(dark, 'home-dark');

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await phone.goto(`${BASE}/?layout=cards`); await phone.waitForSelector('.tenant'); await shot(phone, 'home-mobile');

  // ------------------------------------------------------------------ a person's own page
  const me = await (await browser.newContext({ viewport: { width: 1000, height: 1500 }, deviceScaleFactor: 1.25 })).newPage();
  await me.goto(`${BASE}/me`); await me.fill('#loginHandle', handle); await me.fill('#loginPass', temp); await me.click('#loginForm button');
  await me.waitForSelector('#pwCard:not([hidden])'); await me.fill('#pwNext', 'demo-password-1'); await me.click('#pwForm button');
  await me.waitForSelector('#profile:not([hidden])');
  await me.evaluate(() => window.scrollTo(0, 0)); await shot(me, 'me-profile');

  // ------------------------------------------------------------------ admin console
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 })).newPage();
  await admin.goto(`${BASE}/admin`); await admin.fill('#loginUser', ADMIN.user); await admin.fill('#loginPass', ADMIN.pass); await admin.click('#loginForm button');
  await admin.waitForSelector('.stat');
  await shot(admin, 'admin-overview');
  for (const [page, name] of [['board', 'admin-live-board'], ['tenants', 'admin-tenants'], ['people', 'admin-people'], ['log', 'admin-time-log'], ['settings', 'admin-settings']]) {
    await admin.click(`[data-admin=${page}]`); await admin.waitForTimeout(600); await shot(admin, name);
  }

  // person profile dialog
  await admin.click('[data-admin=people]'); await admin.waitForTimeout(500);
  await admin.locator('tr', { hasText: 'Maria Delgado' }).locator('[data-profile-person]').click();
  await admin.waitForSelector('#profBack:not([hidden])'); await shot(admin, 'admin-profile');
  await admin.keyboard.press('Escape');

  // CSV import preview (nothing is written: we cancel)
  const csv = path.join(dataDir, 'new-tenants.csv');
  fs.writeFileSync(csv, [
    'Name,Company,Job Title,Phone,Email',
    'Rosa Alvarez,Riverside Plaza Management,General Manager,605-555-0101,rosa@riverside.example',
    'Piper Quinn,Prairie Print Shop,Owner,605-555-0210,piper@prairieprint.example',
    'Leo Brandt,Prairie Print Shop,Pressman,,',
    ',Prairie Print Shop,Nobody,,',
    'Cal Ford,Prairie Print Shop,Sales,,not-an-email',
  ].join('\n'));
  await admin.setInputFiles('#importPeopleFile', csv);
  await admin.waitForSelector('#modalBack:not([hidden])'); await shot(admin, 'admin-csv-import');
  await admin.click('#modalCancel');

  await browser.close();
  console.log(`Saved to ${path.relative(ROOT, OUT)}`);
  finish(0);
})().catch((e) => { console.error('Screenshot run failed:', e.message); finish(1); });
