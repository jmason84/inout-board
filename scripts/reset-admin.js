#!/usr/bin/env node
'use strict';

/**
 * Reset (or create) an admin account.
 *
 *   node scripts/reset-admin.js                      -> admin / admin, must choose a new password at next sign-in
 *   node scripts/reset-admin.js jordan 'a-long-pass' -> that user and password, no forced change
 *
 * Env: DATA_DIR (default ./data). Stop the app first (or at least expect every admin session to end).
 * Replaces the old "DELETE FROM admin_users" recovery recipe: it keeps other admins, signs the
 * account out everywhere, and works whether or not the account already exists.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dbPath = path.join(dataDir, 'inout.sqlite');
const username = (process.argv[2] || 'admin').trim();
const explicit = process.argv[3] !== undefined;
const password = explicit ? String(process.argv[3]) : 'admin';

if (!username) { console.error('Username must not be empty'); process.exit(2); }
if (explicit && password.length < 10) { console.error('A chosen password must be at least 10 characters'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error(`No database found at ${dbPath}. Start the app once first.`); process.exit(1); }

const salt = crypto.randomBytes(16);
const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
const mustChange = explicit ? 0 : 1;

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
const cols = db.prepare('PRAGMA table_info(admin_users)').all();
if (!cols.some((c) => c.name === 'must_change')) db.exec('ALTER TABLE admin_users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');

const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE admin_users SET password_hash = ?, must_change = ? WHERE id = ?').run(hash, mustChange, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Reset the password for admin "${username}".`);
} else {
  db.prepare('INSERT INTO admin_users (username, password_hash, created_at, must_change) VALUES (?, ?, ?, ?)')
    .run(username, hash, Date.now(), mustChange);
  console.log(`Created admin "${username}".`);
}
console.log(mustChange
  ? `Sign in as ${username} / ${password}. You will be asked to choose a new password straight away.`
  : `Sign in as ${username} with the password you gave.`);
db.close();
