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
// Keyboard handling shared by both dialogs: Escape closes, Tab stays inside, focus returns to the opener.
function trapKeys(container, onEscape) {
  const handler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex="0"]')]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

function openModal(title, fields, okLabel = 'Save') {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    $('#modalTitle').textContent = title;
    $('#modalOk').textContent = okLabel;
    $('#modalFields').innerHTML = fields.map((f) => {
      const id = `mf_${f.name}`;
      if (f.type === 'hidden') return `<p>${escapeHtml(f.label)}</p><input type="hidden" id="${id}" value="" />`;
      if (f.type === 'checkbox') {
        return `<div class="field"><span>${escapeHtml(f.label)}</span><label class="check"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}/> <span>${escapeHtml(f.checkLabel || '')}</span></label></div>`;
      }
      let input;
      if (f.type === 'select') {
        input = `<select id="${id}" class="select">${f.options.map((o) =>
          `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea id="${id}" class="search" rows="3" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`;
      } else {
        input = `<input id="${id}" class="search" type="${f.type || 'text'}" value="${escapeHtml(f.value ?? '')}" placeholder="${escapeHtml(f.placeholder || '')}" ${f.required ? 'required' : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}/>`;
      }
      return `<label class="field"><span>${escapeHtml(f.label)}</span>${input}${f.hint ? `<span class="hint">${escapeHtml(f.hint)}</span>` : ''}</label>`;
    }).join('');
    const back = $('#modalBack');
    back.hidden = false;
    // Focus the first real field; for plain confirmations focus Cancel so Enter can't delete by accident.
    ($('#modalFields input:not([type=hidden]), #modalFields select, #modalFields textarea') || $('#modalCancel')).focus();

    const form = $('#modalForm');
    let untrap = () => {};
    const close = (val) => {
      back.hidden = true;
      form.onsubmit = null; $('#modalCancel').onclick = null; back.onclick = null; untrap();
      if (opener && opener.focus && document.contains(opener)) opener.focus();
      resolve(val);
    };
    untrap = trapKeys(back, () => close(null));
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
  setTimeout(() => { const u = $('#loginUser'); if (u && !$('#adminGate').hidden) u.focus(); }, 0);
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
const adminLoaders = { overview: loadOverview, board: loadBoard, tenants: loadTenantCards, people: loadPeople, log: loadLog, admins: loadAdmins, settings: loadSettings };

function showAdminPage(name) {
  currentAdminPage = name;
  $$('.side-link[data-admin]').forEach((b) => {
    const on = b.dataset.admin === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
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

function tenantMetaHtml(t) {
  const bits = [t.office, t.phone, t.email, t.website].filter(Boolean).map((v) => `<span>${escapeHtml(v)}</span>`);
  return bits.length ? `<div class="tenant-meta">${bits.join('')}</div>` : '';
}

let tenantRows = [];
async function loadTenantCards() {
  const d = await json(await adminFetch(`/api/admin/overview?day_start=${dayStart()}`));
  await refreshTenantsCache();
  const full = new Map(tenantsCache.map((t) => [t.id, t]));
  tenantRows = d.tenants.map((o) => ({ ...full.get(o.id), ...o }));
  $('#tenantCards').innerHTML = tenantRows.map((t) => `
    <article class="card tenant-card" aria-labelledby="tc-${t.id}">
      <div class="tenant-top">
        <div class="name-cell">${t.logo_url ? `<img class="avatar lg logo" src="${escapeHtml(t.logo_url)}" alt="" />` : IO.avatar(t.name, null, 'lg')}<h3 id="tc-${t.id}">${escapeHtml(t.name)}</h3></div>
        <div class="btn-row">
          <button type="button" class="icon-btn" data-edit-tenant="${t.id}" aria-label="Edit ${escapeHtml(t.name)}" title="Edit">✎</button>
          <button type="button" class="icon-btn danger" data-del-tenant="${t.id}" aria-label="Delete ${escapeHtml(t.name)}" title="Delete">✕</button>
        </div>
      </div>
      ${tenantMetaHtml(t)}
      <p class="mini">${escapeHtml(t.notes || 'No notes')}</p>
      <div class="tenant-stats">
        <div><b>${t.people}</b><span>people</span></div>
        <div class="in"><b>${t.in_count}</b><span>in</span></div>
        <div class="out"><b>${t.out_count}</b><span>out</span></div>
        <div><b>${fmtDuration(t.today_ms)}</b><span>today</span></div>
      </div>
      <div class="btn-row">
        <label class="btn sm">${t.logo_url ? 'Change logo' : 'Upload logo'}<span class="sr-only"> for ${escapeHtml(t.name)}</span><input type="file" accept="image/*" data-logo-tenant="${t.id}" /></label>
        ${t.logo_url ? `<button type="button" class="btn sm" data-logo-remove="${t.id}" aria-label="Remove logo for ${escapeHtml(t.name)}">Remove logo</button>` : ''}
        <button type="button" class="btn sm" data-view-log="${t.id}">Time log →</button>
      </div>
    </article>`).join('') || '<p class="hint">No tenants yet. Add your first one.</p>';

  $$('[data-edit-tenant]').forEach((b) => b.addEventListener('click', () => editTenant(tenantRows.find((t) => t.id === Number(b.dataset.editTenant)))));
  $$('[data-del-tenant]').forEach((b) => b.addEventListener('click', () => deleteTenant(tenantRows.find((t) => t.id === Number(b.dataset.delTenant)))));
  $$('[data-view-log]').forEach((b) => b.addEventListener('click', () => {
    $('#logTenant').value = b.dataset.viewLog; $('#logPerson').value = '';
    showAdminPage('log');
  }));
  $$('[data-logo-tenant]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0]; inp.value = '';
    if (!file) return;
    try { await IO.uploadImage(`/api/tenants/${inp.dataset.logoTenant}/logo`, file, 'logo'); toast('Logo updated'); loadTenantCards(); }
    catch (err) { toast(err.message, true); }
  }));
  $$('[data-logo-remove]').forEach((b) => b.addEventListener('click', async () => {
    const res = await adminFetch(`/api/tenants/${b.dataset.logoRemove}/logo`, { method: 'DELETE' });
    if (res.ok) { toast('Logo removed'); loadTenantCards(); } else toast('Failed', true);
  }));
}

async function editTenant(t) {
  const v = await openModal(t ? 'Edit tenant' : 'Add tenant', [
    { name: 'name', label: 'Tenant name', value: t?.name, required: true },
    { name: 'office', label: 'Office / suite', value: t?.office, placeholder: 'For example: Suite 204' },
    { name: 'phone', label: 'Company phone', value: t?.phone, autocomplete: 'off' },
    { name: 'email', label: 'Company email', type: 'email', value: t?.email },
    { name: 'website', label: 'Website', value: t?.website, placeholder: 'example.com' },
    { name: 'notes', label: 'Private notes (admins only)', type: 'textarea', value: t?.notes },
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

function sharedSummary(p) {
  const shown = [p.show_office && p.office ? 'Office' : '', p.show_phone && p.phone ? 'Phone' : '', p.show_email && p.email ? 'Email' : ''].filter(Boolean);
  const pic = p.avatar_mode === 'logo' ? 'company logo' : p.avatar_mode === 'initials' ? 'initials' : 'photo';
  return `${shown.length ? shown.join(', ') : 'Name only'}<div class="mini">Picture: ${pic}</div>`;
}

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
      <td><div class="name-cell">${IO.avatar(p.name, p.avatar_url, 'sm', p.avatar_kind)}<div><strong>${escapeHtml(p.name)}</strong>${p.title ? `<div class="mini">${escapeHtml(p.title)}</div>` : ''}</div></div></td>
      <td>${escapeHtml(p.tenant_name)}${p.office ? `<div class="mini">${escapeHtml(p.office)}</div>` : ''}</td>
      <td>${sharedSummary(p)}</td>
      <td>${p.active ? badge(st.get(p.id) || 'none') : '<span class="mini">inactive</span>'}</td>
      <td>${p.active ? 'Yes' : 'No'}</td>
      <td class="actions">
        <button type="button" class="icon-btn" data-profile-person="${p.id}" aria-label="Profile, picture and visibility for ${escapeHtml(p.name)}" title="Profile & visibility">👤</button>
        <button type="button" class="icon-btn" data-edit-person="${p.id}" aria-label="Edit ${escapeHtml(p.name)}" title="Edit">✎</button>
        <button type="button" class="icon-btn" data-log-person="${p.id}" aria-label="Time log for ${escapeHtml(p.name)}" title="Time log">⏱</button>
        <button type="button" class="icon-btn danger" data-del-person="${p.id}" aria-label="Delete ${escapeHtml(p.name)}" title="Delete">✕</button>
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
    ...(p ? [{ name: 'active', label: 'Status', type: 'checkbox', value: !!p.active, checkLabel: 'Active (shows on the board)' }] : []),
  ], p ? 'Save' : 'Add person');
  if (!v) return;
  v.tenant_id = Number(v.tenant_id);
  if (!p) v.active = true;
  const res = await adminFetch(p ? `/api/people/${p.id}` : '/api/people', { method: p ? 'PUT' : 'POST', body: JSON.stringify(v) });
  if (res.ok) { toast(p ? 'Person updated' : 'Person added'); loadPeople(); }
  else toast((await json(res)).error || 'Failed', true);
}

$('#bulkVisBtn').addEventListener('click', async () => {
  await refreshTenantsCache();
  const v = await openModal('Visibility for many people', [
    { name: 'field', label: 'What to change', type: 'select', value: 'show_phone', options: [
      { value: 'show_phone', label: 'Phone numbers' }, { value: 'show_email', label: 'Email addresses' }, { value: 'show_office', label: 'Office / suite' }] },
    { name: 'value', label: 'Set to', type: 'select', value: 'true', options: [
      { value: 'true', label: 'Shown on the public board' }, { value: 'false', label: 'Hidden' }] },
    { name: 'tenant_id', label: 'Who', type: 'select', value: '', options: [
      { value: '', label: 'Everyone, in every tenant' }, ...tenantsCache.map((t) => ({ value: t.id, label: 'Everyone at ' + t.name }))] },
  ], 'Apply');
  if (!v) return;
  const res = await adminFetch('/api/admin/visibility', { method: 'POST', body: JSON.stringify({
    field: v.field, value: v.value === 'true', tenant_id: v.tenant_id ? Number(v.tenant_id) : undefined }) });
  if (res.ok) { toast(`Updated ${(await json(res)).updated} people`); loadPeople(); } else toast('Failed', true);
});
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
  $$('[data-logview]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
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

let boardLayout = 'table';
try { const v = localStorage.getItem('inout_board_layout'); if (IO.LAYOUTS.some((l) => l.id === v)) boardLayout = v; } catch { /* ignore */ }

function paintLayoutSwitch() {
  $('#boardLayout').innerHTML = IO.LAYOUTS.map((l) =>
    `<button type="button" class="seg-btn" data-layout="${l.id}" aria-pressed="${l.id === boardLayout}" title="${escapeHtml(l.desc)}">${l.label}</button>`).join('');
}
$('#boardLayout').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (!b) return;
  boardLayout = b.dataset.layout;
  try { localStorage.setItem('inout_board_layout', boardLayout); } catch { /* ignore */ }
  paintLayoutSwitch();
  loadBoard().catch(() => {});
  $(`#boardLayout [data-layout="${boardLayout}"]`).focus();
});

async function loadBoard() {
  await refreshTenantsCache();
  paintLayoutSwitch();
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
  const inCount = people.filter((p) => p.status === 'in').length;
  $('#boardSummary').innerHTML = `
    <span class="sum-stat in">In <b>${inCount}</b></span>
    <span class="sum-stat out">Out <b>${people.length - inCount}</b></span>
    <span class="sum-stat">Total <b>${people.length}</b></span>`;
  $('#boardUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' · refreshes every 30 seconds';
  // Admins see everything on the live board, regardless of what a person shows publicly.
  $('#boardBody').innerHTML = people.length
    ? IO.renderGroups(IO.groupFlat(people, new Map(tenantsCache.map((t) => [t.id, t]))), boardLayout, { detail: true })
    : '<p class="hint center">No people found.</p>';
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
let profOpener = null;
let profUntrap = () => {};

function closeProfile() {
  $('#profBack').hidden = true;
  profId = null;
  profUntrap();
  if (profOpener && profOpener.focus && document.contains(profOpener)) profOpener.focus();
  if (currentAdminPage === 'people') loadPeople().catch(() => {});
}

function paintProfile() {
  const p = profData;
  $('#profAvatar').innerHTML = IO.avatar(p.name, p.avatar_url, 'xl', p.avatar_kind);
  $('#profTitle').textContent = p.name;
  $('#profSub').textContent = `${p.tenant_name}${p.active ? '' : ' · inactive'}`;
  $('#profPhotoRemove').hidden = !p.photo_url;
  const opts = [
    { v: 'photo', label: 'Their photo', desc: p.photo_url ? 'The uploaded photo.' : 'No photo uploaded yet.', pic: IO.avatar(p.name, p.photo_url, 'md') },
    { v: 'logo', label: 'Company logo', desc: p.tenant.logo_url ? `${p.tenant.name}'s logo.` : 'This tenant has no logo yet.', pic: IO.avatar(p.tenant.name, p.tenant.logo_url, 'md', 'logo'), disabled: !p.tenant.logo_url },
    { v: 'initials', label: 'Initials only', desc: 'A coloured circle.', pic: IO.avatar(p.name, null, 'md') },
  ];
  $('#pfAvatarOpts').innerHTML = opts.map((o) => `
    <label class="opt"><input type="radio" name="pf_avatar_mode" value="${o.v}" ${o.v === p.avatar_mode ? 'checked' : ''} ${o.disabled ? 'disabled' : ''} />
      <span class="opt-body"><span class="name-cell">${o.pic}<b>${o.label}</b></span><span class="mini">${escapeHtml(o.desc)}</span></span></label>`).join('');
  $('#pfTitle').value = p.title; $('#pfOffice').value = p.office; $('#pfPhone').value = p.phone; $('#pfEmail').value = p.email; $('#pfBio').value = p.bio;
  $('#pfVisOffice').checked = p.show_office; $('#pfVisPhone').checked = p.show_phone; $('#pfVisEmail').checked = p.show_email;
  $('#pfManager').checked = p.is_manager;
  $('#pfError').hidden = true;
  $('#accessBox').innerHTML = p.has_access
    ? `<b>Profile sign-in is on.</b>
       <div class="cred"><span class="mini">Sign-in name</span><code>${escapeHtml(p.handle)}</code><span class="mini">Page</span><code>${escapeHtml(location.origin)}/me</code></div>
       ${p.must_change ? '<p class="mini">Waiting for them to choose their own password.</p>' : ''}
       <div class="btn-row access-actions"><button type="button" class="btn" id="accReset">Reset password</button><button type="button" class="btn danger" id="accRevoke">Turn off sign-in</button></div>`
    : `<b>No profile sign-in yet.</b>
       <p class="mini">Create one so this person can sign in at <code>/me</code>, add their own photo and manage their details.</p>
       <button type="button" class="btn primary" id="accCreate">Create sign-in</button>`;
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
  profOpener = document.activeElement;
  profId = id;
  await refreshProfile();
  $('#profBack').hidden = false;
  profUntrap = trapKeys($('#profBack'), closeProfile);
  const h = $('#profTitle'); h.setAttribute('tabindex', '-1'); h.focus();
}

async function grantAccess(isReset) {
  const res = await adminFetch(`/api/people/${profId}/access`, { method: 'POST' });
  if (!res.ok) return toast('Failed', true);
  const d = await json(res);
  await refreshProfile();
  // Show the one-time temporary password.
  $('#accessBox').insertAdjacentHTML('afterbegin', `
    <div class="form-error one-time" role="alert"><b>${isReset ? 'New temporary password' : 'Sign-in created'} — shown once, copy it now.</b>
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
  const mode = document.querySelector('input[name=pf_avatar_mode]:checked');
  const res = await adminFetch(`/api/people/${p.id}`, { method: 'PUT', body: JSON.stringify({
    name: p.name, tenant_id: p.tenant_id, active: !!p.active,
    phone: $('#pfPhone').value, title: $('#pfTitle').value, email: $('#pfEmail').value, bio: $('#pfBio').value, office: $('#pfOffice').value,
    show_office: $('#pfVisOffice').checked, show_phone: $('#pfVisPhone').checked, show_email: $('#pfVisEmail').checked,
    avatar_mode: mode ? mode.value : 'photo', is_manager: $('#pfManager').checked,
  }) });
  if (res.ok) { toast('Profile saved'); refreshProfile(); }
  else { const err = $('#pfError'); err.hidden = false; err.textContent = (await json(res)).error || 'Could not save'; }
});
$('#profClose').addEventListener('click', closeProfile);
$('#profBack').addEventListener('click', (e) => { if (e.target === $('#profBack')) closeProfile(); });

// ---------------------------------------------------------------------------
// ADMIN: settings (kiosk layout + mode)
// ---------------------------------------------------------------------------

const MODES = [
  { id: 'browse', label: 'Show everyone', desc: 'The whole directory is visible, grouped by tenant, and stays up to date. People only show the contact details they chose to share.' },
  { id: 'search', label: 'Search only', desc: 'Visitors must type a name or company to see anyone. Best for privacy on a shared tablet.' },
];

async function loadSettings() {
  const st = await json(await adminFetch('/api/admin/settings'));
  const radio = (name, items, value) => items.map((o) => `
    <label class="opt">
      <input type="radio" name="${name}" value="${o.id}" ${o.id === value ? 'checked' : ''} />
      <span class="opt-body"><b>${escapeHtml(o.label)}</b><span class="mini">${escapeHtml(o.desc)}</span>
      ${name === 'kiosk_layout' ? `<a class="mini" href="/?layout=${o.id}" target="_blank" rel="noopener">Preview ${escapeHtml(o.label)}<span class="sr-only"> (opens in a new tab)</span> ↗</a>` : ''}</span>
    </label>`).join('');
  $('#layoutOpts').setAttribute('role', 'radiogroup'); $('#layoutOpts').setAttribute('aria-label', 'Default layout');
  $('#modeOpts').setAttribute('role', 'radiogroup'); $('#modeOpts').setAttribute('aria-label', 'What the board shows');
  $('#layoutOpts').innerHTML = radio('kiosk_layout', IO.LAYOUTS, st.kiosk_layout);
  $('#modeOpts').innerHTML = radio('kiosk_mode', MODES, st.kiosk_mode);
}

$('#admin-settings').addEventListener('change', async (e) => {
  const input = e.target.closest('input[type=radio]');
  if (!input) return;
  const res = await adminFetch('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ [input.name]: input.value }) });
  if (res.ok) { toast('Saved'); await loadSettings(); const again = document.querySelector(`input[name="${input.name}"][value="${input.value}"]`); if (again) again.focus(); } else toast((await json(res)).error || 'Could not save', true);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadAdmin();
