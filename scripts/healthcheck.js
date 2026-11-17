#!/usr/bin/env node
'use strict';

/**
 * Container / service health probe: exits 0 if GET /api/health answers {"ok":true}.
 * Works for plain HTTP and for HTTPS (HTTPS=auto uses a private CA, so the
 * certificate is deliberately not verified - this only probes 127.0.0.1).
 */

const http = require('node:http');
const https = require('node:https');

const port = Number(process.env.PORT || 3000);
const tls = Boolean((process.env.TLS_CERT && process.env.TLS_KEY) || String(process.env.HTTPS || '').toLowerCase() === 'auto');
const lib = tls ? https : http;

const req = lib.get(
  { host: '127.0.0.1', port, path: '/api/health', timeout: 4000, rejectUnauthorized: false },
  (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let ok = false;
      try { ok = res.statusCode === 200 && JSON.parse(body).ok === true; } catch (_) { /* not JSON */ }
      process.exit(ok ? 0 : 1);
    });
  }
);
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
