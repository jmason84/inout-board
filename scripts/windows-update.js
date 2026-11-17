'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const REPO_DOWNLOAD = 'https://github.com/jmason84/inout-board/releases/download/';
function allowedUrl(value, initial) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return initial ? value.startsWith(REPO_DOWNLOAD) :
    ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname);
}

async function download(url, dest, limit, request = https.get, redirects = 0) {
  if (!allowedUrl(url, redirects === 0) || redirects > 5) throw new Error('Unexpected release download URL');
  await new Promise((resolve, reject) => {
    const req = request(url, { headers: { 'User-Agent': 'InOutBoard-Updater' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        try {
          const next = new URL(res.headers.location, url).href;
          download(next, dest, limit, request, redirects + 1).then(resolve, reject);
        } catch (err) { reject(err); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Release download returned HTTP ${res.statusCode}`)); return; }
      let bytes = 0;
      const bounded = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > limit ? new Error('Release download is too large') : null, chunk);
      } });
      pipeline(res, bounded, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 })).then(resolve, reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error('Release download timed out')), 120000);
    req.setTimeout(15000, () => req.destroy(new Error('Release download stalled')));
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });
}

function expectedHash(text, name) {
  const matches = text.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim()))
    .filter((m) => m && m[2] === name);
  if (matches.length !== 1) throw new Error('Release does not include one valid installer SHA-256 checksum');
  return matches[0][1].toLowerCase();
}

function createWindowsUpdater({ root, installDir, check, supported = false, downloadFile = download, launch = spawn }) {
  const dir = path.join(root, 'updates');
  const statusFile = path.join(dir, 'status.json');
  const pendingFile = path.join(dir, 'pending.json');
  const writeStatus = (state, message, version = '') => {
    fs.mkdirSync(dir, { recursive: true });
    const data = { state, message, version, updated_at: new Date().toISOString() };
    fs.writeFileSync(statusFile + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(statusFile + '.tmp', statusFile);
  };
  function status() {
    let data = { state: 'idle' };
    try { data = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* no update yet */ }
    let busy = fs.existsSync(pendingFile);
    if (busy) {
      try {
        const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        if (Number.isInteger(pending.pid) && pending.pid > 0) {
          try { process.kill(pending.pid, 0); }
          catch (err) {
            if (err.code === 'ESRCH') {
              writeStatus('error', 'The previous update was interrupted. Check the installed version before trying again.');
              fs.rmSync(pendingFile, { force: true });
              busy = false;
              data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            }
          }
        }
      } catch { /* retain the lock if its owner cannot be established */ }
    }
    return { ...data, supported, busy };
  }
  async function start() {
    if (!supported) throw Object.assign(new Error('Automatic installation is available on the installed Windows edition only.'), { status: 400 });
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(pendingFile, JSON.stringify({ pid: process.pid, requested_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (err) {
      if (err.code === 'EEXIST') throw Object.assign(new Error('An update is already in progress. Check its status before trying again.'), { status: 409 });
      throw err;
    }
    try {
      const release = await check({ refresh: true });
      if (release.error) throw new Error('Could not check GitHub: ' + release.error);
      if (!release.update_available || !release.installable) throw Object.assign(new Error('No newer published Windows installer is available.'), { status: 409 });
      const version = release.latest_version;
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
      const prefix = REPO_DOWNLOAD + 'v' + version + '/';
      const name = `InOutBoard-${version}-x64.msi`;
      if (release.installer_url !== prefix + name || release.checksum_url !== prefix + 'SHA256SUMS.txt') throw new Error('Unexpected release asset URL');
      writeStatus('downloading', `Downloading version ${version}. The board will restart after installation.`, version);
      const job = fs.mkdtempSync(path.join(dir, 'update-'));
      // Return promptly; downloads and preparation continue while the board serves requests.
      const completion = (async () => {
        try {
          const sums = path.join(job, 'SHA256SUMS.txt');
          const msi = path.join(job, name);
          await downloadFile(release.checksum_url, sums, 64 * 1024);
          const hash = expectedHash(fs.readFileSync(sums, 'utf8'), name);
          await downloadFile(release.installer_url, msi, 256 * 1024 * 1024);
          const digest = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(msi)) digest.update(chunk);
          const actual = digest.digest('hex');
          if (actual !== hash) throw new Error('Installer checksum verification failed; nothing was installed.');
          // Run outside Program Files so MSI can replace the installed scripts and node.exe.
          const worker = path.join(job, 'Install-Update.ps1');
          fs.copyFileSync(path.join(installDir, 'windows-update.ps1'), worker);
          writeStatus('prepared', 'Download verified. Starting backup and installation.', version);
          const child = launch(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', worker,
            '-MsiPath', msi, '-ExpectedHash', hash, '-Version', version, '-DataRoot', root, '-InstallDir', installDir,
          ], { detached: true, stdio: 'ignore', windowsHide: true });
          await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
          fs.writeFileSync(pendingFile, JSON.stringify({ pid: child.pid, version }), { mode: 0o600 });
          child.unref();
        } catch (err) {
          writeStatus('error', err.message, version);
          fs.rmSync(pendingFile, { force: true });
        }
      })();
      return { ...status(), completion };
    } catch (err) {
      fs.rmSync(pendingFile, { force: true });
      throw err;
    }
  }
  return { start, status };
}
module.exports = { createWindowsUpdater, expectedHash, download, allowedUrl };
