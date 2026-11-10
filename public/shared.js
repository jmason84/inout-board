'use strict';
// Helpers shared by the kiosk, the admin console and the /me profile page.
window.IO = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COLOR_CLASSES = 8; // .avatar.initials.c0 … c7 in style.css (no inline styles: the CSP forbids them)

  // Photo if there is one, otherwise a coloured circle with initials. size: 'sm' | 'md' | 'lg' | 'xl'
  function avatar(name, url, size = 'md') {
    if (url) return `<img class="avatar ${size}" src="${esc(url)}" alt="" loading="lazy" />`;
    const words = String(name || '?').trim().split(/\s+/);
    const initials = ((words[0] || '')[0] || '?') + (words.length > 1 ? (words[words.length - 1][0] || '') : '');
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar ${size} initials c${h % COLOR_CLASSES}" aria-hidden="true">${esc(initials.toUpperCase())}</span>`;
  }

  // Centre-crop to a square, shrink to 512px and re-encode as JPEG. Also strips EXIF/location data.
  function resizeImage(file, size = 512) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.type) && !file.type.startsWith('image/')) return reject(new Error('Please choose an image file'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = Math.min(size, side);
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be read. Try a JPEG or PNG.")); };
      img.src = url;
    });
  }

  async function uploadPhoto(endpoint, file) {
    const blob = await resizeImage(file);
    const res = await fetch(endpoint, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }

  // ---------------------------------------------------------------------
  // People layouts: list | cards | tiles | board   (used by kiosk + admin)
  // ---------------------------------------------------------------------
  const LAYOUTS = [
    { id: 'list',  label: 'List',  desc: 'One person per row. Simple and compact.' },
    { id: 'cards', label: 'Cards', desc: 'Photo-forward cards in a grid. Easy to recognise faces.' },
    { id: 'tiles', label: 'Tiles', desc: 'Big colour-coded tiles; tap the whole tile to clock IN or OUT. Great for tablets.' },
    { id: 'board', label: 'Board', desc: 'Classic in/out board grouped by tenant, with IN and OUT columns like a paper board.' },
  ];

  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const statusLabel = (s) => (s === 'in' ? 'IN' : s === 'out' ? 'OUT' : 'NOT IN');
  const nextDir = (p) => (p.status === 'in' ? 'out' : 'in');

  function actionBtn(p, o, extra = '') {
    if (!o.action) return '';
    const d = nextDir(p);
    return `<button class="btn big ${d} ${extra}" data-id="${p.id}" data-name="${esc(p.name)}" data-dir="${d}">${d.toUpperCase()}</button>`;
  }

  function metaLine(p, o) {
    const bits = [];
    if (p.title) bits.push(esc(p.title));
    if (!o.hideTenant) bits.push(esc(p.tenant_name));
    if (o.detail && p.phone) bits.push(esc(p.phone));
    if (p.clocked_at) bits.push(`${statusLabel(p.status)} since ${fmtTime(p.clocked_at)}`);
    if (o.detail && p.notes) bits.push(`“${esc(p.notes)}”`);
    return bits.join(' · ');
  }

  function groupByTenant(people) {
    const m = new Map();
    for (const p of people) { if (!m.has(p.tenant_name)) m.set(p.tenant_name, []); m.get(p.tenant_name).push(p); }
    return m;
  }

  function renderBoard(people, o) {
    const groups = groupByTenant(people);
    return [...groups.entries()].map(([tenant, rows]) => `
      <section class="pboard">
        <h3>${esc(tenant)} <span class="mini">${rows.filter((p) => p.status === 'in').length} in · ${rows.length} total</span></h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th>${o.detail ? '<th>Phone</th>' : ''}<th class="io-col">IN</th><th class="io-col">OUT</th><th>Since</th>${o.detail ? '<th>Notes</th>' : ''}</tr></thead>
          <tbody>${rows.map((p) => {
            const cell = (dir) => {
              const on = p.status === dir;
              return o.action
                ? `<button class="io ${dir} ${on ? 'on' : ''}" data-id="${p.id}" data-name="${esc(p.name)}" data-dir="${dir}" ${on ? 'disabled' : ''}>${dir.toUpperCase()}</button>`
                : `<span class="dot ${dir} ${on ? 'on' : ''}" title="${dir.toUpperCase()}"></span>`;
            };
            return `<tr class="row-${p.status}">
              <td><div class="name-cell">${avatar(p.name, p.photo_url, 'sm')}<div><b>${esc(p.name)}</b>${p.title ? `<div class="mini">${esc(p.title)}</div>` : ''}</div></div></td>
              ${o.detail ? `<td>${esc(p.phone || '—')}</td>` : ''}
              <td class="io-col">${cell('in')}</td><td class="io-col">${cell('out')}</td>
              <td>${p.clocked_at ? fmtTime(p.clocked_at) : '—'}</td>
              ${o.detail ? `<td>${esc(p.notes || '')}</td>` : ''}
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>`).join('');
  }

  function renderItems(people, layout, o) {
    const avSize = layout === 'cards' ? 'xl' : layout === 'tiles' ? 'lg' : (o.action ? 'lg' : 'md');
    if (layout === 'cards') {
      return people.map((p) => `
        <div class="pcard ${p.status}">
          ${avatar(p.name, p.photo_url, 'xl')}
          <div class="pname">${esc(p.name)}</div>
          <div class="pmeta">${metaLine(p, { ...o, detail: o.detail })}</div>
          <span class="badge ${p.status}">${statusLabel(p.status)}</span>
          ${actionBtn(p, o, 'block')}
        </div>`).join('');
    }
    if (layout === 'tiles') {
      return people.map((p) => {
        const inner = `${avatar(p.name, p.photo_url, avSize)}<span class="tname">${esc(p.name)}</span>
          <span class="tstat">${statusLabel(p.status)}${o.action ? ` · tap to clock ${nextDir(p).toUpperCase()}` : ''}</span>`;
        return o.action
          ? `<button class="tile ${p.status}" data-id="${p.id}" data-name="${esc(p.name)}" data-dir="${nextDir(p)}">${inner}</button>`
          : `<div class="tile ${p.status}">${inner}</div>`;
      }).join('');
    }
    // list
    return people.map((p) => `
      <div class="person-card ${p.status}">
        ${avatar(p.name, p.photo_url, avSize)}
        <div class="person-info"><div class="person-name">${esc(p.name)}</div><div class="person-meta">${metaLine(p, o)}</div></div>
        <span class="badge ${p.status}">${statusLabel(p.status)}</span>
        ${actionBtn(p, o)}
      </div>`).join('');
  }

  // o: { action: bool (show IN/OUT buttons), detail: bool (phone/notes), group: bool (tenant headings) }
  function renderPeople(people, layout, o = {}) {
    if (!people.length) return '';
    if (layout === 'board') return renderBoard(people, o);
    const cls = `pl ${layout}`;
    const groups = groupByTenant(people);
    if (o.group && groups.size > 1) {
      return [...groups.entries()].map(([tenant, rows]) =>
        `<h3 class="pgroup">${esc(tenant)}</h3><div class="${cls}">${renderItems(rows, layout, { ...o, hideTenant: true })}</div>`).join('');
    }
    return `<div class="${cls}">${renderItems(people, layout, o)}</div>`;
  }

  return { esc, avatar, resizeImage, uploadPhoto, LAYOUTS, renderPeople, fmtTime };
})();
