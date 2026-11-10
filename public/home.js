'use strict';

const $ = (s) => document.querySelector(s);
const VALID = IO.LAYOUTS.map((l) => l.id);

let layout = 'table';
let mode = 'browse';
let tenants = [];                 // from /api/directory
const filter = { q: '', status: '', tenant: '' };

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 4000);
}

const tick = () => { $('#clock').textContent = new Date().toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
setInterval(tick, 10000); tick();

// ---- text size ------------------------------------------------------------
function paintSize() {
  const cur = IOPrefs.getSize();
  document.querySelectorAll('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === cur)));
}
document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => { IOPrefs.setSize(b.dataset.size); paintSize(); }));
paintSize();

// ---- layout switch --------------------------------------------------------
function paintLayoutSwitch() {
  $('#layoutSwitch').innerHTML = IO.LAYOUTS.map((l) =>
    `<button type="button" class="seg-btn" data-layout="${l.id}" aria-pressed="${l.id === layout}" title="${IO.esc(l.desc)}">${l.label}</button>`).join('');
}
$('#layoutSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (!b) return;
  layout = b.dataset.layout; layoutLocked = true;
  try { localStorage.setItem('inout_home_layout', layout); } catch { /* ignore */ }
  paintLayoutSwitch(); render();
});

// ---- filters --------------------------------------------------------------
document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
  filter.status = b.dataset.status;
  document.querySelectorAll('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));

function paintChips() {
  if (tenants.length < 2) { $('#tenantChips').innerHTML = ''; return; }
  const chip = (id, label, logo) => `<button type="button" class="chip" data-tenant="${id}" aria-pressed="${String(filter.tenant === String(id))}">${logo ? IO.avatar(label, logo, 'sm', 'logo') : ''}${IO.esc(label)}</button>`;
  $('#tenantChips').innerHTML = chip('', 'All companies') + tenants.map((t) => chip(t.id, t.name, t.logo_url)).join('');
}
$('#tenantChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tenant]');
  if (!b) return;
  filter.tenant = b.dataset.tenant;
  paintChips(); render();
});

// ---- data -----------------------------------------------------------------
let seq = 0;
async function load({ keepFocus = false } = {}) {
  const mine = ++seq;
  const qs = new URLSearchParams();
  if (filter.q) qs.set('q', filter.q);
  let data;
  try { data = await (await fetch('/api/directory?' + qs)).json(); }
  catch { $('#summary').textContent = 'Could not reach the server. Retrying…'; return; }
  if (mine !== seq) return; // stale response
  mode = data.mode;
  tenants = data.tenants;
  if (!layoutLocked && VALID.includes(data.layout)) layout = data.layout; // admin's default, until the visitor picks one
  loaded = true;
  const prevChips = $('#tenantChips').childElementCount;
  if (prevChips !== tenants.length + 1) paintChips();
  paintLayoutSwitch();
  render({ keepFocus });
}
let loaded = false;
let layoutLocked = false;   // true once the URL or the visitor's saved choice decides the layout

function render({ keepFocus = false } = {}) {
  const focused = keepFocus ? document.activeElement : null;
  const focusId = focused && focused.dataset ? focused.dataset.id : null;

  const box = $('#directory');
  const groups = tenants
    .filter((t) => !filter.tenant || String(t.id) === filter.tenant)
    .map((t) => ({ tenant: t, people: t.people.filter((p) => !filter.status || p.status === filter.status || (filter.status === 'out' && p.status === 'none')) }))
    .filter((g) => g.people.length);

  const all = tenants.flatMap((t) => t.people);
  const inN = all.filter((p) => p.status === 'in').length;
  $('#summary').innerHTML = all.length
    ? `<span class="sum-stat in">In <b>${inN}</b></span><span class="sum-stat out">Out <b>${all.length - inN}</b></span><span class="sum-stat">${all.length} ${all.length === 1 ? 'person' : 'people'} in ${tenants.length} ${tenants.length === 1 ? 'company' : 'companies'}</span>`
    : '';

  if (!tenants.length) {
    box.innerHTML = mode === 'search' && !filter.q
      ? '<p class="hint center">Start typing your name, then tap IN or OUT.</p>'
      : '<p class="hint center">No one matches that search. Check the spelling, or ask an admin.</p>';
    return;
  }
  if (!groups.length) { box.innerHTML = '<p class="hint center">Nobody matches those filters.</p>'; return; }
  box.innerHTML = IO.renderGroups(groups, layout, { action: true });

  if (focusId) {
    const again = box.querySelector(`[data-id="${focusId}"]`);
    if (again) again.focus();
  }
}

// ---- clocking in / out (one delegated handler for every layout) -----------
$('#directory').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-dir]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const res = await fetch('/api/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: Number(btn.dataset.id), direction: btn.dataset.dir }),
  });
  if (res.ok) toast(`${btn.dataset.name} is now ${btn.dataset.dir.toUpperCase()}`);
  else toast((await res.json().catch(() => ({}))).error || 'Something went wrong', true);
  await load({ keepFocus: true });
  const again = $('#directory').querySelector(`[data-id="${btn.dataset.id}"]`);
  if (again) again.focus();
});

let t;
$('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filter.q = $('#q').value.trim(); load(); }, 180); });

// ---- start ----------------------------------------------------------------
(function init() {
  let saved = null;
  try { saved = localStorage.getItem('inout_home_layout'); } catch { /* ignore */ }
  const url = new URLSearchParams(location.search).get('layout');
  if (VALID.includes(url)) { layout = url; layoutLocked = true; }            // ?layout=... wins (handy per-tablet)
  else if (VALID.includes(saved)) { layout = saved; layoutLocked = true; }   // then the visitor's own choice
  load();
  // keep statuses fresh while nobody is typing
  setInterval(() => { if (document.visibilityState === 'visible' && document.activeElement !== $('#q')) load({ keepFocus: true }); }, 30000);
})();
