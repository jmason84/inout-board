'use strict';
const https = require('node:https');

// Release tags in this repository include v1.0 as well as three-part versions.
function releaseVersion(value) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function isNewer(current, latest) {
  const a = releaseVersion(current), b = releaseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] > a[i];
  }
  return false;
}

function createUpdateChecker({ version, request = https.request, now = Date.now }) {
  let cached = null, expires = 0, pending = null;
  return function checkForUpdate() {
    if (cached && now() < expires) return Promise.resolve(cached);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const req = request({
        hostname: 'api.github.com', path: '/repos/jmason84/inout-board/releases/latest',
        method: 'GET', timeout: 8000,
        headers: { 'User-Agent': `InOutBoard/${version}`, Accept: 'application/vnd.github+json' },
      }, (res) => {
        let body = '';
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('GitHub response interrupted')));
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) req.destroy(new Error('GitHub response too large'));
        });
        res.on('end', () => {
          try {
            if (res.statusCode === 404) return resolve({ update_available: false, current_version: version });
            if (res.statusCode !== 200) throw new Error(`GitHub API returned ${res.statusCode}`);
            const rel = JSON.parse(body);
            const releaseUrl = typeof rel.html_url === 'string' &&
              rel.html_url.startsWith('https://github.com/jmason84/inout-board/releases/') ? rel.html_url : '';
            resolve({
              update_available: !rel.prerelease && !rel.draft && isNewer(version, rel.tag_name),
              current_version: version, latest_version: String(rel.tag_name || '').replace(/^v/, ''),
              release_name: rel.name || '', release_url: releaseUrl, published_at: rel.published_at || '',
            });
          } catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('GitHub request timed out')));
      req.end();
    }).catch((err) => ({ update_available: false, current_version: version, error: err.message }))
      .then((result) => {
        cached = result;
        // Cache failures too, so each overview refresh cannot exhaust the API limit.
        expires = now() + (result.error ? 5 * 60 * 1000 : 60 * 60 * 1000);
        return result;
      }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createUpdateChecker, isNewer };
