#!/usr/bin/env node
'use strict';

/**
 * Fills a running IN/OUT Board with a fictional plaza (Riverside Plaza) so you can
 * try every feature, take screenshots, or demo it. All names, phone numbers and logos
 * are made up.
 *
 *   BASE=http://localhost:3000 ADMIN_USER=admin ADMIN_PASSWORD=... node scripts/seed-demo.js
 *
 * It first removes the built-in sample tenant ("Main Office") so the demo is clean,
 * so only run it against a new or throwaway database.
 */

const zlib = require('node:zlib');

const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('Set ADMIN_PASSWORD (and ADMIN_USER / BASE if they differ).'); process.exit(1); }

// ---- tiny PNG encoder (so the script has no dependencies) -------------------
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, pixel) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { const [R, G, B] = pixel(x, y); r[1 + x * 3] = R; r[2 + x * 3] = G; r[3 + x * 3] = B; }
    rows.push(r);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// A simple head-and-shoulders portrait.
function portrait(skin, shirt, bg) {
  const [S, T, G] = [hex(skin), hex(shirt), hex(bg)];
  return png(320, 320, (x, y) => {
    const dx = x - 160, dy = y - 135;
    if (dx * dx + dy * dy < 62 * 62) return S;                                   // head
    if (y > 215 && ((x - 160) ** 2) / (125 * 125) + ((y - 330) ** 2) / (135 * 135) < 1) return T; // shoulders
    return [Math.round(G[0] - y / 12), Math.round(G[1] - y / 14), G[2]];         // soft background
  });
}
// A simple company mark: coloured tile with a shape.
function makeLogo(bg, fg, shape) {
  const [B, F] = [hex(bg), hex(fg)];
  return png(320, 160, (x, y) => {
    const cx = 160, cy = 80;
    const inShape = shape === 'circle' ? (x - cx) ** 2 + (y - cy) ** 2 < 46 * 46
      : shape === 'diamond' ? Math.abs(x - cx) + Math.abs(y - cy) < 56
      : shape === 'bars' ? (y > 40 && y < 120 && (x % 40) < 22 && x > 80 && x < 240)
      : (x > 96 && x < 224 && y > 52 && y < 108);
    return inShape ? F : B;
  });
}

// ---- API helper ------------------------------------------------------------
let cookie = '';
async function api(method, url, body, image) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Cookie: cookie, 'Content-Type': image ? 'image/png' : 'application/json' },
    body: image ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// ---- the fictional plaza ---------------------------------------------------
const TENANTS = [
  { name: 'Riverside Plaza Management', office: 'Ground floor', phone: '605-555-0100', email: 'frontdesk@riverside.example', website: 'riverside.example', logo: ['#1f5fa8', '#ffffff', 'bars'] },
  { name: 'Cedar & Finch Law', office: 'Suite 210', phone: '605-555-0142', email: 'office@cedarfinch.example', website: 'cedarfinch.example', logo: ['#6b2d8a', '#ffffff', 'diamond'] },
  { name: 'Brightside Family Dental', office: 'Suite 105', phone: '605-555-0177', email: 'hello@brightsidedental.example', website: 'brightsidedental.example', logo: ['#0b8577', '#ffffff', 'circle'] },
  { name: 'Harbor Light Accounting', office: 'Suite 301', phone: '605-555-0166', website: 'harborlight.example', logo: ['#b4541a', '#fff4e5', 'tile'] },
  { name: 'Northwind Design Studio', office: 'Suite 320', phone: '605-555-0190', email: 'studio@northwind.example', logo: ['#222b3a', '#8fd3ff', 'diamond'] },
];

const SKIN = ['#f0c8a0', '#d9a577', '#b57b50', '#8d5a3a', '#f4d3b5', '#6f4630'];
const SHIRT = ['#2f5aa8', '#a33b6b', '#2f7d5b', '#b5651d', '#5a4a9a', '#3a6f8f', '#8a2f3a', '#40505f'];
const BG = ['#cfe3f7', '#e6d8f2', '#d6efdc', '#f8e3c4', '#f6d6dc', '#d4e8ee'];

// photo: true = upload a portrait. vis: which details are public. avatar: photo | logo | initials
const PEOPLE = {
  'Riverside Plaza Management': [
    { name: 'Rosa Alvarez', title: 'Property Manager', office: 'Front desk', phone: '605-555-0101', email: 'rosa@riverside.example', show: 'office phone email', photo: true, status: 'in' },
    { name: 'Marcus Webb', title: 'Maintenance Lead', office: 'Basement shop', phone: '605-555-0102', show: 'office phone', status: 'in' },
    { name: 'Tess Okafor', title: 'Receptionist', office: 'Front desk', show: 'office', photo: true, status: 'in' },
    { name: 'Gil Navarro', title: 'Security', office: 'Lobby', show: 'office', avatar: 'initials', status: 'out' },
  ],
  'Cedar & Finch Law': [
    { name: 'Maria Delgado', title: 'Partner', office: 'Suite 212', phone: '605-555-0143', email: 'maria@cedarfinch.example', show: 'office phone email', avatar: 'logo', status: 'in', manager: true },
    { name: 'Tom Whitehorse', title: 'Paralegal', office: 'Suite 214', phone: '605-555-0144', show: 'office phone', photo: true, status: 'in' },
    { name: 'Priya Raman', title: 'Associate Attorney', office: 'Suite 213', email: 'priya@cedarfinch.example', show: 'office email', avatar: 'logo', status: 'out' },
    { name: 'Owen Larkin', title: 'Legal Assistant', office: 'Suite 211', show: 'office', status: 'none' },
    { name: 'Hana Sato', title: 'Associate Attorney', office: 'Suite 215', phone: '605-555-0146', show: 'phone', photo: true, status: 'in' },
  ],
  'Brightside Family Dental': [
    { name: 'Dr. Lena Ortiz', title: 'Dentist', office: 'Suite 105', phone: '605-555-0178', show: 'office phone', avatar: 'logo', status: 'in' },
    { name: 'Dr. Ben Achterberg', title: 'Dentist', office: 'Suite 106', show: 'office', photo: true, status: 'out' },
    { name: 'Sam Eagle', title: 'Hygienist', office: 'Suite 107', show: 'office', status: 'in' },
    { name: 'Kiara Bell', title: 'Dental Assistant', office: 'Suite 107', show: 'office', photo: true, status: 'in' },
    { name: 'Ivy Moreno', title: 'Office Coordinator', office: 'Reception', phone: '605-555-0179', email: 'ivy@brightsidedental.example', show: 'office phone email', status: 'none' },
  ],
  'Harbor Light Accounting': [
    { name: 'Daniel Park', title: 'CPA, Owner', office: 'Suite 301', phone: '605-555-0167', email: 'daniel@harborlight.example', show: 'office phone email', photo: true, status: 'in' },
    { name: 'Amy Short', title: 'Tax Preparer', office: 'Suite 303', show: 'office', avatar: 'logo', status: 'in' },
    { name: 'Neil Dawson', title: 'Bookkeeper', office: 'Suite 304', phone: '605-555-0169', show: 'phone', status: 'out' },
    { name: 'Joy Fenner', title: 'Client Services', office: 'Suite 302', show: 'office', photo: true, status: 'none' },
  ],
  'Northwind Design Studio': [
    { name: 'Elena Ruiz', title: 'Creative Director', office: 'Suite 320', phone: '605-555-0191', email: 'elena@northwind.example', show: 'office email', photo: true, status: 'in' },
    { name: 'Jonah Pike', title: 'Designer', office: 'Suite 321', show: 'office', status: 'out' },
    { name: 'Wren Calloway', title: 'Studio Manager', office: 'Suite 322', show: 'office phone', phone: '605-555-0193', avatar: 'initials', status: 'in' },
  ],
};

(async () => {
  await api('POST', '/api/auth/login', { username: USER, password: PASS });

  // clean slate: drop the built-in sample tenant
  for (const t of await api('GET', '/api/tenants')) if (t.name === 'Main Office') await api('DELETE', `/api/tenants/${t.id}`);

  const ids = {};
  let n = 0;
  for (const t of TENANTS) {
    const { logo, ...fields } = t;
    const created = await api('POST', '/api/tenants', fields);
    await api('PUT', `/api/tenants/${created.id}/logo`, makeLogo(...logo), true);
    ids[t.name] = created.id;
  }

  const people = [];
  let v = 0;
  for (const [tenant, list] of Object.entries(PEOPLE)) {
    for (const p of list) {
      const created = await api('POST', '/api/people', { name: p.name, tenant_id: ids[tenant] });
      const show = new Set((p.show || '').split(' '));
      await api('PUT', `/api/people/${created.id}`, {
        name: p.name, tenant_id: ids[tenant], active: true,
        title: p.title, office: p.office || '', phone: p.phone || '', email: p.email || '',
        show_office: show.has('office'), show_phone: show.has('phone'), show_email: show.has('email'),
        avatar_mode: p.avatar || 'photo', is_manager: !!p.manager,
      });
      if (p.photo) { await api('PUT', `/api/people/${created.id}/photo`, portrait(SKIN[v % SKIN.length], SHIRT[(v * 3) % SHIRT.length], BG[v % BG.length]), true); v++; }
      people.push({ ...p, id: created.id });
      n++;
    }
  }

  // a few days of shift history so the Time Log has something to show
  const H = 3600000, D = 24 * H;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const workers = people.filter((p) => p.status !== 'none').slice(0, 14);
  for (let d = 4; d >= 1; d--) {
    for (const [i, p] of workers.entries()) {
      if ((i + d) % 5 === 0) continue; // not everyone every day
      const start = dayStart.getTime() - d * D + (7.5 + (i % 4) * 0.5) * H;
      const end = start + (7.5 + ((i + d) % 3) * 0.75) * H;
      await api('POST', '/api/events', { person_id: p.id, direction: 'in', clocked_at: start, notes: '' });
      await api('POST', '/api/events', { person_id: p.id, direction: 'out', clocked_at: end, notes: '' });
    }
  }

  // today's live statuses (through the public endpoint, like the real board)
  for (const p of people) {
    if (p.status === 'none') continue;
    await fetch(BASE + '/api/clock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ person_id: p.id, direction: 'in' }) });
    if (p.status === 'out') await fetch(BASE + '/api/clock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ person_id: p.id, direction: 'out' }) });
  }

  // one tenant manager with a sign-in, so /me can be tried
  const manager = people.find((p) => p.manager);
  const access = await api('POST', `/api/people/${manager.id}/access`);

  console.log(`Seeded ${TENANTS.length} tenants and ${n} people.`);
  console.log(`Try /me as a tenant manager: sign-in "${access.handle}", temporary password "${access.temp_password}"`);
})().catch((e) => { console.error('Seeding failed:', e.message); process.exit(1); });
