'use strict';
// Helpers shared by the home page, the admin console and the /me profile page.
window.IO = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COLOR_CLASSES = 8; // .avatar.initials.c0 .. c7 in style.css (no inline styles: the CSP forbids them)

  // Photo or logo if there is one, otherwise a coloured circle with initials.
  // size: sm | md | lg | xl      kind: 'photo' | 'logo' | null
  function avatar(name, url, size = 'md', kind = null) {
    if (url) return `<img class="avatar ${size}${kind === 'logo' ? ' logo' : ''}" src="${esc(url)}" alt="" loading="lazy" />`;
    const words = String(name || '?').trim().split(/\s+/);
    const initials = ((words[0] || '')[0] || '?') + (words.length > 1 ? (words[words.length - 1][0] || '') : '');
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar ${size} initials c${h % COLOR_CLASSES}" aria-hidden="true">${esc(initials.toUpperCase())}</span>`;
  }

  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  // ---------------------------------------------------------------------
  // Images: resize in the browser before upload (also strips EXIF/location)
  // ---------------------------------------------------------------------
  // opts: { square: true, max: 512, type: 'image/jpeg', quality: .85 }
  function resizeImage(file, opts = {}) {
    const { square = true, max = 512, type = 'image/jpeg', quality = 0.85 } = opts;
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (square) { const side = Math.min(img.width, img.height); sx = (img.width - side) / 2; sy = (img.height - side) / 2; sw = sh = side; }
        const scale = Math.min(1, max / Math.max(sw, sh));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
        canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image'))), type, quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be read. Try a JPEG or PNG.")); };
      img.src = url;
    });
  }

  // kind 'photo' = square-cropped JPEG; kind 'logo' = keeps proportions + transparency (PNG)
  async function uploadImage(endpoint, file, kind = 'photo') {
    const blob = await resizeImage(file, kind === 'logo' ? { square: false, max: 480, type: 'image/png' } : {});
    const res = await fetch(endpoint, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }
  const uploadPhoto = (endpoint, file) => uploadImage(endpoint, file, 'photo');

  // ---------------------------------------------------------------------
  // People layouts: table | list | cards | tiles | board
  // ---------------------------------------------------------------------
  const LAYOUTS = [
    { id: 'table', label: 'Table', desc: 'A directory table: name, office, phone, email and status in columns.' },
    { id: 'list',  label: 'List',  desc: 'One person per row. Compact and easy to scan.' },
    { id: 'cards', label: 'Cards', desc: 'Photo-forward cards in a grid. Easy to recognise faces.' },
    { id: 'tiles', label: 'Tiles', desc: 'Big colour-coded tiles; tap the whole tile to clock IN or OUT. Great for tablets.' },
    { id: 'board', label: 'Board', desc: 'Classic in/out board with IN and OUT columns, like a paper board.' },
  ];
  const STATUS = { in: 'IN', out: 'OUT', none: 'NOT IN' };
  const st = (p) => (p.status === 'in' || p.status === 'out' ? p.status : 'none');
  const nextDir = (p) => (p.status === 'in' ? 'out' : 'in');
  const telHref = (v) => 'tel:' + String(v).replace(/[^\d+]/g, '');
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '');
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

  const statusBadge = (p) => `<span class="badge ${st(p)}"><span class="sr-only">Status: </span>${STATUS[st(p)]}</span>`;

  function actionBtn(p, extra = '') {
    const d = nextDir(p);
    return `<button type="button" class="btn big ${d} ${extra}" data-id="${p.id}" data-name="${esc(p.name)}" data-dir="${d}" aria-label="Clock ${d.toUpperCase()}: ${esc(p.name)}">${d.toUpperCase()}</button>`;
  }

  function contactHtml(p) {
    const bits = [];
    if (p.office) bits.push(`<span><span class="sr-only">Office: </span>${esc(p.office)}</span>`);
    if (p.phone) bits.push(`<a href="${esc(telHref(p.phone))}"><span class="sr-only">Phone: </span>${esc(p.phone)}</a>`);
    if (p.email) bits.push(`<a href="mailto:${esc(p.email)}"><span class="sr-only">Email: </span>${esc(p.email)}</a>`);
    return bits.length ? `<div class="contact">${bits.join('')}</div>` : '';
  }

  function sinceText(p) { return p.clocked_at ? `${STATUS[st(p)]} since ${fmtTime(p.clocked_at)}` : ''; }

  // One table, two flavours: directory table (status + one button) or board (IN / OUT columns).
  function renderTable(people, o, board, caption) {
    const has = (k) => people.some((p) => p[k]);
    const cols = [['office', 'Office'], ['phone', 'Phone'], ['email', 'Email']].filter(([k]) => has(k));
    const notes = o.detail && has('notes');
    const head = `<tr><th scope="col">Name</th>${cols.map(([, l]) => `<th scope="col">${l}</th>`).join('')}`
      + (board ? '<th scope="col" class="io-col">IN</th><th scope="col" class="io-col">OUT</th><th scope="col">Since</th>' : '<th scope="col">Status</th>')
      + (notes ? '<th scope="col">Notes</th>' : '') + (o.action && !board ? '<th scope="col"><span class="sr-only">Action</span></th>' : '') + '</tr>';
    const row = (p) => {
      const cell = (dir) => {
        const on = st(p) === dir;
        return o.action
          ? `<button type="button" class="io ${dir} ${on ? 'on' : ''}" data-id="${p.id}" data-name="${esc(p.name)}" data-dir="${dir}" ${on ? 'disabled aria-pressed="true"' : 'aria-pressed="false"'} aria-label="Clock ${dir.toUpperCase()}: ${esc(p.name)}">${dir.toUpperCase()}</button>`
          : `<span class="dot ${dir} ${on ? 'on' : ''}"></span><span class="sr-only">${on ? dir.toUpperCase() : ''}</span>`;
      };
      return `<tr class="row-${st(p)}">
        <td class="cell-person"><div class="name-cell">${avatar(p.name, p.avatar_url, 'sm', p.avatar_kind)}<div><strong>${esc(p.name)}</strong>${p.title ? `<div class="mini">${esc(p.title)}</div>` : ''}</div></div></td>
        ${cols.map(([k, l]) => `<td data-label="${l}">${k === 'phone' && p.phone ? `<a href="${esc(telHref(p.phone))}">${esc(p.phone)}</a>` : k === 'email' && p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : esc(p[k] || '')}</td>`).join('')}
        ${board
          ? `<td class="io-col" data-label="IN">${cell('in')}</td><td class="io-col" data-label="OUT">${cell('out')}</td><td data-label="Since">${p.clocked_at ? esc(fmtTime(p.clocked_at)) : '—'}</td>`
          : `<td data-label="Status">${statusBadge(p)}</td>`}
        ${notes ? `<td data-label="Notes">${esc(p.notes || '')}</td>` : ''}
        ${o.action && !board ? `<td class="cell-act">${actionBtn(p)}</td>` : ''}
      </tr>`;
    };
    return `<div class="table-wrap"><table class="dtable stack"><caption class="sr-only">${esc(caption || 'People')}</caption><thead>${head}</thead><tbody>${people.map(row).join('')}</tbody></table></div>`;
  }

  function renderItems(people, layout, o) {
    if (layout === 'cards') {
      return `<div class="pl cards">${people.map((p) => `
        <div class="pcard ${st(p)}">
          ${avatar(p.name, p.avatar_url, 'xl', p.avatar_kind)}
          <div class="pname">${esc(p.name)}</div>
          ${p.title ? `<div class="ptitle">${esc(p.title)}</div>` : ''}
          ${contactHtml(p)}
          ${o.detail && p.notes ? `<div class="mini">“${esc(p.notes)}”</div>` : ''}
          ${statusBadge(p)}
          ${o.action ? actionBtn(p, 'block') : ''}
        </div>`).join('')}</div>`;
    }
    if (layout === 'tiles') {
      return `<div class="pl tiles">${people.map((p) => {
        const inner = `${avatar(p.name, p.avatar_url, 'lg', p.avatar_kind)}<span class="tname">${esc(p.name)}</span>
          ${p.office ? `<span class="tsub">${esc(p.office)}</span>` : ''}
          <span class="tstat">${STATUS[st(p)]}${o.action ? ` · tap to clock ${nextDir(p).toUpperCase()}` : ''}</span>`;
        return o.action
          ? `<button type="button" class="tile ${st(p)}" data-id="${p.id}" data-name="${esc(p.name)}" data-dir="${nextDir(p)}" aria-label="${esc(p.name)}, currently ${STATUS[st(p)]}. Clock ${nextDir(p).toUpperCase()}">${inner}</button>`
          : `<div class="tile ${st(p)}">${inner}</div>`;
      }).join('')}</div>`;
    }
    // list
    return `<div class="pl list">${people.map((p) => `
      <div class="person-card ${st(p)}">
        ${avatar(p.name, p.avatar_url, 'lg', p.avatar_kind)}
        <div class="person-info">
          <div class="person-name">${esc(p.name)}</div>
          ${p.title ? `<div class="person-meta">${esc(p.title)}</div>` : ''}
          ${contactHtml(p)}
          ${p.clocked_at ? `<div class="person-meta">${esc(sinceText(p))}</div>` : ''}
          ${o.detail && p.notes ? `<div class="person-meta">“${esc(p.notes)}”</div>` : ''}
        </div>
        ${statusBadge(p)}
        ${o.action ? actionBtn(p) : ''}
      </div>`).join('')}</div>`;
  }

  // The people of ONE tenant in the chosen layout.
  // o: { action: show IN/OUT buttons, detail: show notes, caption: table caption }
  function renderPeople(people, layout, o = {}) {
    if (!people.length) return '';
    if (layout === 'table') return renderTable(people, o, false, o.caption);
    if (layout === 'board') return renderTable(people, o, true, o.caption);
    return renderItems(people, layout, o);
  }

  function tenantMeta(t) {
    const bits = [];
    if (t.office) bits.push(`<span><span class="sr-only">Office: </span>${esc(t.office)}</span>`);
    if (t.phone) bits.push(`<a href="${esc(telHref(t.phone))}"><span class="sr-only">Phone: </span>${esc(t.phone)}</a>`);
    if (t.email) bits.push(`<a href="mailto:${esc(t.email)}"><span class="sr-only">Email: </span>${esc(t.email)}</a>`);
    if (safeUrl(t.website)) bits.push(`<a href="${esc(t.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(t.website))}<span class="sr-only"> (opens in a new tab)</span></a>`);
    return bits.length ? `<div class="tenant-meta">${bits.join('')}</div>` : '';
  }

  // groups: [{ tenant: {id,name,logo_url,office,phone,email,website}, people: [...] }]
  function renderGroups(groups, layout, o = {}) {
    const flush = layout === 'table' || layout === 'board';
    return groups.map(({ tenant: t, people }) => {
      const inCount = people.filter((p) => p.status === 'in').length;
      return `<section class="tenant" aria-labelledby="t-${t.id}">
        <div class="tenant-head">
          ${t.logo_url ? `<img class="avatar lg logo" src="${esc(t.logo_url)}" alt="" loading="lazy" />` : avatar(t.name, null, 'lg')}
          <div class="tenant-info"><h2 id="t-${t.id}">${esc(t.name)}</h2>${tenantMeta(t)}</div>
          <div class="tenant-count" aria-label="${inCount} of ${people.length} in">${inCount} in <span class="mini">of ${people.length}</span></div>
        </div>
        <div class="tenant-body${flush ? ' flush' : ''}">${renderPeople(people, layout, { ...o, caption: t.name + ' staff' })}</div>
      </section>`;
    }).join('');
  }

  // Turn a flat list of people (admin /api/status) into groups, using full tenant records when known.
  function groupFlat(people, tenantsById = new Map()) {
    const m = new Map();
    for (const p of people) {
      if (!m.has(p.tenant_id)) m.set(p.tenant_id, { tenant: tenantsById.get(p.tenant_id) || { id: p.tenant_id, name: p.tenant_name }, people: [] });
      m.get(p.tenant_id).people.push(p);
    }
    return [...m.values()];
  }

  return { esc, avatar, fmtTime, resizeImage, uploadImage, uploadPhoto, LAYOUTS, renderPeople, renderGroups, groupFlat, STATUS };
})();
