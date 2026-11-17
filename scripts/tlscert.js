'use strict';
// Dependency-free private CA + server certificate for the IN/OUT Board.
//
// Lets the board serve HTTPS by itself (no reverse proxy needed). A small CA is
// created once; server certificates for this machine's IP addresses / host name
// are signed by it and re-issued automatically when the addresses change.
// People install the CA once (served at /ca.crt) and the browser then trusts
// https://<any address of this machine>/ with no warnings.
//
// Everything is built with node:crypto plus a minimal DER writer, so there is
// nothing to install. ECDSA P-256 / SHA-256 throughout.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// ---- minimal DER writer -----------------------------------------------------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...p) => tlv(0x30, Buffer.concat(p));
const set = (...p) => tlv(0x31, Buffer.concat(p));
const octets = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, body) => tlv(0xa0 | n, body);
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const chunk = [v & 0x7f];
    let rest = v >> 7;
    while (rest > 0) { chunk.unshift((rest & 0x7f) | 0x80); rest >>= 7; }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function bitString(buf, unused = 0) { return tlv(0x03, Buffer.concat([Buffer.from([unused]), buf])); }
function time(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const body = `${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  if (y >= 2050) return tlv(0x18, Buffer.from(`${y}${body.slice(2)}`));
  return tlv(0x17, Buffer.from(body));
}
function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  throw new Error('IPv6 addresses are not supported: ' + ip);
}
function name(cn, org) {
  const rdn = (o, v) => set(seq(oid(o), utf8(v)));
  return seq(...(org ? [rdn('2.5.4.10', org)] : []), rdn('2.5.4.3', cn));
}
function ext(id, critical, value) {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}
const ECDSA_SHA256 = () => seq(oid('1.2.840.10045.4.3.2'));
const serial = () => { const b = crypto.randomBytes(16); b[0] &= 0x7f; if (b[0] === 0) b[0] = 1; return b; };
const pem = (label, der) =>
  `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END ${label}-----\n`;

function sign(tbs, privateKey) {
  const sig = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA
  return seq(tbs, ECDSA_SHA256(), bitString(sig));
}
const spkiOf = (pub) => pub.export({ type: 'spki', format: 'der' });

// Raw DER of the subject Name of an existing certificate.
function subjectDer(certDer) {
  const read = (b, o) => {
    let len = b[o + 1], hdr = 2;
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | b[o + 2 + i]; hdr = 2 + n; }
    return { start: o, hdr, len, end: o + hdr + len };
  };
  const cert = read(certDer, 0);
  const tbs = read(certDer, cert.start + cert.hdr);
  let o = tbs.start + tbs.hdr;
  const skip = () => { const t = read(certDer, o); const r = certDer.subarray(t.start, t.end); o = t.end; return r; };
  if (certDer[o] === 0xa0) skip(); // version
  skip(); skip(); skip(); skip();  // serial, signature alg, issuer, validity
  return skip();                   // subject
}

// ---- certificates -----------------------------------------------------------
const DAY = 86400000;

function createCa(cn = 'IN/OUT Board Local CA') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = name(cn, 'IN/OUT Board');
  const ski = crypto.createHash('sha1').update(spkiOf(publicKey)).digest();
  const now = Date.now();
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), integer(serial()), ECDSA_SHA256(),
    subject, seq(time(new Date(now - DAY)), time(new Date(now + 3650 * DAY))), subject,
    spkiOf(publicKey),
    explicit(3, seq(
      ext('2.5.29.19', true, seq(bool(true))),
      ext('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)), // keyCertSign, cRLSign
      ext('2.5.29.14', false, octets(ski)),
    )),
  );
  return {
    certPem: pem('CERTIFICATE', sign(tbs, privateKey)),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function createLeaf({ ca, ips = [], dns = [], days = 397 }) {
  const caCert = new crypto.X509Certificate(ca.certPem);
  const caKey = crypto.createPrivateKey(ca.keyPem);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cn = dns[0] || ips[0] || 'inout-board';
  const gn = [
    ...dns.map((d) => tlv(0x82, Buffer.from(d))),
    ...ips.map((i) => tlv(0x87, ipBytes(i))),
  ];
  const now = Date.now();
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), integer(serial()), ECDSA_SHA256(),
    subjectDer(caCert.raw), seq(time(new Date(now - DAY)), time(new Date(now + days * DAY))),
    name(cn, 'IN/OUT Board'), spkiOf(publicKey),
    explicit(3, seq(
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, seq(...gn)),
    )),
  );
  return {
    certPem: pem('CERTIFICATE', sign(tbs, caKey)),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// ---- persistence ------------------------------------------------------------
function write(file, data, mode) { fs.writeFileSync(file, data, { mode }); }
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

// Reuse the CA from an earlier Caddy-based install so devices that already
// trust it keep working with no re-install.
function adoptLegacyCa(legacyDir) {
  if (!legacyDir) return null;
  const crt = read(path.join(legacyDir, 'root.crt'));
  const key = read(path.join(legacyDir, 'root.key'));
  if (!crt || !key) return null;
  try {
    new crypto.X509Certificate(crt);
    crypto.createPrivateKey(key);
    return { certPem: crt, keyPem: key, adopted: true };
  } catch { return null; }
}

function loadCa(dir, legacyDir) {
  const crt = read(path.join(dir, 'ca.crt'));
  const key = read(path.join(dir, 'ca.key'));
  if (crt && key) return { certPem: crt, keyPem: key };
  const ca = adoptLegacyCa(legacyDir) || createCa();
  write(path.join(dir, 'ca.key'), ca.keyPem, 0o600);
  write(path.join(dir, 'ca.crt'), ca.certPem, 0o644);
  return ca;
}

// Returns { key, cert, caPem, sans } and (re)issues the server certificate when
// it is missing, close to expiry, or no longer covers the wanted addresses.
function ensure({ dir, ips = [], dns = [], legacyDir = null, renewDays = 30 }) {
  fs.mkdirSync(dir, { recursive: true });
  const ca = loadCa(dir, legacyDir);
  const sans = JSON.stringify({ ips: [...ips].sort(), dns: [...dns].sort() });
  const certFile = path.join(dir, 'server.crt');
  const keyFile = path.join(dir, 'server.key');
  const sansFile = path.join(dir, 'server.sans');
  let cert = read(certFile);
  let key = read(keyFile);
  let fresh = false;
  if (cert && key && read(sansFile) === sans) {
    try {
      const x = new crypto.X509Certificate(cert);
      const left = new Date(x.validTo).getTime() - Date.now();
      fresh = left > renewDays * DAY && x.verify(new crypto.X509Certificate(ca.certPem).publicKey);
    } catch { fresh = false; }
  }
  if (!fresh) {
    const leaf = createLeaf({ ca, ips, dns });
    cert = leaf.certPem; key = leaf.keyPem;
    write(keyFile, key, 0o600);
    write(certFile, cert, 0o644);
    write(sansFile, sans, 0o644);
  }
  return { key, cert, caPem: ca.certPem, sans, reissued: !fresh };
}

module.exports = { ensure, createCa, createLeaf };
