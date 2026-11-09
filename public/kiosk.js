'use strict';

const $ = (s) => document.querySelector(s);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 3500);
}

setInterval(() => {
  $('#kioskClock').textContent = new Date().toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}, 1000);

let seq = 0;
async function search() {
  const q = $('#kioskSearch').value.trim();
  const box = $('#kioskResults');
  if (!q) { box.innerHTML = '<p class="hint center">Start typing your name, then tap IN or OUT.</p>'; return; }
  const mine = ++seq;
  let rows = [];
  try { rows = await (await fetch(`/api/kiosk/search?q=${encodeURIComponent(q)}`)).json(); } catch { /* offline */ }
  if (mine !== seq) return; // stale response
  if (!rows.length) { box.innerHTML = '<p class="hint center">No match. Check the spelling, or ask an admin.</p>'; return; }
  box.innerHTML = rows.map((p) => {
    const next = p.status === 'in' ? 'out' : 'in';
    return `
    <div class="person-card ${p.status}">
      ${window.IO.avatar(p.name, p.photo_url, 'lg')}
      <div class="person-info">
        <div class="person-name">${escapeHtml(p.name)}</div>
        <div class="person-meta">${escapeHtml(p.title ? p.title + ' · ' : '')}${escapeHtml(p.tenant_name)}${p.clocked_at ? ` · ${p.status === 'in' ? 'IN' : 'OUT'} since ${fmtTime(p.clocked_at)}` : ''}</div>
      </div>
      <button class="btn big ${next}" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-dir="${next}">${next.toUpperCase()}</button>
    </div>`;
  }).join('');
  box.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    const res = await fetch('/api/clock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_id: Number(btn.dataset.id), direction: btn.dataset.dir }),
    });
    if (res.ok) {
      toast(`${btn.dataset.name} is now ${btn.dataset.dir.toUpperCase()}`);
      $('#kioskSearch').value = ''; search(); $('#kioskSearch').focus();
    } else {
      toast((await res.json().catch(() => ({}))).error || 'Something went wrong', true);
      search();
    }
  }));
}

let t;
$('#kioskSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 150); });
search();
