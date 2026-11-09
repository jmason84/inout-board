'use strict';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let adminToken = '';
try { adminToken = localStorage.getItem('inout_admin_token') || ''; } catch { /* storage blocked */ }

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin && adminToken) headers['x-admin-token'] = adminToken;
  return fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
}

async function json(res) { try { return await res.json(); } catch { return {}; } }

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2800);
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDuration(ms) {
  const mins = Math.round((ms || 0) / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(status) {
  const label = status === 'in' ? 'IN' : status === 'out' ? 'OUT' : '—';
  return `<span class="badge ${status}">${label}</span>`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Modal (promise-based form dialog)
// ---------------------------------------------------------------------------

// fields: [{name,label,type,value,options,required,placeholder}]; resolves to values or null.
function openModal(title, fields, okLabel = 'Save') {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalOk').textContent = okLabel;
    $('#modalFields').innerHTML = fields.map((f) => {
      const id = `mf_${f.name}`;
      let input;
      if (f.type === 'select') {
        input = `<select id="${id}" class="select">${f.options.map((o) =>
          `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'checkbox') {
        input = `<label class="check"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}/> ${escapeHtml(f.checkLabel || '')}</label>`;
      } else if (f.type === 'textarea') {
        input = `<textarea id="${id}" class="search" rows="3" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`;
      } else {
        input = `<input id="${id}" class="search" type="${f.type || 'text'}" value="${escapeHtml(f.value ?? '')}" placeholder="${escapeHtml(f.placeholder || '')}" ${f.required ? 'required' : ''}/>`;
      }
      return `<label class="field"><span>${escapeHtml(f.label)}</span>${input}</label>`;
    }).join('');
    const back = $('#modalBack');
    back.hidden = false;
    const first = $('#modalFields input, #modalFields select, #modalFields textarea');
    if (first) first.focus();

    const form = $('#modalForm');
    const close = (val) => {
      back.hidden = true;
      form.onsubmit = null; $('#modalCancel').onclick = null; back.onclick = null; document.onkeydown = null;
      resolve(val);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const el = $(`#mf_${f.name}`);
        out[f.name] = f.type === 'checkbox' ? el.checked : el.value;
      }
      close(out);
    };
    $('#modalCancel').onclick = () => close(null);
    back.onclick = (e) => { if (e.target === back) close(null); };
    document.onkeydown = (e) => { if (e.key === 'Escape') close(null); };
  });
}

function confirmModal(title, message, okLabel = 'Confirm') {
  return openModal(title, [{ name: '_', label: message, type: 'hidden' }], okLabel).then((v) => !!v);
}

// ---------------------------------------------------------------------------
// Top-level tabs
// ---------------------------------------------------------------------------

let statusTimer = null;

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${tab.dataset.view}`).classList.add('active');
    clearInterval(statusTimer);
    const v = tab.dataset.view;
    if (v === 'status') { loadStatus(); statusTimer = setInterval(loadStatus, 30000); }
    if (v === 'admin') loadAdmin();
    if (v === 'clock') { loadClock(); $('#clockSearch').focus(); }
  });
});

function tickClock() {
  $('#headerClock').textContent = new Date().toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}
setInterval(tickClock, 1000);
tickClock();

// ---------------------------------------------------------------------------
// CLOCK VIEW
// ---------------------------------------------------------------------------

let clockTenant = '';
const clockNotes = new Map(); // person id -> note text (survives re-render)

async function loadClockChips() {
  const tenants = await json(await api('/api/tenants'));
  if (!Array.isArray(tenants)) return;
  const chips = [{ id: '', name: 'All tenants' }, ...tenants];
  $('#clockChips').innerHTML = chips.length > 2
    ? chips.map((t) => `<button class="chip ${String(t.id) === clockTenant ? 'active' : ''}" data-t="${t.id}">${escapeHtml(t.name)}</button>`).join('')
    : '';
  $$('#clockChips .chip').forEach((c) => c.addEventListener('click', () => { clockTenant = c.dataset.t; loadClockChips(); loadClock(); }));
}

async function loadClock() {
  const qs = new URLSearchParams();
  const search = $('#clockSearch').value.trim();
  if (search) qs.set('search', search);
  if (clockTenant) qs.set('tenant_id', clockTenant);
  const people = await json(await api(`/api/status?${qs}`));
  const wrap = $('#clockResults');
  if (!Array.isArray(people) || !people.length) {
    wrap.innerHTML = '<p class="hint center">No people found.</p>';
    return;
  }
  wrap.innerHTML = people.map((p) => {
    const next = p.status === 'in' ? 'out' : 'in';
    return `
    <div class="person-card ${p.status}">
      <div class="person-info">
        <div class="person-name">${escapeHtml(p.name)}</div>
        <div class="person-meta">${escapeHtml(p.tenant_name)}${p.phone ? ' · ' + escapeHtml(p.phone) : ''}${p.clocked_at ? ' · since ' + fmtTime(p.clocked_at) : ''}</div>
      </div>
      <input class="note-input" data-note="${p.id}" placeholder="Return / comments" value="${escapeHtml(clockNotes.get(p.id) || '')}" maxlength="200" />
      ${badge(p.status)}
      <button class="btn big ${next}" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-dir="${next}">Clock ${next.toUpperCase()}</button>
    </div>`;
  }).join('');

  $$('#clockResults [data-note]').forEach((inp) =>
    inp.addEventListener('input', () => clockNotes.set(Number(inp.dataset.note), inp.value)));

  $$('#clockResults button[data-dir]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const id = Number(btn.dataset.id);
      const res = await api('/api/clock', {
        method: 'POST',
        body: JSON.stringify({ person_id: id, direction: btn.dataset.dir, notes: clockNotes.get(id) || '' }),
      });
      if (res.ok) {
        clockNotes.delete(id);
        toast(`${btn.dataset.name} clocked ${btn.dataset.dir.toUpperCase()}`);
        loadClock();
      } else {
        toast((await json(res)).error || 'Clock failed', true);
        btn.disabled = false;
      }
    });
  });
}

$('#clockSearch').addEventListener('input', debounce(loadClock, 200));

// ---------------------------------------------------------------------------
// STATUS VIEW
// ---------------------------------------------------------------------------

async function loadStatus() {
  if (!$('#statusTenant').dataset.loaded) {
    const tenants = await json(await api('/api/tenants'));
    $('#statusTenant').innerHTML = '<option value="">All tenants</option>' +
      tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    $('#statusTenant').dataset.loaded = '1';
  }
  const qs = new URLSearchParams();
  const search = $('#statusSearch').value.trim();
  if (search) qs.set('search', search);
  if ($('#statusTenant').value) qs.set('tenant_id', $('#statusTenant').value);
  const people = await json(await api(`/api/status?${qs}`));

  let inCount = 0, outCount = 0;
  const byTenant = new Map();
  for (const p of people) {
    if (p.status === 'in') inCount++; else outCount++;
    if (!byTenant.has(p.tenant_name)) byTenant.set(p.tenant_name, []);
    byTenant.get(p.tenant_name).push(p);
  }
  $('#statusSummary').innerHTML = `
    <div class="sum-stat in">IN <b>${inCount}</b></div>
    <div class="sum-stat out">OUT <b>${outCount}</b></div>
    <div class="sum-stat">Total <b>${people.length}</b></div>`;
  $('#statusUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const board = $('#statusBoard');
  if (!people.length) { board.innerHTML = '<p class="hint center">No people found.</p>'; return; }
  board.innerHTML = [...byTenant.entries()].map(([tenant, rows]) => `
    <div class="tenant-group">
      <h3>${escapeHtml(tenant)}</h3>
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Last clock</th><th>Return / comments</th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr class="row-${p.status}">
            <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.phone || '—')}</td>
            <td>${badge(p.status)}</td><td>${fmtTime(p.clocked_at)}</td><td>${escapeHtml(p.notes || '')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`).join('');
}
$('#statusSearch').addEventListener('input', debounce(loadStatus, 200));
$('#statusTenant').addEventListener('change', loadStatus);
$('#refreshStatus').addEventListener('click', loadStatus);

// ---------------------------------------------------------------------------
// ADMIN: gate + navigation
// ---------------------------------------------------------------------------

function lockAdmin(msg) {
  adminToken = '';
  try { localStorage.removeItem('inout_admin_token'); } catch { /* ignore */ }
  $('#adminGate').hidden = false;
  $('#adminPanel').hidden = true;
  if (msg) toast(msg, true);
}

async function adminFetch(path, opts = {}) {
  const res = await api(path, { ...opts, admin: true });
  if (res.status === 401) { lockAdmin('Admin session expired'); throw new Error('unauthorized'); }
  return res;
}

async function loadAdmin() {
  if (!adminToken) return lockAdmin();
  const check = await api('/api/admin/overview', { admin: true });
  if (check.status === 401) return lockAdmin();
  $('#adminGate').hidden = true;
  $('#adminPanel').hidden = false;
  showAdminPage(currentAdminPage);
}

$('#adminGateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#adminToken').value.trim();
  if (!t) return toast('Enter a token', true);
  adminToken = t;
  const check = await api('/api/admin/overview', { admin: true });
  if (check.status === 401) { adminToken = ''; return toast('Invalid admin token', true); }
  try { localStorage.setItem('inout_admin_token', t); } catch { /* ignore */ }
  $('#adminToken').value = '';
  loadAdmin();
});
$('#adminLock').addEventListener('click', () => lockAdmin());

let currentAdminPage = 'overview';
const adminLoaders = { overview: loadOverview, tenants: loadTenantCards, people: loadPeople, log: loadLog };

function showAdminPage(name) {
  currentAdminPage = name;
  $$('.side-link[data-admin]').forEach((b) => b.classList.toggle('active', b.dataset.admin === name));
  $$('.admin-page').forEach((p) => p.classList.toggle('active', p.id === `admin-${name}`));
  adminLoaders[name]().catch((e) => { if (e.message !== 'unauthorized') toast('Failed to load', true); });
}
$$('.side-link[data-admin]').forEach((b) => b.addEventListener('click', () => showAdminPage(b.dataset.admin)));

let tenantsCache = [];
async function refreshTenantsCache() {
  tenantsCache = await json(await adminFetch('/api/tenants'));
  const opts = (first) => `<option value="">${first}</option>` +
    tenantsCache.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  for (const [sel, first] of [['#peopleTenant', 'All tenants'], ['#logTenant', 'All tenants']]) {
    const cur = $(sel).value;
    $(sel).innerHTML = opts(first);
    $(sel).value = cur;
  }
}

// ---------------------------------------------------------------------------
// ADMIN: overview
// ---------------------------------------------------------------------------

function dayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

async function loadOverview() {
  const d = await json(await adminFetch(`/api/admin/overview?day_start=${dayStart()}`));
  const t = d.totals;
  $('#overviewStats').innerHTML = [
    ['Tenants', t.tenants, ''], ['People', t.people, ''],
    ['In right now', t.in_now, 'in'], ['Out / not in', t.people - t.in_now, 'out'],
    ['Time logged today', fmtDuration(t.today_ms), ''],
  ].map(([l, v, c]) => `<div class="stat ${c}"><div class="stat-val">${v}</div><div class="stat-label">${l}</div></div>`).join('');

  $('#overviewTenants').innerHTML = d.tenants.map((x) => `
    <tr><td><b>${escapeHtml(x.name)}</b></td><td>${x.people}</td>
    <td><span class="badge in">${x.in_count}</span></td><td><span class="badge out">${x.out_count}</span></td>
    <td>${fmtDuration(x.today_ms)}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">No tenants yet.</td></tr>';

  $('#overviewRecent').innerHTML = d.recent.map((e) => `
    <div class="feed-row"><span class="badge ${e.direction}">${e.direction.toUpperCase()}</span>
    <span class="grow"><b>${escapeHtml(e.person_name)}</b> <span class="mini">${escapeHtml(e.tenant_name)}</span></span>
    <span class="mini">${fmtTime(e.clocked_at)}</span></div>`).join('') || '<p class="hint">No activity yet.</p>';
}
$('#refreshOverview').addEventListener('click', loadOverview);

$('#resetAll').addEventListener('click', async () => {
  if (!await confirmModal('End of day', 'Clock out everyone who is currently IN?', 'Clock everyone OUT')) return;
  const res = await adminFetch('/api/reset', { method: 'POST' });
  if (res.ok) { toast(`${(await json(res)).clocked_out} people clocked out`); loadOverview(); }
  else toast('Reset failed', true);
});

// ---------------------------------------------------------------------------
// ADMIN: tenants
// ---------------------------------------------------------------------------

async function loadTenantCards() {
  const d = await json(await adminFetch(`/api/admin/overview?day_start=${dayStart()}`));
  await refreshTenantsCache();
  $('#tenantCards').innerHTML = d.tenants.map((t) => `
    <div class="card tenant-card">
      <div class="tenant-top">
        <h3>${escapeHtml(t.name)}</h3>
        <div class="btn-row">
          <button class="icon-btn" data-edit-tenant="${t.id}" title="Edit">✎</button>
          <button class="icon-btn danger" data-del-tenant="${t.id}" title="Delete">✕</button>
        </div>
      </div>
      <p class="mini">${escapeHtml(t.notes || 'No notes')}</p>
      <div class="tenant-stats">
        <div><b>${t.people}</b><span>people</span></div>
        <div class="in"><b>${t.in_count}</b><span>in</span></div>
        <div class="out"><b>${t.out_count}</b><span>out</span></div>
        <div><b>${fmtDuration(t.today_ms)}</b><span>today</span></div>
      </div>
      <button class="btn block" data-view-log="${t.id}">View time log →</button>
    </div>`).join('') || '<p class="hint">No tenants yet. Add your first one.</p>';

  $$('[data-edit-tenant]').forEach((b) => b.addEventListener('click', () => editTenant(d.tenants.find((t) => t.id === Number(b.dataset.editTenant)))));
  $$('[data-del-tenant]').forEach((b) => b.addEventListener('click', () => deleteTenant(d.tenants.find((t) => t.id === Number(b.dataset.delTenant)))));
  $$('[data-view-log]').forEach((b) => b.addEventListener('click', () => {
    $('#logTenant').value = b.dataset.viewLog; $('#logPerson').value = '';
    showAdminPage('log');
  }));
}

async function editTenant(t) {
  const v = await openModal(t ? 'Edit tenant' : 'Add tenant', [
    { name: 'name', label: 'Tenant name', value: t?.name, required: true },
    { name: 'notes', label: 'Notes', type: 'textarea', value: t?.notes, placeholder: 'Location, contact, anything useful' },
  ], t ? 'Save' : 'Add tenant');
  if (!v) return;
  const res = await adminFetch(t ? `/api/tenants/${t.id}` : '/api/tenants', {
    method: t ? 'PUT' : 'POST', body: JSON.stringify(v),
  });
  if (res.ok) { toast(t ? 'Tenant updated' : 'Tenant added'); loadTenantCards(); }
  else toast((await json(res)).error || 'Failed', true);
}
$('#addTenantBtn').addEventListener('click', () => editTenant(null));

async function deleteTenant(t) {
  if (!await confirmModal('Delete tenant', `Delete "${t.name}", its ${t.people} people and ALL their clock history? This cannot be undone.`, 'Delete')) return;
  const res = await adminFetch(`/api/tenants/${t.id}`, { method: 'DELETE' });
  if (res.ok) { toast('Tenant deleted'); loadTenantCards(); } else toast('Delete failed', true);
}

// ---------------------------------------------------------------------------
// ADMIN: people
// ---------------------------------------------------------------------------

let peopleCache = [];

async function loadPeople() {
  await refreshTenantsCache();
  const qs = new URLSearchParams();
  if ($('#peopleSearch').value.trim()) qs.set('search', $('#peopleSearch').value.trim());
  if ($('#peopleTenant').value) qs.set('tenant_id', $('#peopleTenant').value);
  const [people, status] = await Promise.all([
    json(await adminFetch(`/api/people?${qs}`)),
    json(await adminFetch('/api/status')),
  ]);
  const st = new Map(status.map((s) => [s.id, s.status]));
  peopleCache = people;
  $('#peopleBody').innerHTML = people.map((p) => `
    <tr class="${p.active ? '' : 'inactive'}">
      <td><b>${escapeHtml(p.name)}</b></td><td>${escapeHtml(p.tenant_name)}</td><td>${escapeHtml(p.phone || '—')}</td>
      <td>${p.active ? badge(st.get(p.id) || 'none') : '<span class="mini">inactive</span>'}</td>
      <td>${p.active ? 'Yes' : 'No'}</td>
      <td class="actions">
        <button class="icon-btn" data-edit-person="${p.id}" title="Edit">✎</button>
        <button class="icon-btn" data-log-person="${p.id}" title="Time log">⏱</button>
        <button class="icon-btn danger" data-del-person="${p.id}" title="Delete">✕</button>
      </td></tr>`).join('') || '<tr><td colspan="6" class="hint">No people found.</td></tr>';

  $$('[data-edit-person]').forEach((b) => b.addEventListener('click', () => editPerson(peopleCache.find((p) => p.id === Number(b.dataset.editPerson)))));
  $$('[data-del-person]').forEach((b) => b.addEventListener('click', async () => {
    const p = peopleCache.find((x) => x.id === Number(b.dataset.delPerson));
    if (!await confirmModal('Delete person', `Delete ${p.name} and all of their clock history?`, 'Delete')) return;
    const res = await adminFetch(`/api/people/${p.id}`, { method: 'DELETE' });
    if (res.ok) { toast('Person deleted'); loadPeople(); } else toast('Delete failed', true);
  }));
  $$('[data-log-person]').forEach((b) => b.addEventListener('click', async () => {
    const p = peopleCache.find((x) => x.id === Number(b.dataset.logPerson));
    $('#logTenant').value = String(p.tenant_id);
    await fillLogPeople(); $('#logPerson').value = String(p.id);
    showAdminPage('log');
  }));
}

async function editPerson(p) {
  if (!tenantsCache.length) return toast('Add a tenant first', true);
  const v = await openModal(p ? 'Edit person' : 'Add person', [
    { name: 'name', label: 'Full name', value: p?.name, required: true },
    { name: 'tenant_id', label: 'Tenant', type: 'select', value: p?.tenant_id ?? $('#peopleTenant').value,
      options: tenantsCache.map((t) => ({ value: t.id, label: t.name })) },
    { name: 'phone', label: 'Phone', value: p?.phone, placeholder: 'Optional' },
    ...(p ? [{ name: 'active', label: 'Status', type: 'checkbox', value: !!p.active, checkLabel: 'Active (shows on the clock screen)' }] : []),
  ], p ? 'Save' : 'Add person');
  if (!v) return;
  v.tenant_id = Number(v.tenant_id);
  if (!p) v.active = true;
  const res = await adminFetch(p ? `/api/people/${p.id}` : '/api/people', { method: p ? 'PUT' : 'POST', body: JSON.stringify(v) });
  if (res.ok) { toast(p ? 'Person updated' : 'Person added'); loadPeople(); }
  else toast((await json(res)).error || 'Failed', true);
}
$('#addPersonBtn').addEventListener('click', () => editPerson(null));
$('#peopleSearch').addEventListener('input', debounce(() => loadPeople().catch(() => {}), 200));
$('#peopleTenant').addEventListener('change', () => loadPeople().catch(() => {}));

// ---------------------------------------------------------------------------
// ADMIN: time log
// ---------------------------------------------------------------------------

let logView = 'sessions';

function rangeBounds() {
  const r = $('#logRange').value;
  const start = dayStart();
  const DAY = 86400000;
  const now = new Date();
  if (r === 'today') return { from: start, to: 0 };
  if (r === 'yesterday') return { from: start - DAY, to: start - 1 };
  if (r === 'week') { const d = new Date(start); d.setDate(d.getDate() - d.getDay()); return { from: d.getTime(), to: 0 }; }
  if (r === '7d') return { from: start - 6 * DAY, to: 0 };
  if (r === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: 0 };
  if (r === 'custom') {
    const f = $('#logFrom').value, t = $('#logTo').value;
    return { from: f ? new Date(f + 'T00:00:00').getTime() : 0, to: t ? new Date(t + 'T23:59:59.999').getTime() : 0 };
  }
  return { from: 0, to: 0 };
}

function logQuery() {
  const { from, to } = rangeBounds();
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if ($('#logTenant').value) qs.set('tenant_id', $('#logTenant').value);
  if ($('#logPerson').value) qs.set('person_id', $('#logPerson').value);
  return qs;
}

async function fillLogPeople() {
  const qs = new URLSearchParams();
  if ($('#logTenant').value) qs.set('tenant_id', $('#logTenant').value);
  const people = await json(await adminFetch(`/api/people?${qs}`));
  const cur = $('#logPerson').value;
  $('#logPerson').innerHTML = '<option value="">All people</option>' +
    people.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  $('#logPerson').value = people.some((p) => String(p.id) === cur) ? cur : '';
}

async function loadLog() {
  await refreshTenantsCache();
  await fillLogPeople();
  const custom = $('#logRange').value === 'custom';
  $('#logFrom').hidden = !custom; $('#logTo').hidden = !custom;
  const qs = logQuery();
  const table = $('#logTable');

  if (logView === 'sessions') {
    const d = await json(await adminFetch(`/api/sessions?${qs}`));
    const open = d.sessions.filter((s) => s.open).length;
    $('#logSummary').innerHTML = `
      <div class="sum-stat">Shifts <b>${d.sessions.length}</b></div>
      <div class="sum-stat">Total time <b>${fmtDuration(d.total_ms)}</b></div>
      <div class="sum-stat in">Still IN <b>${open}</b></div>`;
    table.innerHTML = `<thead><tr><th>Person</th><th>Tenant</th><th>Clocked in</th><th>Clocked out</th><th>Duration</th></tr></thead><tbody>` +
      (d.sessions.map((s) => `
        <tr><td><b>${escapeHtml(s.person_name)}</b></td><td>${escapeHtml(s.tenant_name)}</td>
        <td>${fmtTime(s.clock_in)}</td>
        <td>${s.open ? '<span class="badge in">still IN</span>' : fmtTime(s.clock_out)}</td>
        <td>${fmtDuration(s.duration_ms)}${s.open ? ' <span class="mini">so far</span>' : ''}</td></tr>`).join('')
        || '<tr><td colspan="5" class="hint">No shifts in this range.</td></tr>') + '</tbody>';
  } else {
    qs.set('limit', '500'); qs.set('paged', '1');
    const d = await json(await adminFetch(`/api/events?${qs}`));
    $('#logSummary').innerHTML = `<div class="sum-stat">Events <b>${d.total}</b></div>` +
      (d.total > d.rows.length ? `<div class="mini">Showing latest ${d.rows.length} — export CSV for everything.</div>` : '');
    table.innerHTML = `<thead><tr><th>Time</th><th>Person</th><th>Tenant</th><th>Action</th><th>Notes</th><th></th></tr></thead><tbody>` +
      (d.rows.map((e) => `
        <tr><td>${fmtTime(e.clocked_at)}</td><td><b>${escapeHtml(e.person_name)}</b></td><td>${escapeHtml(e.tenant_name)}</td>
        <td>${badge(e.direction)}</td><td>${escapeHtml(e.notes || '')}</td>
        <td class="actions"><button class="icon-btn danger" data-del-event="${e.id}" title="Delete event">✕</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="hint">No events in this range.</td></tr>') + '</tbody>';
    $$('[data-del-event]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmModal('Delete event', 'Remove this clock event? Shift totals will change.', 'Delete')) return;
      const res = await adminFetch(`/api/events/${b.dataset.delEvent}`, { method: 'DELETE' });
      if (res.ok) { toast('Event deleted'); loadLog(); } else toast('Delete failed', true);
    }));
  }
}

['#logRange', '#logFrom', '#logTo', '#logPerson'].forEach((s) => $(s).addEventListener('change', () => loadLog().catch(() => {})));
$('#logTenant').addEventListener('change', () => { $('#logPerson').value = ''; loadLog().catch(() => {}); });
$$('[data-logview]').forEach((b) => b.addEventListener('click', () => {
  logView = b.dataset.logview;
  $$('[data-logview]').forEach((x) => x.classList.toggle('active', x === b));
  loadLog().catch(() => {});
}));

$('#exportCsv').addEventListener('click', async () => {
  const path = logView === 'sessions' ? '/api/sessions.csv' : '/api/events.csv';
  const res = await adminFetch(`${path}?${logQuery()}`);
  if (!res.ok) return toast('Export failed', true);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: logView === 'sessions' ? 'time-sessions.csv' : 'clock-events.csv' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#manualEntryBtn').addEventListener('click', async () => {
  const people = await json(await adminFetch('/api/people'));
  if (!people.length) return toast('Add a person first', true);
  const v = await openModal('Manual clock entry', [
    { name: 'person_id', label: 'Person', type: 'select', value: $('#logPerson').value,
      options: people.map((p) => ({ value: p.id, label: `${p.name} — ${p.tenant_name}` })) },
    { name: 'direction', label: 'Action', type: 'select', value: 'out', options: [{ value: 'in', label: 'Clock IN' }, { value: 'out', label: 'Clock OUT' }] },
    { name: 'when', label: 'Date & time', type: 'datetime-local', value: toLocalInput(Date.now()), required: true },
    { name: 'notes', label: 'Reason / notes', value: 'Corrected by admin' },
  ], 'Add entry');
  if (!v) return;
  const res = await adminFetch('/api/events', {
    method: 'POST',
    body: JSON.stringify({ person_id: Number(v.person_id), direction: v.direction, clocked_at: new Date(v.when).getTime(), notes: v.notes }),
  });
  if (res.ok) { toast('Entry added'); loadLog(); } else toast((await json(res)).error || 'Failed', true);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadClockChips();
loadClock();
