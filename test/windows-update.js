'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createWindowsUpdater, expectedHash, allowedUrl, download } = require('../scripts/windows-update');

test('installer checksum must name exactly one matching release MSI', () => {
  const hash = 'a'.repeat(64);
  assert.equal(expectedHash(`${hash}  InOutBoard-1.2.3-x64.msi\r\n`, 'InOutBoard-1.2.3-x64.msi'), hash);
  for (const body of ['', `${hash}  other.msi`, `${hash}  a.msi\n${hash}  a.msi`]) assert.throws(() => expectedHash(body, 'a.msi'));
});

test('release downloads reject arbitrary hosts and insecure redirects', () => {
  assert.equal(allowedUrl('https://github.com/jmason84/inout-board/releases/download/v1.2.3/a.msi', true), true);
  for (const u of ['http://github.com/a', 'https://evil.test/a', 'https://github.com/other/project/releases/download/a', 'https://user:pass@github.com/a']) {
    assert.equal(allowedUrl(u, true), false);
  }
  assert.equal(allowedUrl('https://release-assets.githubusercontent.com/test', false), true);
  assert.equal(allowedUrl('https://evil.test/test', false), false);
});

test('download enforces size limits and rejects redirect to an untrusted host', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = 'https://github.com/jmason84/inout-board/releases/download/v1.2.3/a.msi';
  const fake = (redirect = false) => (u, opts, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = (e) => { req.emit('error', e); req.emit('close'); };
    queueMicrotask(() => {
      const res = Readable.from(['too many bytes']);
      res.statusCode = redirect ? 302 : 200;
      res.headers = { location: 'https://evil.test/installer.msi' };
      callback(res); req.emit('close');
    });
    return req;
  };
  await assert.rejects(download(url, path.join(root, 'large'), 2, fake()), /too large/);
  await assert.rejects(download(url, path.join(root, 'redirect'), 100, fake(true)), /Unexpected/);
});

function fixture(t, { corrupt = false, supported = true, missing = false, launchError = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inout-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('test installer');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const prefix = 'https://github.com/jmason84/inout-board/releases/download/v1.2.3/';
  fs.writeFileSync(path.join(root, 'windows-update.ps1'), '# isolated test worker');
  let launched = 0, launchArgs;
  const update = createWindowsUpdater({ root, installDir: root, supported,
    check: async () => ({ update_available: !missing, installable: true, latest_version: '1.2.3',
      installer_url: prefix + 'InOutBoard-1.2.3-x64.msi', checksum_url: prefix + 'SHA256SUMS.txt' }),
    downloadFile: async (url, dest) => {
      fs.writeFileSync(dest, url.endsWith('.txt') ? `${hash}  InOutBoard-1.2.3-x64.msi\n` : corrupt ? 'bad' : bytes);
    },
    launch(exe, args, options) {
      launched++; launchArgs = { exe, args, options };
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit(launchError ? 'error' : 'spawn', launchError ? new Error('spawn failed') : undefined));
      return child;
    },
  });
  return { update, root, launched: () => launched, args: () => launchArgs };
}

test('unsupported editions and unavailable releases cannot start installers', async (t) => {
  for (const options of [{ supported: false }, { missing: true }]) {
    const f = fixture(t, options);
    await assert.rejects(f.update.start()); assert.equal(f.launched(), 0);
    assert.equal(f.update.status().busy, false);
  }
});

test('corrupt downloads and launch failures are visible and release the update lock', async (t) => {
  for (const options of [{ corrupt: true }, { launchError: true }]) {
    const f = fixture(t, options);
    const result = await f.update.start(); await result.completion;
    assert.equal(f.update.status().state, 'error');
    assert.equal(f.update.status().busy, false);
    if (options.corrupt) assert.equal(f.launched(), 0);
  }
});

test('verified updates launch a detached worker once and block concurrent requests', async (t) => {
  const f = fixture(t);
  const result = await f.update.start();
  await assert.rejects(f.update.start(), (e) => e.status === 409);
  await result.completion;
  assert.equal(f.launched(), 1);
  assert.equal(f.update.status().state, 'prepared');
  assert.equal(f.args().options.detached, true);
  assert.ok(f.args().args.includes('-ExpectedHash'));
  assert.ok(f.args().args.includes('1.2.3'));
});
