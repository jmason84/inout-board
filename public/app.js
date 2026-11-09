'use strict';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let adminToken = localStorage.getItem('inout_admin_token') || '';
let lastEventId = null; // for the "Undo" toast

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin && adminToken) headers['x-admin-token'] = adminToken;
  return fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
}

let toastTimer;
function toast(msg, { isError = false, undo = false } = {}) {
  const el = $('#toast');
  $('#toastMsg').textContent = msg;
  $('#toastUndo').hidden = !undo;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 6000 : 2600);
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtClock(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// "1h 24m" style duration, live-friendly
function fmtElapsed(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const first = (parts[0] || '?')[0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function badge(status) {
  const label = status === 'in' ? 'IN' : status === 'out' ? 'OUT' : '—';
  return `<span class="badge ${status}">${label}</span>`;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${tab.dataset.view}`).classList.add('active');
    if (tab.dataset.view === 'status') loadStatus();
    if (tab.dataset.view === 'admin') loadAdmin();
    if (tab.dataset.view === 'clock') loadClock();
  });
});

// ---------------------------------------------------------------------------
// Header clock + elapsed ticker
// ---------------------------------------------------------------------------

function tickClock() {
  $('#headerClock').textContent = new Date().toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
  // Live-update every visible "elapsed since" value.
  $$('[data-elapsed]').forEach((el) => {
    el.textContent = fmtElapsed(Number(el.dataset.at));
  });
}
setInterval(tickClock, 1000);
tickClock();

// ---------------------------------------------------------------------------
// Live updates (SSE with polling fallback)
// ---------------------------------------------------------------------------

let liveSource = null;
function initLive() {
  try {
    if (!('EventSource' in window)) throw new Error('no SSE');
    liveSource = new EventSource('/api/stream');
    liveSource.addEventListener('clock', () => { loadClock(); loadStatus(); });
    liveSource.addEventListener('change', () => { loadClock(); loadStatus(); loadAdmin(); });
    liveSource.onerror = () => { /* fall back to polling below */ };
  } catch {
    liveSource = null;
  }
  if (!liveSource || liveSource.readyState === 2) {
    // Polling fallback (also covers broken proxies).
    setInterval(() => {
      if (!$('#view-clock').classList.contains('active') &&
          !$('#view-status').classList.contains('active')) return;
      loadClock(); loadStatus();
    }, 15000);
  }
}

// ---------------------------------------------------------------------------
// CLOCK VIEW
// ---------------------------------------------------------------------------

async function loadClock() {
  const search = $('#clockSearch').value.trim();
  const res = await api(`/api/status?search=${encodeURIComponent(search)}`);
  const people = await res.json();
  const wrap = $('#clockResults');
  if (!people.length) {
    wrap.innerHTML = '<p class="hint">No people found.</p>';
    return;
  }
  wrap.innerHTML = people.map((p) => {
    const isIn = p.status === 'in';
    const nextDir = isIn ? 'out' : 'in';
    const btnLabel = isIn ? 'Clock OUT' : 'Clock IN';
    const btnClass = isIn ? 'toggle-out' : 'toggle-in';
    return `
      <div class="person-card" data-person="${p.id}">
        <div class="avatar ${p.status}">${initials(p.name)}</div>
        <div class="person-info">
          <div class="person-name">${escapeHtml(p.name)}</div>
          <div class="person-meta">
            ${escapeHtml(p.tenant_name)}${p.phone ? ' · ' + escapeHtml(p.phone) : ''}
          </div>
        </div>
        ${badge(p.status)}
        <span class="elapsed ${p.status}" data-elapsed data-at="${p.clocked_at || ''}">
          ${p.clocked_at ? fmtElapsed(p.clocked_at) : ''}
        </span>
        <input type="text" class="note-input" placeholder="Note (optional)" maxlength="80" />
        <button class="btn ${btnClass}" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-dir="${nextDir}">${btnLabel}</button>
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('button[data-dir]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.person-card');
      const note = card.querySelector('.note-input').value.trim();
      btn.disabled = true;
      const res = await api('/api/clock', {
        method: 'POST',
        body: JSON.stringify({ person_id: Number(btn.dataset.id), direction: btn.dataset.dir, notes: note }),
      });
      btn.disabled = false;
      if (res.ok) {
        const d = await res.json();
        lastEventId = d.id;
        const dirLabel = btn.dataset.dir.toUpperCase();
        toast(`${btn.dataset.name} clocked ${dirLabel}`, { undo: true });
        if (card) card.querySelector('.note-input').value = '';
        loadClock();
      } else {
        const err = await res.json();
        toast(err.error || 'Clock failed', { isError: true });
      }
    });
  });
}

let clockDebounce;
$('#clockSearch').addEventListener('input', () => {
  clearTimeout(clockDebounce);
  clockDebounce = setTimeout(loadClock, 150);
});

// Undo the last clock event
$('#toastUndo').addEventListener('click', async () => {
  if (!lastEventId) return;
  const res = await api(`/api/events/${lastEventId}`, { method: 'DELETE' });
  lastEventId = null;
  if (res.ok) {
    toast('Undone');
    loadClock(); loadStatus();
  } else {
    const err = await res.json();
    toast(err.error || 'Could not undo', { isError: true });
  }
});

// ---------------------------------------------------------------------------
// STATUS VIEW
// ---------------------------------------------------------------------------

async function loadStatus() {
  if (!$('#statusTenant').dataset.loaded) {
    const tenants = await (await api('/api/tenants')).json();
    $('#statusTenant').innerHTML = '<option value="">All tenants</option>' +
      tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    $('#statusTenant').dataset.loaded = '1';
  }

  const search = $('#statusSearch').value.trim();
  const tenant = $('#statusTenant').value;
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (tenant) qs.set('tenant_id', tenant);
  const res = await api(`/api/status?${qs.toString()}`);
  const people = await res.json();

  let inCount = 0, outCount = 0;
  const byTenant = new Map();
  for (const p of people) {
    if (p.status === 'in') inCount++;
    else if (p.status === 'out') outCount++;
    if (!byTenant.has(p.tenant_name)) byTenant.set(p.tenant_name, []);
    byTenant.get(p.tenant_name).push(p);
  }

  $('#statusSummary').innerHTML = `
    <div class="sum-stat in"><b>${inCount}</b><span class="lbl">IN</span></div>
    <div class="sum-stat out"><b>${outCount}</b><span class="lbl">OUT</span></div>
    <div class="sum-stat"><b>${people.length}</b><span class="lbl">Total</span></div>
  `;

  const board = $('#statusBoard');
  if (!people.length) {
    board.innerHTML = '<p class="hint">No people found.</p>';
    return;
  }
  board.innerHTML = [...byTenant.entries()].map(([tenant, rows]) => `
    <div class="tenant-group">
      <h3>${escapeHtml(tenant)} <span class="count">${rows.length}</span></h3>
      <div class="status-grid">
        ${rows.map((p) => `
          <div class="status-card ${p.status}">
            <div class="top">
              <div class="avatar ${p.status}">${initials(p.name)}</div>
              <div class="name">${escapeHtml(p.name)}</div>
              ${badge(p.status)}
            </div>
            <div class="meta">${escapeHtml(p.phone || '')}</div>
            <div class="last" data-elapsed data-at="${p.clocked_at || ''}">
              ${p.clocked_at ? 'Since ' + fmtClock(p.clocked_at) + ' · ' + fmtElapsed(p.clocked_at) : 'No activity'}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

$('#statusSearch').addEventListener('input', debounce(loadStatus, 200));
$('#statusTenant').addEventListener('change', loadStatus);

// ---------------------------------------------------------------------------
// ADMIN VIEW
// ---------------------------------------------------------------------------

async function loadAdmin() {
  if (!adminToken) {
    $('#adminGate').hidden = false;
    $('#adminPanel').hidden = true;
    return;
  }
  const check = await api('/api/tenants', { admin: true });
  if (check.status === 401) {
    adminToken = '';
    localStorage.removeItem('inout_admin_token');
    $('#adminGate').hidden = false;
    $('#adminPanel').hidden = true;
    return;
  }
  $('#adminGate').hidden = true;
  $('#adminPanel').hidden = false;
  await Promise.all([loadTenants(), loadPeople(), loadEvents()]);
}

$('#adminUnlock').addEventListener('click', () => {
  adminToken = $('#adminToken').value.trim();
  if (!adminToken) return toast('Enter a token', { isError: true });
  localStorage.setItem('inout_admin_token', adminToken);
  loadAdmin();
});

async function loadTenants() {
  const tenants = await (await api('/api/tenants', { admin: true })).json();
  $('#tenantList').innerHTML = tenants.map((t) => `
    <div class="item-row ${t.active ? '' : 'inactive'}">
      <span class="grow">${escapeHtml(t.name)}</span>
      <span class="mini">${escapeHtml(t.notes || '')}</span>
      ${t.active
        ? `<button class="icon-btn del" data-del-tenant="${t.id}" title="Deactivate">✕</button>`
        : `<button class="icon-btn restore" data-restore-tenant="${t.id}">Restore</button>`}
    </div>
  `).join('') || '<p class="hint">No tenants yet.</p>';

  const activeTenants = tenants.filter((t) => t.active);
  $('#personTenant').innerHTML = activeTenants.map((t) =>
    `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');

  $$('#tenantList [data-del-tenant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/tenants/${btn.dataset.delTenant}`, { method: 'DELETE', admin: true });
      if (res.ok) { toast('Tenant deactivated'); loadTenants(); loadPeople(); }
      else toast('Delete failed', { isError: true });
    });
  });
  $$('#tenantList [data-restore-tenant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/tenants/${btn.dataset.restoreTenant}`, {
        method: 'PUT', admin: true, body: JSON.stringify({ active: true }),
      });
      if (res.ok) { toast('Tenant restored'); loadTenants(); loadPeople(); }
      else toast('Restore failed', { isError: true });
    });
  });
}

async function loadPeople() {
  const people = await (await api('/api/people', { admin: true })).json();
  $('#personList').innerHTML = people.map((p) => `
    <div class="item-row ${p.active ? '' : 'inactive'}">
      <span class="grow">${escapeHtml(p.name)}</span>
      <span class="mini">${escapeHtml(p.tenant_name)}${p.phone ? ' · ' + escapeHtml(p.phone) : ''}</span>
      ${p.active
        ? `<button class="icon-btn del" data-del-person="${p.id}" title="Deactivate">✕</button>`
        : `<button class="icon-btn restore" data-restore-person="${p.id}">Restore</button>`}
    </div>
  `).join('') || '<p class="hint">No people yet.</p>';

  $$('#personList [data-del-person]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/people/${btn.dataset.delPerson}`, { method: 'DELETE', admin: true });
      if (res.ok) { toast('Person deactivated'); loadPeople(); }
      else toast('Delete failed', { isError: true });
    });
  });
  $$('#personList [data-restore-person]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/people/${btn.dataset.restorePerson}`, {
        method: 'PUT', admin: true, body: JSON.stringify({ active: true }),
      });
      if (res.ok) { toast('Person restored'); loadPeople(); }
      else toast('Restore failed', { isError: true });
    });
  });
}

async function loadEvents() {
  const events = await (await api('/api/events?limit=100', { admin: true })).json();
  $('#eventsBody').innerHTML = events.map((e) => `
    <tr>
      <td>${fmtTime(e.clocked_at)}</td>
      <td>${escapeHtml(e.person_name)}</td>
      <td>${escapeHtml(e.tenant_name)}</td>
      <td class="${e.direction}">${e.direction.toUpperCase()}</td>
      <td>${escapeHtml(e.notes || '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="5">No events yet.</td></tr>';
}

$('#exportCsv').addEventListener('click', async () => {
  const res = await api('/api/events/export', { admin: true });
  if (!res.ok) return toast('Export failed', { isError: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'clock-events.csv';
  a.click();
  URL.revokeObjectURL(url);
});

$('#tenantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#tenantName').value.trim();
  const notes = $('#tenantNotes').value.trim();
  if (!name) return toast('Tenant name required', { isError: true });
  const res = await api('/api/tenants', {
    method: 'POST', admin: true,
    body: JSON.stringify({ name, notes }),
  });
  if (res.ok) {
    $('#tenantName').value = ''; $('#tenantNotes').value = '';
    toast('Tenant added');
    loadTenants();
  } else {
    const err = await res.json();
    toast(err.error || 'Failed', { isError: true });
  }
});

$('#personForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#personName').value.trim();
  const phone = $('#personPhone').value.trim();
  const tenant_id = Number($('#personTenant').value);
  if (!name) return toast('Name required', { isError: true });
  if (!tenant_id) return toast('Add a tenant first', { isError: true });
  const res = await api('/api/people', {
    method: 'POST', admin: true,
    body: JSON.stringify({ name, phone, tenant_id }),
  });
  if (res.ok) {
    $('#personName').value = ''; $('#personPhone').value = '';
    toast('Person added');
    loadPeople();
  } else {
    const err = await res.json();
    toast(err.error || 'Failed', { isError: true });
  }
});

$('#resetAll').addEventListener('click', async () => {
  if (!confirm('Clock everyone currently IN to OUT (end of day)?')) return;
  const res = await api('/api/reset', { method: 'POST', admin: true });
  if (res.ok) { const d = await res.json(); toast(`Reset: ${d.clocked_out} clocked out`); loadEvents(); }
  else toast('Reset failed', { isError: true });
});

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadClock();
initLive();
