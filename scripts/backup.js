#!/usr/bin/env node
'use strict';

/**
 * Consistent backup of the database + uploaded photos.
 *
 *   node scripts/backup.js [destination-dir]
 *
 * Env: DATA_DIR (default ./data), KEEP (backups to retain, default 14).
 * Uses SQLite's VACUUM INTO, which is safe while the server is running
 * (a plain file copy of a live WAL database can be inconsistent).
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const destRoot = path.resolve(process.argv[2] || path.join(dataDir, 'backups'));
const keep = Math.max(1, Number(process.env.KEEP || 14));
const dbPath = path.join(dataDir, 'inout.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const dest = path.join(destRoot, `inout-${stamp}`);
fs.mkdirSync(dest, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${path.join(dest, 'inout.sqlite').replace(/'/g, "''")}'`);
db.close();

const uploads = path.join(dataDir, 'uploads');
if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(dest, 'uploads'), { recursive: true });

// Retention: keep the newest N backups in this folder.
const old = fs.readdirSync(destRoot).filter((n) => /^inout-\d{8}-\d{6}$/.test(n)).sort().reverse().slice(keep);
for (const n of old) fs.rmSync(path.join(destRoot, n), { recursive: true, force: true });

console.log(`Backup written to ${dest}` + (old.length ? ` (removed ${old.length} old)` : ''));
