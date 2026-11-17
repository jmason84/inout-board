'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { msUntilNext } = require('../scripts/backup-schedule');

const root = path.join(__dirname, '..');
const run = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(root, 'scripts/healthcheck.js')], { env: { ...process.env, ...env } });
  p.on('exit', resolve);
});

test('healthcheck exits 0 against a healthy server and 1 otherwise', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal(await run({ PORT: String(port), HTTPS: 'off', TLS_CERT: '', TLS_KEY: '' }), 0);
    srv.close();
    assert.equal(await run({ PORT: String(port), HTTPS: 'off', TLS_CERT: '', TLS_KEY: '' }), 1);
  } finally { srv.close(); }
});

test('backup scheduler waits less than a day and never fires immediately', () => {
  const ms = msUntilNext(new Date(2026, 0, 1, 2, 15, 0));
  assert.equal(ms, 24 * 3600 * 1000);
  const soon = msUntilNext(new Date(2026, 0, 1, 2, 14, 0));
  assert.ok(soon > 0 && soon <= 60 * 1000 + 1);
});

test('Linux defaults: HTTPS on 8443 in Dockerfile, compose and service unit', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('Dockerfile'), /HTTPS=auto/);
  assert.match(read('Dockerfile'), /EXPOSE 8443/);
  assert.match(read('docker-compose.yml'), /backup-schedule\.js/);
  assert.match(read('docker-compose.yml'), /ADMIN_PASSWORD: \$\{ADMIN_PASSWORD:-admin\}/);
  assert.match(read('deploy/inout-board.service'), /Environment=HTTPS=auto/);
  assert.match(read('deploy/inout-board.service'), /Environment=PORT=8443/);
  assert.match(read('.env.example'), /^HOST_PORT=8443$/m);
});
