'use strict';

const $ = (s) => document.querySelector(s);
const { esc, avatar, uploadPhoto } = window.IO;

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 3000);
}
function fmt(ms) { return ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
function dur(ms) { const m = Math.round((ms || 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; }
function showErr(el, msg) { el.hidden = !msg; el.textContent = msg || ''; }

async function call(path, method = 'GET', body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function show(which) {
  $('#loginCard').hidden = which !== 'login';
  $('#pwCard').hidden = which !== 'pw';
  $('#profile').hidden = which !== 'profile';
  $('#acct').hidden = which === 'login';
}

let me = null;

function render(p) {
  me = p;
  if (p.must_change) return show('pw');
  show('profile');
  $('#photoBox').innerHTML = avatar(p.name, p.photo_url, 'xl');
  $('#photoRemove').hidden = !p.photo_url;
  $('#pName').textContent = p.name;
  $('#pTenant').textContent = p.tenant_name;
  $('#pHandle').textContent = 'Sign-in name: ' + p.handle;
  $('#fTitle').value = p.title; $('#fPhone').value = p.phone; $('#fEmail').value = p.email; $('#fBio').value = p.bio;
  loadShifts();
}

async function loadShifts() {
  const { ok, data } = await call('/api/me/shifts');
  if (!ok) return;
  $('#shiftsBody').innerHTML = data.map((s) => `
    <tr><td>${fmt(s.clock_in)}</td><td>${s.open ? '<span class="badge in">still IN</span>' : fmt(s.clock_out)}</td><td>${dur(s.duration_ms)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="hint">No shifts in the last 30 days.</td></tr>';
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/login', 'POST', { handle: $('#loginHandle').value, password: $('#loginPass').value });
  if (!r.ok) { $('#loginPass').value = ''; return showErr($('#loginError'), r.data.error || 'Sign in failed'); }
  showErr($('#loginError'), '');
  if (r.data.must_change) { $('#pwCurrent').value = $('#loginPass').value; }
  $('#loginPass').value = '';
  render(r.data);
});

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/password', 'POST', { current: $('#pwCurrent').value, next: $('#pwNext').value });
  if (!r.ok) return showErr($('#pwError'), r.data.error || 'Could not change password');
  $('#pwCurrent').value = ''; $('#pwNext').value = '';
  toast('Password saved');
  const me2 = await call('/api/me');
  if (me2.ok) render(me2.data);
});

$('#pwChangeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/password', 'POST', { current: $('#cpCurrent').value, next: $('#cpNext').value });
  if (r.ok) { toast('Password changed'); $('#cpCurrent').value = ''; $('#cpNext').value = ''; }
  else toast(r.data.error || 'Could not change password', true);
});

$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me', 'PUT', { title: $('#fTitle').value, phone: $('#fPhone').value, email: $('#fEmail').value, bio: $('#fBio').value });
  if (!r.ok) return showErr($('#profileError'), r.data.error || 'Could not save');
  showErr($('#profileError'), '');
  toast('Profile saved');
  render(r.data);
});

$('#photoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await uploadPhoto('/api/me/photo', file);
    toast('Photo updated');
    me.photo_url = r.photo_url; render(me);
  } catch (err) { toast(err.message, true); }
});

$('#photoRemove').addEventListener('click', async () => {
  const r = await call('/api/me/photo', 'DELETE');
  if (r.ok) { toast('Photo removed'); me.photo_url = null; render(me); } else toast('Could not remove photo', true);
});

$('#logoutBtn').addEventListener('click', async () => { await call('/api/me/logout', 'POST'); me = null; show('login'); });

(async () => {
  const r = await call('/api/me');
  if (r.ok) render(r.data); else show('login');
})();
