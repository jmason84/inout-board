#!/usr/bin/env node
'use strict';

/**
 * Builds the GitHub Pages site into ./_site
 *
 *   _site/index.html       landing page (pages/index.html) with screenshots
 *   _site/app/             the real front end (public/) wired to the in-browser demo backend
 *   _site/screenshots/     docs/screenshots
 *
 * The demo backend (pages/demo-api.js) replaces server.js, which GitHub Pages cannot run.
 * Only fictional demo data is published: assets/ (the original board photo) is never copied.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const APP = path.join(OUT, 'app');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 1. the real front end, made relative so it works under /<repo>/app/
for (const name of fs.readdirSync(path.join(ROOT, 'public'))) {
  const src = path.join(ROOT, 'public', name);
  if (!fs.statSync(src).isFile()) continue;
  let body = fs.readFileSync(src, 'utf8');
  if (name.endsWith('.html')) {
    body = body
      .replace(/href="\/"/g, 'href="index.html"')
      .replace(/href="\/admin"/g, 'href="admin.html"')
      .replace(/href="\/me"/g, 'href="me.html"')
      .replace(/(src|href)="\/([^"\/][^"]*)"/g, '$1="$2"')                       // /style.css -> style.css
      .replace(/<script src="prefs\.js"><\/script>/, '<script src="demo-api.js"></script>\n  <script src="prefs.js"></script>')
      .replace(/<title>([^<]*)<\/title>/, '<title>$1 (demo)</title>');
  } else if (name === 'app.js') {
    body = body.replace('href="/?layout=${o.id}"', 'href="index.html?layout=${o.id}"');
  }
  fs.writeFileSync(path.join(APP, name), body);
}
fs.copyFileSync(path.join(ROOT, 'pages', 'demo-api.js'), path.join(APP, 'demo-api.js'));

// 2. landing page + screenshots
for (const f of ['index.html', 'landing.css']) fs.copyFileSync(path.join(ROOT, 'pages', f), path.join(OUT, f));
const shots = path.join(ROOT, 'docs', 'screenshots');
if (fs.existsSync(shots)) fs.cpSync(shots, path.join(OUT, 'screenshots'), { recursive: true });

// 3. plain static hosting
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`Built ${path.relative(ROOT, OUT)}/ (${fs.readdirSync(APP).length} app files)`);
