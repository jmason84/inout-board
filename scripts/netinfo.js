'use strict';

/**
 * Network helpers shared by server.js and the Windows installer scripts.
 *
 *   node scripts/netinfo.js          -> prints the usable addresses as JSON
 *   node scripts/netinfo.js --plain  -> one IPv4 per line, preferred first
 *
 * Nothing here is hard-coded to an adapter or an address: addresses are read
 * from the operating system every time, so a changed IP is picked up on the
 * next start.
 */

const os = require('node:os');
const dgram = require('node:dgram');

/** All non-internal, non-link-local addresses on this machine. */
function listAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.internal) continue;
      const family = typeof a.family === 'string' ? a.family : (a.family === 4 ? 'IPv4' : 'IPv6');
      if (family === 'IPv4' && a.address.startsWith('169.254.')) continue; // APIPA
      if (family === 'IPv6' && /^fe80:/i.test(a.address)) continue; // link-local
      out.push({ iface: name, family, address: a.address });
    }
  }
  return out;
}

/**
 * The local IPv4 address the OS would use to reach the outside world.
 * A UDP "connect" only consults the routing table; no packet is sent.
 */
function routeAddress(timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch (_) {} resolve(v); } };
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => finish(null));
    try {
      sock.connect(9, '192.0.2.1', () => {
        try { finish(sock.address().address); } catch (_) { finish(null); }
      });
    } catch (_) { finish(null); }
    setTimeout(() => finish(null), timeoutMs).unref();
  });
}

/**
 * Addresses to advertise, preferred one first.
 * PREFERRED_ADDRESS (env) wins when it is set; it only changes which link is
 * shown first, it never stops the server listening on the others.
 */
async function discover(preferredOverride = process.env.PREFERRED_ADDRESS) {
  const all = listAddresses();
  const route = await routeAddress();
  const preferred = (preferredOverride || '').trim() || route || null;
  const v4 = all.filter((a) => a.family === 'IPv4');
  const v6 = all.filter((a) => a.family === 'IPv6');
  const ordered = [...v4, ...v6].sort((a, b) => Number(b.address === preferred) - Number(a.address === preferred));
  return { preferred: preferred || (ordered[0] && ordered[0].address) || null, addresses: ordered };
}

/** Build a browsable URL; IPv6 literals need brackets. */
function urlFor(scheme, address, port, pathPart = '/') {
  const host = address.includes(':') ? `[${address}]` : address;
  const defaultPort = scheme === 'https' ? 443 : 80;
  const p = Number(port) === defaultPort ? '' : `:${port}`;
  return `${scheme}://${host}${p}${pathPart}`;
}

module.exports = { listAddresses, routeAddress, discover, urlFor };

if (require.main === module) {
  discover().then((info) => {
    if (process.argv.includes('--plain')) {
      const v4 = info.addresses.filter((a) => a.family === 'IPv4').map((a) => a.address);
      process.stdout.write(v4.join('\n') + (v4.length ? '\n' : ''));
    } else {
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    }
  });
}
