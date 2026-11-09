'use strict';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let adminToken = localStorage.getItem('inout_admin_token') || '';

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

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
// Header clock
// ---------------------------------------------------------------------------

function tickClock() {
  $('#headerClock').textContent = new Date().toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}
setInterval(tickClock, 1000);
tickClock();

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
  wrap.innerHTML = people.map((p) => `
    <div class="person-card">
      <div class="person-info">
        <div class="person-name">${escapeHtml(p.name)}</div>
        <div class="person-meta">
          ${escapeHtml(p.tenant_name)}${p.phone ? ' · ' + escapeHtml(p.phone) : ''}
          ${p.clocked_at ? ' · last: ' + fmtTime(p.clocked_at) : ''}
        </div>
      </div>
      ${badge(p.status)}
      <span class="badge tenant">${escapeHtml(p.tenant_name)}</span>
      <button class="btn in" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-dir="in">Clock IN</button>
      <button class="btn out" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-dir="out">Clock OUT</button>
    </div>
  `).join('');

  wrap.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const dir = btn.dataset.dir;
      const res = await api('/api/clock', {
        method: 'POST',
        body: JSON.stringify({ person_id: Number(id), direction: dir }),
      });
      if (res.ok) {
        toast(`${btn.dataset.name} clocked ${dir.toUpperCase()}`);
        loadClock();
      } else {
        const err = await res.json();
        toast(err.error || 'Clock failed', true);
      }
    });
  });
}

let clockDebounce;
$('#clockSearch').addEventListener('input', () => {
  clearTimeout(clockDebounce);
  clockDebounce = setTimeout(loadClock, 200);
});

// ---------------------------------------------------------------------------
// STATUS VIEW
// ---------------------------------------------------------------------------

async function loadStatus() {
  // Populate tenant filter once
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
    <div class="sum-stat">IN <b>${inCount}</b></div>
    <div class="sum-stat">OUT <b>${outCount}</b></div>
    <div class="sum-stat">Total <b>${people.length}</b></div>
  `;

  const board = $('#statusBoard');
  if (!people.length) {
    board.innerHTML = '<p class="hint">No people found.</p>';
    return;
  }
  board.innerHTML = [...byTenant.entries()].map(([tenant, rows]) => `
    <div class="tenant-group">
      <h3>${escapeHtml(tenant)}</h3>
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Last clock</th><th>Notes</th></tr></thead>
        <tbody>
          ${rows.map((p) => `
            <tr>
              <td>${escapeHtml(p.name)}</td>
              <td>${escapeHtml(p.phone || '—')}</td>
              <td>${badge(p.status)}</td>
              <td>${fmtTime(p.clocked_at)}</td>
              <td>${escapeHtml(p.notes || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `).join('');
}

$('#statusSearch').addEventListener('input', debounce(loadStatus, 200));
$('#statusTenant').addEventListener('change', loadStatus);
$('#refreshStatus').addEventListener('click', loadStatus);

// ---------------------------------------------------------------------------
// ADMIN VIEW
// ---------------------------------------------------------------------------

async function loadAdmin() {
  if (!adminToken) {
    $('#adminGate').hidden = false;
    $('#adminPanel').hidden = true;
    return;
  }
  // Verify token
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
  if (!adminToken) return toast('Enter a token', true);
  localStorage.setItem('inout_admin_token', adminToken);
  loadAdmin();
});

async function loadTenants() {
  const tenants = await (await api('/api/tenants', { admin: true })).json();
  $('#tenantList').innerHTML = tenants.map((t) => `
    <div class="item-row">
      <span class="grow">${escapeHtml(t.name)}</span>
      <span class="mini">${escapeHtml(t.notes || '')}</span>
      <button class="icon-btn" data-del-tenant="${t.id}" title="Delete">✕</button>
    </div>
  `).join('') || '<p class="hint">No tenants yet.</p>';

  $('#personTenant').innerHTML = tenants.map((t) =>
    `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');

  $$('#tenantList [data-del-tenant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/tenants/${btn.dataset.delTenant}`, { method: 'DELETE', admin: true });
      if (res.ok) { toast('Tenant deleted'); loadTenants(); loadPeople(); }
      else toast('Delete failed', true);
    });
  });
}

async function loadPeople() {
  const people = await (await api('/api/people', { admin: true })).json();
  $('#personList').innerHTML = people.map((p) => `
    <div class="item-row">
      <span class="grow">${escapeHtml(p.name)}</span>
      <span class="mini">${escapeHtml(p.tenant_name)}${p.phone ? ' · ' + escapeHtml(p.phone) : ''}</span>
      <button class="icon-btn" data-del-person="${p.id}" title="Delete">✕</button>
    </div>
  `).join('') || '<p class="hint">No people yet.</p>';

  $$('#personList [data-del-person]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/people/${btn.dataset.delPerson}`, { method: 'DELETE', admin: true });
      if (res.ok) { toast('Person deleted'); loadPeople(); }
      else toast('Delete failed', true);
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

$('#tenantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#tenantName').value.trim();
  const notes = $('#tenantNotes').value.trim();
  if (!name) return toast('Tenant name required', true);
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
    toast(err.error || 'Failed', true);
  }
});

$('#personForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#personName').value.trim();
  const phone = $('#personPhone').value.trim();
  const tenant_id = Number($('#personTenant').value);
  if (!name) return toast('Name required', true);
  if (!tenant_id) return toast('Add a tenant first', true);
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
    toast(err.error || 'Failed', true);
  }
});

$('#refreshEvents').addEventListener('click', loadEvents);
$('#resetAll').addEventListener('click', async () => {
  if (!confirm('Clock everyone currently IN to OUT (end of day)?')) return;
  const res = await api('/api/reset', { method: 'POST', admin: true });
  if (res.ok) { const d = await res.json(); toast(`Reset: ${d.clocked_out} clocked out`); loadEvents(); }
  else toast('Reset failed', true);
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
