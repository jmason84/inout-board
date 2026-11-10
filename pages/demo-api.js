'use strict';
/*
 * IN/OUT Board - in-browser demo backend (GitHub Pages).
 *
 * GitHub Pages can only host static files, so this script stands in for server.js:
 * it intercepts fetch('/api/...') and answers from a small made-up dataset kept in the
 * visitor's own localStorage. The real front end (public/*.js) runs unchanged on top of it.
 * Nothing is sent anywhere, and "Reset demo" in the banner restores the original data.
 *
 * Demo sign-ins:  admin  demo / demo      person page (/me)  maria.delgado / demo
 */
(() => {
  const KEY = 'inout_demo_v2';
  const DAY = 86400000, HOUR = 3600000;

  // ------------------------------------------------------------------ pictures (generated SVG, no files)
  const svg = (s) => 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
  const portrait = (skin, shirt, bg) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="${bg}"/><ellipse cx="80" cy="150" rx="62" ry="48" fill="${shirt}"/><circle cx="80" cy="66" r="31" fill="${skin}"/></svg>`);
  const mark = (bg, fg, shape) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 80"><rect width="160" height="80" fill="${bg}"/>${
    shape === 'circle' ? `<circle cx="80" cy="40" r="23" fill="${fg}"/>`
    : shape === 'diamond' ? `<path d="M80 12 L108 40 L80 68 L52 40Z" fill="${fg}"/>`
    : shape === 'bars' ? [48, 68, 88, 108].map((x) => `<rect x="${x - 6}" y="20" width="12" height="40" fill="${fg}"/>`).join('')
    : `<rect x="48" y="26" width="64" height="28" fill="${fg}"/>`}</svg>`);

  const SKIN = ['#f0c8a0', '#d9a577', '#b57b50', '#8d5a3a', '#f4d3b5', '#6f4630'];
  const SHIRT = ['#2f5aa8', '#a33b6b', '#2f7d5b', '#b5651d', '#5a4a9a', '#3a6f8f', '#8a2f3a', '#40505f'];
  const BG = ['#cfe3f7', '#e6d8f2', '#d6efdc', '#f8e3c4', '#f6d6dc', '#d4e8ee'];

  // ------------------------------------------------------------------ the fictional plaza
  const TENANTS = [
    { name: 'Riverside Plaza Management', office: 'Ground floor', phone: '605-555-0100', email: 'frontdesk@riverside.example', website: 'https://riverside.example', logo: ['#1f5fa8', '#ffffff', 'bars'] },
    { name: 'Cedar & Finch Law', office: 'Suite 210', phone: '605-555-0142', email: 'office@cedarfinch.example', website: 'https://cedarfinch.example', logo: ['#6b2d8a', '#ffffff', 'diamond'] },
    { name: 'Brightside Family Dental', office: 'Suite 105', phone: '605-555-0177', email: 'hello@brightsidedental.example', website: 'https://brightsidedental.example', logo: ['#0b8577', '#ffffff', 'circle'] },
    { name: 'Harbor Light Accounting', office: 'Suite 301', phone: '605-555-0166', email: '', website: 'https://harborlight.example', logo: ['#b4541a', '#fff4e5', 'tile'] },
    { name: 'Northwind Design Studio', office: 'Suite 320', phone: '605-555-0190', email: 'studio@northwind.example', website: '', logo: ['#222b3a', '#8fd3ff', 'diamond'] },
  ];
  // t = tenant index, show = which details are public, st = today's status
  const PEOPLE = [
    { t: 0, name: 'Rosa Alvarez', title: 'Property Manager', office: 'Front desk', phone: '605-555-0101', email: 'rosa@riverside.example', show: 'office phone email', photo: 1, st: 'in' },
    { t: 0, name: 'Marcus Webb', title: 'Maintenance Lead', office: 'Basement shop', phone: '605-555-0102', show: 'office phone', st: 'in' },
    { t: 0, name: 'Tess Okafor', title: 'Receptionist', office: 'Front desk', show: 'office', photo: 1, st: 'in' },
    { t: 0, name: 'Gil Navarro', title: 'Security', office: 'Lobby', show: 'office', avatar: 'initials', st: 'out' },
    { t: 1, name: 'Maria Delgado', title: 'Partner', office: 'Suite 212', phone: '605-555-0143', email: 'maria@cedarfinch.example', show: 'office phone email', avatar: 'logo', st: 'in', manager: 1, handle: 'maria.delgado' },
    { t: 1, name: 'Tom Whitehorse', title: 'Paralegal', office: 'Suite 214', phone: '605-555-0144', show: 'office phone', photo: 1, st: 'in' },
    { t: 1, name: 'Priya Raman', title: 'Associate Attorney', office: 'Suite 213', email: 'priya@cedarfinch.example', show: 'office email', avatar: 'logo', st: 'out' },
    { t: 1, name: 'Owen Larkin', title: 'Legal Assistant', office: 'Suite 211', show: 'office', st: 'none' },
    { t: 1, name: 'Hana Sato', title: 'Associate Attorney', office: 'Suite 215', phone: '605-555-0146', show: 'phone', photo: 1, st: 'in' },
    { t: 2, name: 'Dr. Lena Ortiz', title: 'Dentist', office: 'Suite 105', phone: '605-555-0178', show: 'office phone', avatar: 'logo', st: 'in' },
    { t: 2, name: 'Dr. Ben Achterberg', title: 'Dentist', office: 'Suite 106', show: 'office', photo: 1, st: 'out' },
    { t: 2, name: 'Sam Eagle', title: 'Hygienist', office: 'Suite 107', show: 'office', st: 'in' },
    { t: 2, name: 'Kiara Bell', title: 'Dental Assistant', office: 'Suite 107', show: 'office', photo: 1, st: 'in' },
    { t: 2, name: 'Ivy Moreno', title: 'Office Coordinator', office: 'Reception', phone: '605-555-0179', email: 'ivy@brightsidedental.example', show: 'office phone email', st: 'none' },
    { t: 3, name: 'Daniel Park', title: 'CPA, Owner', office: 'Suite 301', phone: '605-555-0167', email: 'daniel@harborlight.example', show: 'office phone email', photo: 1, st: 'in' },
    { t: 3, name: 'Amy Short', title: 'Tax Preparer', office: 'Suite 303', show: 'office', avatar: 'logo', st: 'in' },
    { t: 3, name: 'Neil Dawson', title: 'Bookkeeper', office: 'Suite 304', phone: '605-555-0169', show: 'phone', st: 'out' },
    { t: 3, name: 'Joy Fenner', title: 'Client Services', office: 'Suite 302', show: 'office', photo: 1, st: 'none' },
    { t: 4, name: 'Elena Ruiz', title: 'Creative Director', office: 'Suite 320', phone: '605-555-0191', email: 'elena@northwind.example', show: 'office email', photo: 1, st: 'in' },
    { t: 4, name: 'Jonah Pike', title: 'Designer', office: 'Suite 321', show: 'office', st: 'out' },
    { t: 4, name: 'Wren Calloway', title: 'Studio Manager', office: 'Suite 322', phone: '605-555-0193', show: 'office phone', avatar: 'initials', st: 'in' },
  ];

  function freshState() {
    const s = { tenants: [], people: [], events: [], settings: { kiosk_layout: 'table', kiosk_mode: 'browse' }, seq: { event: 1 } };
    TENANTS.forEach((t, i) => s.tenants.push({ id: i + 1, name: t.name, notes: '', office: t.office, phone: t.phone, email: t.email, website: t.website, logo: mark(...t.logo) }));
    let v = 0;
    PEOPLE.forEach((p, i) => {
      const show = new Set((p.show || '').split(' '));
      s.people.push({
        id: i + 1, tenant_id: p.t + 1, name: p.name, title: p.title, office: p.office || '', phone: p.phone || '', email: p.email || '', bio: '',
        photo: p.photo ? portrait(SKIN[v % SKIN.length], SHIRT[(v++ * 3) % SHIRT.length], BG[i % BG.length]) : null,
        active: 1, show_office: show.has('office') ? 1 : 0, show_phone: show.has('phone') ? 1 : 0, show_email: show.has('email') ? 1 : 0,
        avatar_mode: p.avatar || 'photo', is_manager: p.manager ? 1 : 0, handle: p.handle || null, must_change: 0,
      });
    });
    // a few days of shifts, then today's live status
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const ev = (pid, dir, at) => s.events.push({ id: s.seq.event++, person_id: pid, tenant_id: s.people[pid - 1].tenant_id, direction: dir, clocked_at: at, notes: '' });
    const workers = s.people.filter((_, i) => PEOPLE[i].st !== 'none').slice(0, 14);
    for (let d = 4; d >= 1; d--) {
      workers.forEach((p, i) => {
        if ((i + d) % 5 === 0) return;
        const start = today.getTime() - d * DAY + (7.5 + (i % 4) * 0.5) * HOUR;
        ev(p.id, 'in', start); ev(p.id, 'out', start + (7.5 + ((i + d) % 3) * 0.75) * HOUR);
      });
    }
    const now = Date.now();
    s.people.forEach((p, i) => {
      const st = PEOPLE[i].st;
      if (st === 'none') return;
      const inAt = Math.min(now - 5 * 60000, today.getTime() + (7.75 + (i % 5) * 0.4) * HOUR);
      ev(p.id, 'in', inAt);
      if (st === 'out') ev(p.id, 'out', Math.min(now - 2 * 60000, inAt + (2 + (i % 3)) * HOUR));
    });
    return s;
  }

  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch { S = null; }
  if (!S || !S.tenants) S = freshState();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* quota or private mode: keep in memory */ } };
  save();

  // ------------------------------------------------------------------ helpers
  const tenant = (id) => S.tenants.find((t) => t.id === id);
  const person = (id) => S.people.find((p) => p.id === id);
  const last = (pid) => { let b = null; for (const e of S.events) if (e.person_id === pid && (!b || e.clocked_at > b.clocked_at || (e.clocked_at === b.clocked_at && e.id > b.id))) b = e; return b; };
  const avatarUrl = (p) => (p.avatar_mode === 'initials' ? null : p.avatar_mode === 'logo' ? tenant(p.tenant_id).logo : p.photo);
  const avatarKind = (p) => (avatarUrl(p) ? (p.avatar_mode === 'logo' ? 'logo' : 'photo') : null);
  const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const ERR = (status, error) => J({ error }, status);
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const CSV = (name, head, rows) => new Response('﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${name}"` } });
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const bool = (v) => (v === true || v === 1 || v === '1' ? 1 : 0);
  const readBlob = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

  function statusRow(p, full) {
    const l = last(p.id), t = tenant(p.tenant_id);
    const base = {
      id: p.id, name: p.name, title: p.title, status: l ? l.direction : 'none', clocked_at: l ? l.clocked_at : null,
      avatar_url: avatarUrl(p), avatar_kind: avatarKind(p), tenant_id: p.tenant_id, tenant_name: t.name, notes: l ? l.notes : '',
    };
    if (full) return { ...base, phone: p.phone, email: p.email, office: p.office, photo_url: p.photo, avatar_mode: p.avatar_mode, show_phone: !!p.show_phone, show_email: !!p.show_email, show_office: !!p.show_office, is_manager: !!p.is_manager };
    return { ...base, phone: p.show_phone ? p.phone : '', email: p.show_email ? p.email : '', office: p.show_office ? p.office : '' };
  }
  const matches = (p, q, phones) => { if (!q) return true; const n = q.toLowerCase(); return p.name.toLowerCase().includes(n) || tenant(p.tenant_id).name.toLowerCase().includes(n) || (phones && (p.phone.includes(q) || p.email.toLowerCase().includes(n))); };

  function sessions({ tenantId, personId, from, to }) {
    const evs = S.events.filter((e) => e.clocked_at >= from && e.clocked_at <= to && (!tenantId || e.tenant_id === tenantId) && (!personId || e.person_id === personId))
      .sort((a, b) => a.person_id - b.person_id || a.clocked_at - b.clocked_at || a.id - b.id);
    const out = []; let open = null, cur = null; const now = Date.now();
    const meta = (e) => ({ person_id: e.person_id, person_name: person(e.person_id).name, tenant_id: e.tenant_id, tenant_name: tenant(e.tenant_id).name });
    const flush = () => { if (open) { out.push({ ...open, clock_out: null, duration_ms: Math.max(0, now - open.clock_in), open: true }); open = null; } };
    for (const e of evs) {
      if (e.person_id !== cur) { flush(); cur = e.person_id; }
      if (e.direction === 'in') { if (open) flush(); open = { ...meta(e), clock_in: e.clocked_at }; }
      else if (open) { out.push({ ...open, clock_out: e.clocked_at, duration_ms: e.clocked_at - open.clock_in, open: false }); open = null; }
    }
    flush();
    return out.sort((a, b) => b.clock_in - a.clock_in);
  }
  const rangeOf = (q) => ({ from: Number(q.get('from')) || 0, to: Number(q.get('to')) || Number.MAX_SAFE_INTEGER, tenantId: Number(q.get('tenant_id')) || null, personId: Number(q.get('person_id')) || null });

  function profile(p) {
    const t = tenant(p.tenant_id);
    return {
      id: p.id, name: p.name, tenant_id: p.tenant_id, tenant_name: t.name, phone: p.phone, email: p.email, title: p.title, bio: p.bio, office: p.office,
      photo_url: p.photo, handle: p.handle, show_phone: !!p.show_phone, show_email: !!p.show_email, show_office: !!p.show_office,
      avatar_mode: p.avatar_mode, is_manager: !!p.is_manager, avatar_url: avatarUrl(p), avatar_kind: avatarKind(p),
      tenant: { id: t.id, name: t.name, logo_url: t.logo, office: t.office, phone: t.phone, email: t.email, website: t.website },
      has_access: !!p.handle, must_change: !!p.must_change, active: p.active, profile_updated_at: null,
    };
  }
  const applyProfile = (p, b, admin) => {
    for (const [k, m] of [['title', 80], ['phone', 40], ['email', 120], ['bio', 600], ['office', 80]]) if (b[k] !== undefined) p[k] = str(b[k], m);
    for (const k of ['show_phone', 'show_email', 'show_office']) if (b[k] !== undefined) p[k] = bool(b[k]);
    if (b.avatar_mode !== undefined && ['photo', 'logo', 'initials'].includes(b.avatar_mode)) p.avatar_mode = b.avatar_mode;
    if (admin && b.is_manager !== undefined) p.is_manager = bool(b.is_manager);
  };
  const applyTenant = (t, b) => {
    for (const [k, m] of [['office', 80], ['phone', 40], ['email', 120], ['website', 200]]) if (b[k] !== undefined) {
      let v = str(b[k], m); if (k === 'website' && v && !/^https?:\/\//i.test(v)) { if (/^[a-z][a-z0-9+.\-]*:(?!\d)/i.test(v)) continue; v = 'https://' + v; }
      t[k] = v;
    }
  };

  // ------------------------------------------------------------------ sessions (who is "signed in" in the demo)
  const adminOn = () => sessionStorage.getItem('demo_admin') === '1';
  const meId = () => Number(sessionStorage.getItem('demo_person')) || 0;
  const needAdmin = () => (adminOn() ? null : ERR(401, 'Login required'));
  const needMe = () => (meId() && person(meId()) ? null : ERR(401, 'Please sign in'));

  const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const notInDemo = (what) => ERR(400, `${what} is switched off in the demo. Download the project to try it on a real server.`);

  // ------------------------------------------------------------------ routes
  const routes = [];
  const R = (method, re, fn) => routes.push([method, re, fn]);

  R('GET', /^\/health$/, () => J({ ok: true, time: Date.now() }));

  R('GET', /^\/directory$/, (m, q) => {
    const st = S.settings, query = (q.get('q') || '').trim(), tid = Number(q.get('tenant_id')) || null;
    const base = { layout: st.kiosk_layout, mode: st.kiosk_mode };
    if (!query && st.kiosk_mode !== 'browse') return J({ ...base, tenants: [] });
    const groups = [];
    for (const t of [...S.tenants].sort((a, b) => a.name.localeCompare(b.name))) {
      if (tid && t.id !== tid) continue;
      const people = S.people.filter((p) => p.active && p.tenant_id === t.id && matches(p, query, false)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => statusRow(p, false));
      if (people.length) groups.push({ id: t.id, name: t.name, office: t.office, phone: t.phone, email: t.email, website: t.website, logo_url: t.logo, people, total: people.length, in_count: people.filter((p) => p.status === 'in').length });
    }
    return J({ ...base, tenants: groups });
  });

  R('POST', /^\/clock$/, (m, q, b) => {
    const p = person(Number(b.person_id)); const dir = String(b.direction || '').toLowerCase();
    if (!['in', 'out'].includes(dir)) return ERR(400, 'direction must be "in" or "out"');
    if (!p || !p.active) return ERR(404, 'person not found or inactive');
    const l = last(p.id); if (l && l.direction === dir) return ERR(409, `Already clocked ${dir.toUpperCase()}`);
    S.events.push({ id: S.seq.event++, person_id: p.id, tenant_id: p.tenant_id, direction: dir, clocked_at: Date.now(), notes: '' }); save();
    return J({ id: S.seq.event - 1, person_id: p.id, direction: dir, clocked_at: Date.now() }, 201);
  });

  // ---- admin auth
  R('POST', /^\/auth\/login$/, (m, q, b) => {
    if (String(b.username || '').toLowerCase() === 'demo' && String(b.password || '') === 'demo') { sessionStorage.setItem('demo_admin', '1'); return J({ username: 'demo' }); }
    return ERR(401, 'Invalid username or password. In the demo use  demo / demo');
  });
  R('POST', /^\/auth\/logout$/, () => { sessionStorage.removeItem('demo_admin'); return J({ ok: true }); });
  R('GET', /^\/auth\/me$/, () => (adminOn() ? J({ username: 'demo' }) : ERR(401, 'Login required')));
  R('POST', /^\/auth\/password$/, () => (needAdmin() || notInDemo('Changing the password')));
  R('GET', /^\/admin\/users$/, () => needAdmin() || J([{ id: 1, username: 'demo', created_at: Date.now() - 6 * DAY, last_login: Date.now() }]));
  R('POST', /^\/admin\/users$/, () => needAdmin() || notInDemo('Adding admins'));
  R('DELETE', /^\/admin\/users\/\d+$/, () => needAdmin() || notInDemo('Removing admins'));

  // ---- admin: settings / overview / status
  R('GET', /^\/admin\/settings$/, () => needAdmin() || J(S.settings));
  R('PUT', /^\/admin\/settings$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad;
    const opts = { kiosk_layout: ['table', 'list', 'cards', 'tiles', 'board'], kiosk_mode: ['search', 'browse'] };
    for (const [k, v] of Object.entries(b)) { if (!opts[k]) return ERR(400, `Unknown setting: ${k}`); if (!opts[k].includes(v)) return ERR(400, `Invalid value for ${k}`); S.settings[k] = v; }
    save(); return J(S.settings);
  });
  R('GET', /^\/admin\/overview$/, (m, q) => {
    const bad = needAdmin(); if (bad) return bad;
    const start = Number(q.get('day_start')) || dayStart();
    const today = sessions({ from: start, to: Number.MAX_SAFE_INTEGER });
    const act = S.people.filter((p) => p.active);
    const rows = [...S.tenants].sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
      const ppl = act.filter((p) => p.tenant_id === t.id);
      const inN = ppl.filter((p) => (last(p.id) || {}).direction === 'in').length;
      return { id: t.id, name: t.name, notes: t.notes, created_at: 0, people: ppl.length, in_count: inN, out_count: ppl.length - inN, today_ms: today.filter((x) => x.tenant_id === t.id).reduce((a, x) => a + x.duration_ms, 0) };
    });
    const recent = [...S.events].sort((a, b) => b.clocked_at - a.clocked_at || b.id - a.id).slice(0, 10).map((e) => ({ ...e, person_name: person(e.person_id).name, tenant_name: tenant(e.tenant_id).name }));
    const inNow = act.filter((p) => (last(p.id) || {}).direction === 'in').length;
    return J({ totals: { tenants: S.tenants.length, people: act.length, in_now: inNow, today_ms: today.reduce((a, x) => a + x.duration_ms, 0) }, tenants: rows, recent });
  });
  R('GET', /^\/status$/, (m, q) => {
    const bad = needAdmin(); if (bad) return bad;
    const tid = Number(q.get('tenant_id')) || null, query = (q.get('search') || '').trim();
    return J(S.people.filter((p) => p.active && (!tid || p.tenant_id === tid) && matches(p, query, true))
      .sort((a, b) => tenant(a.tenant_id).name.localeCompare(tenant(b.tenant_id).name) || a.name.localeCompare(b.name)).map((p) => statusRow(p, true)));
  });
  R('POST', /^\/reset$/, () => {
    const bad = needAdmin(); if (bad) return bad; let n = 0;
    for (const p of S.people) if (p.active && (last(p.id) || {}).direction === 'in') { S.events.push({ id: S.seq.event++, person_id: p.id, tenant_id: p.tenant_id, direction: 'out', clocked_at: Date.now(), notes: 'End-of-day reset' }); n++; }
    save(); return J({ ok: true, clocked_out: n });
  });
  R('POST', /^\/admin\/visibility$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad;
    if (!['show_phone', 'show_email', 'show_office'].includes(b.field)) return ERR(400, 'field must be show_phone, show_email or show_office');
    let n = 0; for (const p of S.people) if (!b.tenant_id || p.tenant_id === Number(b.tenant_id)) { p[b.field] = b.value === true ? 1 : 0; n++; }
    save(); return J({ updated: n });
  });

  // ---- admin: tenants
  const tenantOut = (t) => { const { logo, ...r } = t; return { ...r, created_at: 0, logo_url: logo }; };
  R('GET', /^\/tenants$/, () => needAdmin() || J([...S.tenants].sort((a, b) => a.name.localeCompare(b.name)).map(tenantOut)));
  R('POST', /^\/tenants$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad;
    if (!str(b.name, 100)) return ERR(400, 'name is required');
    const t = { id: Math.max(0, ...S.tenants.map((x) => x.id)) + 1, name: str(b.name, 100), notes: str(b.notes, 500), office: '', phone: '', email: '', website: '', logo: null };
    applyTenant(t, b); S.tenants.push(t); save(); return J({ id: t.id, name: t.name }, 201);
  });
  R('PUT', /^\/tenants\/(\d+)$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad; const t = tenant(Number(m[1])); if (!t) return ERR(404, 'tenant not found');
    if (!str(b.name, 100)) return ERR(400, 'name is required'); t.name = str(b.name, 100); t.notes = str(b.notes, 500); applyTenant(t, b); save(); return J({ ok: true });
  });
  R('DELETE', /^\/tenants\/(\d+)$/, (m) => {
    const bad = needAdmin(); if (bad) return bad; const id = Number(m[1]);
    S.people = S.people.filter((p) => p.tenant_id !== id); S.events = S.events.filter((e) => e.tenant_id !== id); S.tenants = S.tenants.filter((t) => t.id !== id); save(); return J({ ok: true });
  });
  R('PUT', /^\/tenants\/(\d+)\/logo$/, async (m, q, b, init) => { const bad = needAdmin(); if (bad) return bad; const t = tenant(Number(m[1])); t.logo = await readBlob(init.body); save(); return J({ logo_url: t.logo }); });
  R('DELETE', /^\/tenants\/(\d+)\/logo$/, (m) => { const bad = needAdmin(); if (bad) return bad; tenant(Number(m[1])).logo = null; save(); return J({ ok: true }); });

  // ---- admin: people
  R('GET', /^\/people$/, (m, q) => {
    const bad = needAdmin(); if (bad) return bad;
    const tid = Number(q.get('tenant_id')) || null, query = (q.get('search') || '').trim();
    return J(S.people.filter((p) => (!tid || p.tenant_id === tid) && matches(p, query, true))
      .sort((a, b) => tenant(a.tenant_id).name.localeCompare(tenant(b.tenant_id).name) || a.name.localeCompare(b.name))
      .map((p) => ({ id: p.id, name: p.name, phone: p.phone, email: p.email, office: p.office, title: p.title, handle: p.handle, tenant_id: p.tenant_id, active: p.active,
        show_phone: !!p.show_phone, show_email: !!p.show_email, show_office: !!p.show_office, avatar_mode: p.avatar_mode, is_manager: !!p.is_manager,
        has_access: !!p.handle, tenant_name: tenant(p.tenant_id).name, photo_url: p.photo, avatar_url: avatarUrl(p), avatar_kind: avatarKind(p) })));
  });
  R('GET', /^\/people\.csv$/, () => needAdmin() || CSV('people.csv', ['id', 'name', 'tenant', 'title', 'office', 'phone', 'email', 'active', 'show_office', 'show_phone', 'show_email', 'avatar_mode', 'manager', 'bio'],
    S.people.map((p) => [p.id, p.name, tenant(p.tenant_id).name, p.title, p.office, p.phone, p.email, p.active ? 'yes' : 'no', p.show_office ? 'yes' : 'no', p.show_phone ? 'yes' : 'no', p.show_email ? 'yes' : 'no', p.avatar_mode, p.is_manager ? 'yes' : 'no', p.bio])));
  R('POST', /^\/people\/import$/, () => needAdmin() || notInDemo('CSV import'));
  R('GET', /^\/people\/(\d+)$/, (m) => needAdmin() || (person(Number(m[1])) ? J(profile(person(Number(m[1])))) : ERR(404, 'person not found')));
  R('POST', /^\/people$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad;
    if (!str(b.name, 120)) return ERR(400, 'name is required'); if (!tenant(Number(b.tenant_id))) return ERR(400, 'tenant_id does not exist');
    const p = { id: Math.max(0, ...S.people.map((x) => x.id)) + 1, tenant_id: Number(b.tenant_id), name: str(b.name, 120), title: '', office: '', phone: str(b.phone, 40), email: '', bio: '', photo: null, active: 1, show_office: 1, show_phone: 0, show_email: 0, avatar_mode: 'photo', is_manager: 0, handle: null, must_change: 0 };
    S.people.push(p); save(); return J({ id: p.id, name: p.name }, 201);
  });
  R('PUT', /^\/people\/(\d+)$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad; const p = person(Number(m[1])); if (!p) return ERR(404, 'person not found');
    if (!str(b.name, 120)) return ERR(400, 'name is required'); if (!tenant(Number(b.tenant_id))) return ERR(400, 'tenant_id does not exist');
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return ERR(400, 'Enter a valid email address');
    p.name = str(b.name, 120); p.tenant_id = Number(b.tenant_id); p.active = b.active ? 1 : 0; applyProfile(p, b, true); save(); return J({ ok: true });
  });
  R('DELETE', /^\/people\/(\d+)$/, (m) => { const bad = needAdmin(); if (bad) return bad; const id = Number(m[1]); S.people = S.people.filter((p) => p.id !== id); S.events = S.events.filter((e) => e.person_id !== id); save(); return J({ ok: true }); });
  R('PUT', /^\/people\/(\d+)\/photo$/, async (m, q, b, init) => { const bad = needAdmin(); if (bad) return bad; const p = person(Number(m[1])); p.photo = await readBlob(init.body); save(); return J({ photo_url: p.photo }); });
  R('DELETE', /^\/people\/(\d+)\/photo$/, (m) => { const bad = needAdmin(); if (bad) return bad; person(Number(m[1])).photo = null; save(); return J({ ok: true }); });
  R('POST', /^\/people\/(\d+)\/access$/, (m) => {
    const bad = needAdmin(); if (bad) return bad; const p = person(Number(m[1]));
    p.handle = p.handle || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, ''); save();
    return J({ handle: p.handle, temp_password: 'demo' });
  });
  R('DELETE', /^\/people\/(\d+)\/access$/, (m) => { const bad = needAdmin(); if (bad) return bad; person(Number(m[1])).handle = null; save(); return J({ ok: true }); });

  // ---- admin: time log
  const evRows = (q) => {
    const f = rangeOf(q), dir = q.get('direction');
    return S.events.filter((e) => e.clocked_at >= f.from && e.clocked_at <= f.to && (!f.tenantId || e.tenant_id === f.tenantId) && (!f.personId || e.person_id === f.personId) && (!dir || e.direction === dir))
      .sort((a, b) => b.clocked_at - a.clocked_at || b.id - a.id).map((e) => ({ ...e, person_name: person(e.person_id).name, tenant_name: tenant(e.tenant_id).name }));
  };
  R('GET', /^\/events$/, (m, q) => {
    const bad = needAdmin(); if (bad) return bad; const all = evRows(q); const limit = Math.min(Number(q.get('limit')) || 200, 1000), off = Number(q.get('offset')) || 0;
    return J(q.get('paged') === '1' ? { total: all.length, rows: all.slice(off, off + limit) } : all.slice(off, off + limit));
  });
  R('GET', /^\/events\.csv$/, (m, q) => needAdmin() || CSV('clock-events.csv', ['Time', 'Person', 'Tenant', 'Direction', 'Notes'], evRows(q).map((e) => [new Date(e.clocked_at).toISOString(), e.person_name, e.tenant_name, e.direction.toUpperCase(), e.notes])));
  R('GET', /^\/sessions$/, (m, q) => { const bad = needAdmin(); if (bad) return bad; const s = sessions(rangeOf(q)); return J({ sessions: s, total_ms: s.reduce((a, x) => a + x.duration_ms, 0) }); });
  R('GET', /^\/sessions\.csv$/, (m, q) => needAdmin() || CSV('time-sessions.csv', ['Person', 'Tenant', 'Clock in', 'Clock out', 'Minutes', 'Still in'],
    sessions(rangeOf(q)).map((x) => [x.person_name, x.tenant_name, new Date(x.clock_in).toISOString(), x.clock_out ? new Date(x.clock_out).toISOString() : '', Math.round(x.duration_ms / 60000), x.open ? 'yes' : 'no'])));
  R('POST', /^\/events$/, (m, q, b) => {
    const bad = needAdmin(); if (bad) return bad; const p = person(Number(b.person_id)); if (!p) return ERR(404, 'person not found');
    if (!['in', 'out'].includes(b.direction)) return ERR(400, 'direction must be "in" or "out"');
    S.events.push({ id: S.seq.event++, person_id: p.id, tenant_id: p.tenant_id, direction: b.direction, clocked_at: Number(b.clocked_at), notes: str(b.notes, 200) || 'Manual entry (admin)' }); save(); return J({ id: S.seq.event - 1 }, 201);
  });
  R('DELETE', /^\/events\/(\d+)$/, (m) => { const bad = needAdmin(); if (bad) return bad; S.events = S.events.filter((e) => e.id !== Number(m[1])); save(); return J({ ok: true }); });

  // ---- a person's own page (/me)
  R('POST', /^\/me\/login$/, (m, q, b) => {
    const p = S.people.find((x) => x.handle && x.handle === String(b.handle || '').trim().toLowerCase());
    if (!p || String(b.password || '') !== 'demo') return ERR(401, 'Invalid sign-in or password. In the demo use  maria.delgado / demo');
    sessionStorage.setItem('demo_person', String(p.id)); return J(profile(p));
  });
  R('POST', /^\/me\/logout$/, () => { sessionStorage.removeItem('demo_person'); return J({ ok: true }); });
  R('GET', /^\/me$/, () => needMe() || J(profile(person(meId()))));
  R('PUT', /^\/me$/, (m, q, b) => {
    const bad = needMe(); if (bad) return bad; const p = person(meId());
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return ERR(400, 'Enter a valid email address');
    applyProfile(p, b, false); save(); return J(profile(p));
  });
  R('PUT', /^\/me\/photo$/, async (m, q, b, init) => { const bad = needMe(); if (bad) return bad; const p = person(meId()); p.photo = await readBlob(init.body); save(); return J({ photo_url: p.photo }); });
  R('DELETE', /^\/me\/photo$/, () => { const bad = needMe(); if (bad) return bad; person(meId()).photo = null; save(); return J({ ok: true }); });
  R('POST', /^\/me\/password$/, () => needMe() || J({ ok: true }));
  R('GET', /^\/me\/shifts$/, () => { const bad = needMe(); if (bad) return bad; return J(sessions({ personId: meId(), from: Date.now() - 30 * DAY, to: Number.MAX_SAFE_INTEGER }).slice(0, 30).map(({ clock_in, clock_out, duration_ms, open }) => ({ clock_in, clock_out, duration_ms, open }))); });
  R('PUT', /^\/me\/tenant$/, (m, q, b) => {
    const bad = needMe(); if (bad) return bad; const p = person(meId());
    if (!p.is_manager) return ERR(403, 'Only a tenant manager can change the company profile');
    applyTenant(tenant(p.tenant_id), b); save(); return J(profile(p));
  });
  R('PUT', /^\/me\/tenant\/logo$/, async (m, q, b, init) => { const bad = needMe(); if (bad) return bad; const p = person(meId()); if (!p.is_manager) return ERR(403, 'Only a tenant manager can change the company profile'); tenant(p.tenant_id).logo = await readBlob(init.body); save(); return J({ logo_url: tenant(p.tenant_id).logo }); });
  R('DELETE', /^\/me\/tenant\/logo$/, () => { const bad = needMe(); if (bad) return bad; const p = person(meId()); if (!p.is_manager) return ERR(403, 'Only a tenant manager can change the company profile'); tenant(p.tenant_id).logo = null; save(); return J({ ok: true }); });

  // ------------------------------------------------------------------ intercept fetch
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url, location.href);
    const at = u.pathname.indexOf('/api/');
    if (at < 0) return realFetch(input, init);
    const api = u.pathname.slice(at + 4);
    const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    let body = {};
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = {}; } }
    for (const [mth, re, fn] of routes) {
      if (mth !== method) continue;
      const m = re.exec(api);
      if (m) { await new Promise((r) => setTimeout(r, 40)); return fn(m, u.searchParams, body, init); }
    }
    return ERR(404, 'Not found');
  };

  // ------------------------------------------------------------------ demo banner
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '.demo-banner{background:#0b3d91;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:.55rem 1rem;display:flex;gap:.5rem 1rem;flex-wrap:wrap;align-items:center;justify-content:center;text-align:center}'
      + '.demo-banner a,.demo-banner button{color:#fff;background:transparent;border:1px solid rgba(255,255,255,.7);border-radius:.4rem;padding:.2rem .65rem;font:inherit;cursor:pointer;text-decoration:none}'
      + '.demo-banner a:hover,.demo-banner button:hover{background:rgba(255,255,255,.18)}.demo-banner code{background:rgba(255,255,255,.18);padding:.05rem .35rem;border-radius:.3rem}';
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'demo-banner'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Demo notice');
    bar.innerHTML = '<span>Live demo: made-up data that stays in your browser.</span>'
      + '<span>Admin sign-in: <code>demo</code> / <code>demo</code> &middot; Person page: <code>maria.delgado</code> / <code>demo</code></span>'
      + '<a href="../">About</a><button type="button" id="demoReset">Reset demo</button>';
    const skip = document.querySelector('.skip');          // keep the skip link as the very first focusable item
    if (skip) skip.after(bar); else document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('demoReset').addEventListener('click', () => {
      try { localStorage.removeItem(KEY); sessionStorage.clear(); } catch { /* ignore */ }
      location.reload();
    });
  });
})();
