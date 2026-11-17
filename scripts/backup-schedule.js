#!/usr/bin/env node
'use strict';

/**
 * Nightly backup loop, used by the Docker Compose "backup" service.
 *
 *   node scripts/backup-schedule.js
 *
 * Env: BACKUP_TIME (local HH:MM, default 02:15), BACKUP_DIR (default DATA_DIR/backups),
 *      KEEP (default 14), DATA_DIR. Runs scripts/backup.js once a day at BACKUP_TIME.
 * Set TZ on the container if "local" should not be UTC.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const m = /^(\d{1,2}):(\d{2})$/.exec(process.env.BACKUP_TIME || '02:15');
const hour = m ? Math.min(23, Number(m[1])) : 2;
const minute = m ? Math.min(59, Number(m[2])) : 15;
const dataDir = path.resolve(process.env.DATA_DIR || '/data');
const destDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');

function msUntilNext(now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function runBackup() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'backup.js'), destDir], { stdio: 'inherit', env: process.env });
  console.log(r.status === 0 ? 'Nightly backup finished.' : `Nightly backup FAILED (exit ${r.status}).`);
}

function schedule() {
  const wait = msUntilNext();
  console.log(`Next backup in ${Math.round(wait / 60000)} min (daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}).`);
  setTimeout(() => { runBackup(); schedule(); }, wait);
}

module.exports = { msUntilNext };
if (require.main === module) { if (process.argv.includes('--now')) runBackup(); else schedule(); }
