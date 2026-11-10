"use strict";

const $ = (s) => document.querySelector(s);
const VALID = ['list', 'cards', 'tiles', 'board'];

let layout = 'list';
let mode = 'search';

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
  if (!q && mode !== 'browse') {
    box.innerHTML = '<p class="hint center">Start typing your name, then tap IN or OUT.</p>';
    return;
  }
  const mine = ++seq;
  let rows = [];
  try { rows = await (await fetch(`/api/kiosk/search?q=${encodeURIComponent(q)}`)).json(); } catch { /* offline */ }
  if (mine !== seq) return; // stale response
  if (!Array.isArray(rows) || !rows.length) {
    box.innerHTML = '<p class="hint center">No match. Check the spelling, or ask an admin.</p>';
    return;
  }
  box.innerHTML = IO.renderPeople(rows, layout, { action: true, group: mode === 'browse' && !q });
}

$('#kioskResults').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-dir]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const res = await fetch('/api/clock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: Number(btn.dataset.id), direction: btn.dataset.dir }),
  });
  if (res.ok) {
    toast(`${btn.dataset.name} is now ${btn.dataset.dir.toUpperCase()}`);
    $('#kioskSearch').value = '';
    $('#kioskSearch').focus();
  } else {
    toast((await res.json().catch(() => ({}))).error || 'Something went wrong', true);
  }
  search();
});

let t;
$('#kioskSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 150); });

(async function init() {
  try {
    const c = await (await fetch('/api/kiosk/config')).json();
    if (VALID.includes(c.layout)) layout = c.layout;
    if (c.mode === 'browse' || c.mode === 'search') mode = c.mode;
  } catch { /* use defaults */ }
  const override = new URLSearchParams(location.search).get('layout');
  if (VALID.includes(override)) layout = override; // handy for previewing, or per-tablet setups
  $('.kiosk').classList.toggle('wide', layout !== 'list');
  $('#kioskSearch').placeholder = mode === 'browse' ? 'Find your name… or tap yourself below' : 'Type your name…';
  search();
  // In browse mode keep everyone's status fresh while nobody is typing.
  setInterval(() => { if (mode === 'browse' && !$('#kioskSearch').value.trim()) search(); }, 30000);
})();
