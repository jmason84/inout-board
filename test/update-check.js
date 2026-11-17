'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateChecker, isNewer } = require('../scripts/update-check');

function fixture(status, body, error = null) {
  let calls = 0, time = 0;
  const check = createUpdateChecker({ version: '1.0.14', now: () => time, request(opts, callback) {
    calls++;
    assert.equal(opts.hostname, 'api.github.com');
    const req = new EventEmitter();
    req.destroy = (err) => req.emit('error', err);
    req.end = () => queueMicrotask(() => {
      if (error) return req.emit('error', new Error(error));
      const res = new EventEmitter(); res.statusCode = status;
      callback(res); res.emit('data', body); res.emit('end');
    });
    return req;
  } });
  return { check, calls: () => calls, advance: (ms) => { time += ms; } };
}

test('release comparison handles repository tags, numeric ordering, and invalid versions', () => {
  assert.equal(isNewer('1.0.14', 'v1.0.15'), true);
  assert.equal(isNewer('1.0.14', 'v1.0'), false);
  assert.equal(isNewer('1.9.0', 'v1.10.0'), true);
  for (const tag of ['v1.0.14', 'banana', 'v1.0.15-beta.1', 'v1.0.14.1']) {
    assert.equal(isNewer('1.0.14', tag), false, tag);
  }
});

test('concurrent checks share a request and successful results expire after an hour', async () => {
  const f = fixture(200, JSON.stringify({ tag_name: 'v1.0.15', html_url: 'https://github.com/jmason84/inout-board/releases/tag/v1.0.15' }));
  const results = await Promise.all([f.check(), f.check(), f.check()]);
  assert.equal(f.calls(), 1);
  assert.equal(results[0].update_available, true);
  assert.equal(results[0].current_version, '1.0.14');
  await f.check(); assert.equal(f.calls(), 1);
  f.advance(3600001); await f.check(); assert.equal(f.calls(), 2);
});

test('404 is a normal cached result; release links must belong to this repository', async () => {
  const f = fixture(404, '{}');
  assert.deepEqual(await f.check(), { update_available: false, current_version: '1.0.14' });
  await f.check(); assert.equal(f.calls(), 1);
  const bad = fixture(200, JSON.stringify({ tag_name: 'v1.0.15', html_url: 'javascript:alert(1)' }));
  assert.equal((await bad.check()).release_url, '');
});

test('rate limits, malformed responses, and offline failures are cached briefly', async () => {
  for (const f of [fixture(403, '{}'), fixture(200, 'broken json'), fixture(0, '', 'offline')]) {
    const result = await f.check();
    assert.equal(result.update_available, false);
    assert.equal(result.current_version, '1.0.14');
    assert.ok(result.error);
    await f.check(); assert.equal(f.calls(), 1);
    f.advance(300001); await f.check(); assert.equal(f.calls(), 2);
  }
});

test('Windows updates require matching release assets and checksums', async () => {
  const prefix = 'https://github.com/jmason84/inout-board/releases/download/v1.0.15/';
  const assets = ['InOutBoard-1.0.15-x64.msi', 'SHA256SUMS.txt'].map((name) => ({ name, browser_download_url: prefix + name }));
  const f = fixture(200, JSON.stringify({ tag_name: 'v1.0.15', assets }));
  const result = await f.check();
  assert.equal(result.installable, true);
  assert.equal(result.installer_url, prefix + 'InOutBoard-1.0.15-x64.msi');
  assets[0].browser_download_url = 'https://evil.test/update.msi';
  assert.equal((await fixture(200, JSON.stringify({ tag_name: 'v1.0.15', assets })).check()).installable, false);
});
