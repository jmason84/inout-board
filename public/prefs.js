'use strict';
// Applies the visitor's saved text size and theme before first paint (loaded in <head> on every page).
(function () {
  var SIZE_KEY = 'inout_text_size';
  var THEME_KEY = 'inout_theme';

  function getItem(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function setItem(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }

  // --- Text size ---
  function applySize(v) { if (v) document.documentElement.setAttribute('data-size', v); else document.documentElement.removeAttribute('data-size'); }

  // --- Theme ---
  // 'light' or 'dark' → force via data-theme attribute, overriding prefers-color-scheme.
  // 'system' or '' → remove data-theme so the CSS media query takes over.
  function applyTheme(v) {
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
  }

  window.IOPrefs = {
    getSize: function () { return getItem(SIZE_KEY); },
    setSize: function (v) { setItem(SIZE_KEY, v); applySize(v); },
    getTheme: function () { return getItem(THEME_KEY) || 'system'; },
    setTheme: function (v) { setItem(THEME_KEY, v === 'system' ? '' : v); applyTheme(v); },
  };

  applySize(getItem(SIZE_KEY));
  applyTheme(getItem(THEME_KEY));
})();
