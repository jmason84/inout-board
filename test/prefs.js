'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/prefs.js'), 'utf8');

function browser(storage = new Map(), blocked = false) {
  const attributes = new Map();
  const context = {
    window: {},
    document: { documentElement: {
      setAttribute: (k, v) => attributes.set(k, v),
      removeAttribute: (k) => attributes.delete(k),
    } },
    localStorage: {
      getItem(k) { if (blocked) throw new Error('storage blocked'); return storage.get(k) ?? null; },
      setItem(k, v) { if (blocked) throw new Error('storage blocked'); storage.set(k, v); },
      removeItem(k) { if (blocked) throw new Error('storage blocked'); storage.delete(k); },
    },
  };
  vm.runInNewContext(source, context);
  return { prefs: context.window.IOPrefs, attributes, storage };
}

test('explicit system choice survives reload and overrides the admin default', () => {
  const first = browser();
  first.prefs.setTheme('system');
  assert.equal(first.storage.get('inout_theme'), 'system');
  const second = browser(first.storage);
  second.prefs.applyDefaultTheme('dark');
  assert.equal(second.prefs.getTheme(), 'system');
  assert.equal(second.attributes.has('data-theme'), false);
});

test('unselected browsers follow changing defaults without saving an override', () => {
  const b = browser();
  b.prefs.applyDefaultTheme('dark');
  assert.equal(b.attributes.get('data-theme'), 'dark');
  assert.equal(b.prefs.getTheme(), 'dark');
  assert.equal(b.storage.has('inout_theme'), false);
  b.prefs.applyDefaultTheme('light');
  assert.equal(b.attributes.get('data-theme'), 'light');
  b.prefs.setTheme('dark');
  b.prefs.applyDefaultTheme('light');
  assert.equal(b.attributes.get('data-theme'), 'dark');
});

test('blocked storage keeps a user choice in memory; invalid theme is ignored', () => {
  const b = browser(new Map(), true);
  b.prefs.setTheme('light');
  b.prefs.applyDefaultTheme('dark');
  assert.equal(b.prefs.getTheme(), 'light');
  assert.equal(b.attributes.get('data-theme'), 'light');
  b.prefs.setTheme('neon');
  assert.equal(b.prefs.getTheme(), 'light');
});
