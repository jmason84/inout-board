'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('Pages demo supports the same theme and update-check UI contracts', async () => {
  const storage = () => {
    const values = new Map();
    return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  };
  const context = {
    window: { fetch: () => { throw new Error('demo must not call the network'); } },
    localStorage: storage(), sessionStorage: storage(),
    location: { href: 'https://example.test/inout-board/app/admin.html' },
    document: { addEventListener() {} }, URL, Response, setTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/demo-api.js'), 'utf8'), context);
  const call = (route, method = 'GET', body) => context.window.fetch('/api/' + route, { method, body: JSON.stringify(body) });
  assert.equal((await call('admin/update-check')).status, 401);
  assert.equal((await call('auth/login', 'POST', { username: 'demo', password: 'demo' })).status, 200);
  assert.equal((await (await call('admin/settings')).json()).theme, 'system');
  for (const theme of ['dark', 'light', 'system']) {
    assert.equal((await call('admin/settings', 'PUT', { theme })).status, 200);
    assert.equal((await (await call('directory')).json()).theme, theme);
  }
  assert.equal((await call('admin/settings', 'PUT', { theme: 'neon' })).status, 400);
  assert.equal((await (await call('admin/update-check')).json()).update_available, false);
});
