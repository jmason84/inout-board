'use strict';

const $ = (s) => document.querySelector(s);
const { esc, avatar, uploadImage } = window.IO;

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 3500);
}
const fmt = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const dur = (ms) => { const m = Math.round((ms || 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
function showErr(el, msg) { el.hidden = !msg; el.textContent = msg || ''; }

async function call(path, method = 'GET', body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

function show(which) {
  $('#loginCard').hidden = which !== 'login';
  $('#pwCard').hidden = which !== 'pw';
  $('#profile').hidden = which !== 'profile';
  $('#acct').hidden = which === 'login';
  const target = { login: '#loginHandle', pw: '#pwNext', profile: '#aboutH' }[which];
  const el = $(target);
  if (el) { if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) el.setAttribute('tabindex', '-1'); el.focus(); }
}

let me = null;

// ---- the picture options + live preview ----------------------------------
function currentAvatarMode() { const r = document.querySelector('input[name=avatar_mode]:checked'); return r ? r.value : 'photo'; }

function paintAvatarOptions(p) {
  const opts = [
    { v: 'photo', label: 'My photo', desc: p.photo_url ? 'Shows the photo you uploaded.' : 'Upload a photo above first. Until then your initials show.', pic: avatar(p.name, p.photo_url, 'md') },
    { v: 'logo', label: 'My company logo', desc: p.tenant.logo_url ? 'Shows ' + p.tenant.name + "'s logo." : 'Your company has no logo yet.', pic: avatar(p.tenant.name, p.tenant.logo_url, 'md', 'logo'), disabled: !p.tenant.logo_url },
    { v: 'initials', label: 'Just my initials', desc: 'No picture; a coloured circle with your initials.', pic: avatar(p.name, null, 'md') },
  ];
  $('#avatarOpts').innerHTML = opts.map((o) => `
    <label class="opt"><input type="radio" name="avatar_mode" value="${o.v}" ${o.v === p.avatar_mode ? 'checked' : ''} ${o.disabled ? 'disabled' : ''} />
      <span class="opt-body"><span class="name-cell">${o.pic}<b>${o.label}</b></span><span class="mini">${esc(o.desc)}</span></span></label>`).join('');
}

function paintPreview() {
  if (!me) return;
  const mode = currentAvatarMode();
  const url = mode === 'logo' ? me.tenant.logo_url : mode === 'photo' ? me.photo_url : null;
  const person = {
    id: 0, name: me.name, title: $('#fTitle').value.trim(), status: 'in', clocked_at: null,
    avatar_url: url, avatar_kind: url && mode === 'logo' ? 'logo' : url ? 'photo' : null,
    office: $('#vOffice').checked ? $('#fOffice').value.trim() : '',
    phone: $('#vPhone').checked ? $('#fPhone').value.trim() : '',
    email: $('#vEmail').checked ? $('#fEmail').value.trim() : '',
  };
  $('#preview').innerHTML = IO.renderPeople([person], 'cards', {});
}

function render(p) {
  const first = !me;
  me = p;
  if (p.must_change) return show('pw');
  $('#photoBox').innerHTML = avatar(p.name, p.photo_url, 'xl');
  $('#photoRemove').hidden = !p.photo_url;
  $('#pName').textContent = p.name;
  $('#pTenant').textContent = p.tenant_name;
  $('#pHandle').textContent = p.handle;
  paintAvatarOptions(p);
  $('#fTitle').value = p.title; $('#fOffice').value = p.office; $('#fPhone').value = p.phone; $('#fEmail').value = p.email; $('#fBio').value = p.bio;
  $('#vOffice').checked = p.show_office; $('#vPhone').checked = p.show_phone; $('#vEmail').checked = p.show_email;

  // company section for managers
  $('#companyForm').hidden = !p.is_manager;
  if (p.is_manager) {
    $('#logoBox').innerHTML = avatar(p.tenant.name, p.tenant.logo_url, 'xl', 'logo');
    $('#logoRemove').hidden = !p.tenant.logo_url;
    $('#cOffice').value = p.tenant.office; $('#cPhone').value = p.tenant.phone; $('#cEmail').value = p.tenant.email; $('#cWebsite').value = p.tenant.website;
  }
  paintPreview();
  loadShifts();
  if ($('#profile').hidden) show('profile');
}

async function loadShifts() {
  const { ok, data } = await call('/api/me/shifts');
  if (!ok) return;
  $('#shiftsBody').innerHTML = data.map((s) => `
    <tr><td>${fmt(s.clock_in)}</td><td>${s.open ? '<span class="badge in">still IN</span>' : fmt(s.clock_out)}</td><td>${dur(s.duration_ms)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="hint">No shifts in the last 30 days.</td></tr>';
}

['#profileForm'].forEach((f) => { $(f).addEventListener('input', paintPreview); $(f).addEventListener('change', paintPreview); });

// ---- sign in / password ----------------------------------------------------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/login', 'POST', { handle: $('#loginHandle').value, password: $('#loginPass').value });
  if (!r.ok) { $('#loginPass').value = ''; return showErr($('#loginError'), r.data.error || 'Sign in failed'); }
  showErr($('#loginError'), '');
  if (r.data.must_change) $('#pwCurrent').value = $('#loginPass').value;
  $('#loginPass').value = '';
  render(r.data);
});

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/password', 'POST', { current: $('#pwCurrent').value, next: $('#pwNext').value });
  if (!r.ok) return showErr($('#pwError'), r.data.error || 'Could not change password');
  $('#pwCurrent').value = ''; $('#pwNext').value = '';
  toast('Password saved');
  const again = await call('/api/me');
  if (again.ok) { me = null; render(again.data); }
});

$('#pwChangeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/password', 'POST', { current: $('#cpCurrent').value, next: $('#cpNext').value });
  if (r.ok) { toast('Password changed'); $('#cpCurrent').value = ''; $('#cpNext').value = ''; }
  else toast(r.data.error || 'Could not change password', true);
});

// ---- profile ---------------------------------------------------------------
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me', 'PUT', {
    title: $('#fTitle').value, office: $('#fOffice').value, phone: $('#fPhone').value, email: $('#fEmail').value, bio: $('#fBio').value,
    show_office: $('#vOffice').checked, show_phone: $('#vPhone').checked, show_email: $('#vEmail').checked, avatar_mode: currentAvatarMode(),
  });
  if (!r.ok) return showErr($('#profileError'), r.data.error || 'Could not save');
  showErr($('#profileError'), '');
  toast('Profile saved');
  render(r.data);
});

$('#photoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const r = await uploadImage('/api/me/photo', file, 'photo');
    toast('Photo updated');
    const again = await call('/api/me'); if (again.ok) render(again.data);
    void r;
  } catch (err) { toast(err.message, true); }
});

$('#photoRemove').addEventListener('click', async () => {
  const r = await call('/api/me/photo', 'DELETE');
  if (r.ok) { toast('Photo removed'); const again = await call('/api/me'); if (again.ok) render(again.data); } else toast('Could not remove photo', true);
});

// ---- company (managers) ----------------------------------------------------
$('#companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('/api/me/tenant', 'PUT', { office: $('#cOffice').value, phone: $('#cPhone').value, email: $('#cEmail').value, website: $('#cWebsite').value });
  if (!r.ok) return showErr($('#companyError'), r.data.error || 'Could not save');
  showErr($('#companyError'), ''); toast('Company profile saved'); render(r.data);
});
$('#logoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { await uploadImage('/api/me/tenant/logo', file, 'logo'); toast('Logo updated'); const again = await call('/api/me'); if (again.ok) render(again.data); }
  catch (err) { toast(err.message, true); }
});
$('#logoRemove').addEventListener('click', async () => {
  const r = await call('/api/me/tenant/logo', 'DELETE');
  if (r.ok) { toast('Logo removed'); const again = await call('/api/me'); if (again.ok) render(again.data); } else toast('Could not remove the logo', true);
});

$('#logoutBtn').addEventListener('click', async () => { await call('/api/me/logout', 'POST'); me = null; show('login'); });

(async () => {
  const r = await call('/api/me');
  if (r.ok) render(r.data); else show('login');
})();
