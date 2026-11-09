'use strict';
// Helpers shared by the kiosk, the admin console and the /me profile page.
window.IO = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COLOR_CLASSES = 8; // .avatar.initials.c0 … c7 in style.css (no inline styles: the CSP forbids them)

  // Photo if there is one, otherwise a coloured circle with initials. size: 'sm' | 'md' | 'lg' | 'xl'
  function avatar(name, url, size = 'md') {
    if (url) return `<img class="avatar ${size}" src="${esc(url)}" alt="" loading="lazy" />`;
    const words = String(name || '?').trim().split(/\s+/);
    const initials = ((words[0] || '')[0] || '?') + (words.length > 1 ? (words[words.length - 1][0] || '') : '');
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar ${size} initials c${h % COLOR_CLASSES}" aria-hidden="true">${esc(initials.toUpperCase())}</span>`;
  }

  // Centre-crop to a square, shrink to 512px and re-encode as JPEG. Also strips EXIF/location data.
  function resizeImage(file, size = 512) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.type) && !file.type.startsWith('image/')) return reject(new Error('Please choose an image file'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = Math.min(size, side);
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be read. Try a JPEG or PNG.")); };
      img.src = url;
    });
  }

  async function uploadPhoto(endpoint, file) {
    const blob = await resizeImage(file);
    const res = await fetch(endpoint, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }

  return { esc, avatar, resizeImage, uploadPhoto };
})();
