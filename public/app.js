'use strict';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  return fetch(path, { ...opts, credentials: 'same-origin', headers: { ...headers, ...(opts.headers || {}) } });
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

function tickClock() {
  $('#headerClock').textContent = new Date().toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}
setInterval(tickClock, 1000);
tickClock();

// ---------------------------------------------------------------------------
// ADMIN: gate + navigation
// ---------------------------------------------------------------------------

let boardTimer = null;

function showLogin(msg) {
  $('#adminGate').hidden = false;
  $('#adminPanel').hidden = true;
  $('#acct').hidden = true;
  clearInterval(boardTimer);
  const err = $('#loginError');
  err.hidden = !msg; err.textContent = msg || '';
}

async function adminFetch(path, opts = {}) {
  const res = await api(path, opts);
  if (res.status === 401) { showLogin('Your session expired. Please sign in again.'); throw new Error('unauthorized'); }
  return res;
}

async function loadAdmin() {
  const me = await api('/api/auth/me');
  if (!me.ok) return showLogin();
  $('#acctName').textContent = (await json(me)).username;
  $('#acct').hidden = false;
  $('#adminGate').hidden = true;
  $('#adminPanel').hidden = false;
  showAdminPage(currentAdminPage);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: $('#loginUser').value, password: $('#loginPass').value }),
  });
  if (!res.ok) { $('#loginPass').value = ''; return showLogin((await json(res)).error || 'Sign in failed'); }
  $('#loginPass').value = '';
  $('#loginError').hidden = true;
  loadAdmin();
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  showLogin();
});

let currentAdminPage = 'overview';
const adminLoaders = { overview: loadOverview, board: loadBoard, tenants: loadTenantCards, people: loadPeople, log: loadLog, admins: loadAdmins };

function showAdminPage(name) {
  currentAdminPage = name;
  $$('.side-link[data-admin]').forEach((b) => b.classList.toggle('active', b.dataset.admin === name));
  $$('.admin-page').forEach((p) => p.classList.toggle('active', p.id === `admin-${name}`));
  clearInterval(boardTimer);
  if (name === 'board') boardTimer = setInterval(() => loadBoard().catch(() => {}), 30000);
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
      <td><div class="name-cell">${IO.avatar(p.name, p.photo_url, 'sm')}<div><b>${escapeHtml(p.name)}</b>${p.title ? `<div class="mini">${escapeHtml(p.title)}</div>` : ''}</div></div></td><td>${escapeHtml(p.tenant_name)}</td><td>${escapeHtml(p.phone || '—')}</td>
      <td>${p.active ? badge(st.get(p.id) || 'none') : '<span class="mini">inactive</span>'}</td>
      <td>${p.active ? 'Yes' : 'No'}</td>
      <td class="actions">
        <button class="icon-btn" data-profile-person="${p.id}" title="Profile & photo">👤</button>
        <button class="icon-btn" data-edit-person="${p.id}" title="Edit">✎</button>
        <button class="icon-btn" data-log-person="${p.id}" title="Time log">⏱</button>
        <button class="icon-btn danger" data-del-person="${p.id}" title="Delete">✕</button>
      </td></tr>`).join('') || '<tr><td colspan="6" class="hint">No people found.</td></tr>';

  $$('[data-profile-person]').forEach((b) => b.addEventListener('click', () => openProfile(Number(b.dataset.profilePerson))));
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
// ADMIN: live board (full detail, auto-refresh)
// ---------------------------------------------------------------------------

async function loadBoard() {
  await refreshTenantsCache();
  const sel = $('#boardTenant');
  if (!sel.dataset.filled || sel.options.length !== tenantsCache.length + 1) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">All tenants</option>' + tenantsCache.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    sel.value = cur; sel.dataset.filled = '1';
  }
  const qs = new URLSearchParams();
  if ($('#boardSearch').value.trim()) qs.set('search', $('#boardSearch').value.trim());
  if (sel.value) qs.set('tenant_id', sel.value);
  const people = await json(await adminFetch(`/api/status?${qs}`));
  let inCount = 0;
  const byTenant = new Map();
  for (const p of people) {
    if (p.status === 'in') inCount++;
    if (!byTenant.has(p.tenant_name)) byTenant.set(p.tenant_name, []);
    byTenant.get(p.tenant_name).push(p);
  }
  $('#boardSummary').innerHTML = `
    <div class="sum-stat in">IN <b>${inCount}</b></div>
    <div class="sum-stat out">OUT <b>${people.length - inCount}</b></div>
    <div class="sum-stat">Total <b>${people.length}</b></div>`;
  $('#boardUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' · auto-refreshes';
  $('#boardBody').innerHTML = people.length ? [...byTenant.entries()].map(([tenant, rows]) => `
    <div class="tenant-group"><h3>${escapeHtml(tenant)}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Last clock</th><th>Notes</th></tr></thead>
        <tbody>${rows.map((p) => `<tr><td><div class="name-cell">${IO.avatar(p.name, p.photo_url, 'sm')}<b>${escapeHtml(p.name)}</b></div></td><td>${escapeHtml(p.phone || '—')}</td>
          <td>${badge(p.status)}</td><td>${fmtTime(p.clocked_at)}</td><td>${escapeHtml(p.notes || '')}</td></tr>`).join('')}</tbody>
      </table></div></div>`).join('') : '<p class="hint center">No people found.</p>';
}
$('#boardSearch').addEventListener('input', debounce(() => loadBoard().catch(() => {}), 200));
$('#boardTenant').addEventListener('change', () => loadBoard().catch(() => {}));
$('#refreshBoard').addEventListener('click', () => loadBoard().catch(() => {}));

// ---------------------------------------------------------------------------
// ADMIN: admin accounts
// ---------------------------------------------------------------------------

async function loadAdmins() {
  const users = await json(await adminFetch('/api/admin/users'));
  const me = $('#acctName').textContent;
  $('#adminsBody').innerHTML = users.map((u) => `
    <tr><td><b>${escapeHtml(u.username)}</b>${u.username === me ? ' <span class="badge none">you</span>' : ''}</td>
    <td>${fmtTime(u.created_at)}</td><td>${fmtTime(u.last_login)}</td>
    <td class="actions">${u.username === me ? '' : `<button class="icon-btn danger" data-del-admin="${u.id}" data-name="${escapeHtml(u.username)}" title="Remove">✕</button>`}</td></tr>`).join('');
  $$('[data-del-admin]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmModal('Remove admin', `Remove admin account "${b.dataset.name}"? They will be signed out.`, 'Remove')) return;
    const res = await adminFetch(`/api/admin/users/${b.dataset.delAdmin}`, { method: 'DELETE' });
    if (res.ok) { toast('Admin removed'); loadAdmins(); } else toast((await json(res)).error || 'Failed', true);
  }));
}

$('#addAdminBtn').addEventListener('click', async () => {
  const v = await openModal('Add admin', [
    { name: 'username', label: 'Username', required: true },
    { name: 'password', label: 'Password (min 10 characters)', type: 'password', required: true },
  ], 'Add admin');
  if (!v) return;
  const res = await adminFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(v) });
  if (res.ok) { toast('Admin added'); loadAdmins(); } else toast((await json(res)).error || 'Failed', true);
});

$('#changePwBtn').addEventListener('click', async () => {
  const v = await openModal('Change my password', [
    { name: 'current', label: 'Current password', type: 'password', required: true },
    { name: 'next', label: 'New password (min 10 characters)', type: 'password', required: true },
  ], 'Change password');
  if (!v) return;
  const res = await adminFetch('/api/auth/password', { method: 'POST', body: JSON.stringify(v) });
  if (res.ok) toast('Password changed'); else toast((await json(res)).error || 'Failed', true);
});

// ---------------------------------------------------------------------------
// ADMIN: person profile dialog (photo, details, sign-in access)
// ---------------------------------------------------------------------------

let profId = null;
let profData = null;

function closeProfile() {
  $('#profBack').hidden = true;
  profId = null;
  if (currentAdminPage === 'people') loadPeople().catch(() => {});
}

function paintProfile() {
  const p = profData;
  $('#profAvatar').innerHTML = IO.avatar(p.name, p.photo_url, 'xl');
  $('#profTitle').textContent = p.name;
  $('#profSub').textContent = `${p.tenant_name}${p.active ? '' : ' · inactive'}`;
  $('#profPhotoRemove').hidden = !p.photo_url;
  $('#pfTitle').value = p.title; $('#pfPhone').value = p.phone; $('#pfEmail').value = p.email; $('#pfBio').value = p.bio;
  $('#pfError').hidden = true;
  $('#accessBox').innerHTML = p.has_access
    ? `<b>Profile sign-in is on.</b>
       <div class="cred"><span class="mini">Sign-in name</span><code>${escapeHtml(p.handle)}</code><span class="mini">Page</span><code>${escapeHtml(location.origin)}/me</code></div>
       ${p.must_change ? '<p class="mini">Waiting for them to choose their own password.</p>' : ''}
       <div class="btn-row access-actions"><button class="btn" id="accReset">Reset password</button><button class="btn danger" id="accRevoke">Turn off sign-in</button></div>`
    : `<b>No profile sign-in yet.</b>
       <p class="mini">Create one so this person can sign in at <code>/me</code>, add their own photo and manage their details.</p>
       <button class="btn primary" id="accCreate">Create sign-in</button>`;
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('#accCreate', () => grantAccess(false));
  on('#accReset', () => grantAccess(true));
  on('#accRevoke', async () => {
    if (!await confirmModal('Turn off sign-in', `${p.name} will no longer be able to sign in. Their profile stays.`, 'Turn off')) return;
    const res = await adminFetch(`/api/people/${p.id}/access`, { method: 'DELETE' });
    if (res.ok) { toast('Sign-in turned off'); refreshProfile(); } else toast('Failed', true);
  });
}

async function refreshProfile() {
  profData = await json(await adminFetch(`/api/people/${profId}`));
  paintProfile();
}

async function openProfile(id) {
  profId = id;
  await refreshProfile();
  $('#profBack').hidden = false;
}

async function grantAccess(isReset) {
  const res = await adminFetch(`/api/people/${profId}/access`, { method: 'POST' });
  if (!res.ok) return toast('Failed', true);
  const d = await json(res);
  await refreshProfile();
  // Show the one-time temporary password.
  $('#accessBox').insertAdjacentHTML('afterbegin', `
    <div class="form-error one-time"><b>${isReset ? 'New temporary password' : 'Sign-in created'} — shown once, copy it now.</b>
      <div class="cred"><span>Sign-in name</span><code>${escapeHtml(d.handle)}</code><span>Temporary password</span><code>${escapeHtml(d.temp_password)}</code></div>
      <p class="mini">They'll be asked to choose their own password the first time they sign in.</p></div>`);
}

$('#profFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { await IO.uploadPhoto(`/api/people/${profId}/photo`, file); toast('Photo updated'); refreshProfile(); }
  catch (err) { toast(err.message, true); }
});
$('#profPhotoRemove').addEventListener('click', async () => {
  const res = await adminFetch(`/api/people/${profId}/photo`, { method: 'DELETE' });
  if (res.ok) { toast('Photo removed'); refreshProfile(); } else toast('Failed', true);
});
$('#profForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = profData;
  const res = await adminFetch(`/api/people/${p.id}`, { method: 'PUT', body: JSON.stringify({
    name: p.name, tenant_id: p.tenant_id, active: !!p.active,
    phone: $('#pfPhone').value, title: $('#pfTitle').value, email: $('#pfEmail').value, bio: $('#pfBio').value,
  }) });
  if (res.ok) { toast('Profile saved'); refreshProfile(); }
  else { const err = $('#pfError'); err.hidden = false; err.textContent = (await json(res)).error || 'Could not save'; }
});
$('#profClose').addEventListener('click', closeProfile);
$('#profBack').addEventListener('click', (e) => { if (e.target === $('#profBack')) closeProfile(); });

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadAdmin();
