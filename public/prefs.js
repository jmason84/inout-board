'use strict';
// Applies the visitor's saved text size and theme before first paint (loaded in <head> on every page).
(function () {
  var SIZE_KEY = 'inout_text_size';
  var THEME_KEY = 'inout_theme';

  function getItem(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function setItem(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  function validTheme(v) { return v === 'light' || v === 'dark' || v === 'system'; }
  var savedTheme = getItem(THEME_KEY);
  var chosenTheme = validTheme(savedTheme) ? savedTheme : null;
  var defaultTheme = 'system';

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
    getTheme: function () { return chosenTheme || defaultTheme; },
    setTheme: function (v) {
      if (!validTheme(v)) return;
      chosenTheme = v;
      setItem(THEME_KEY, v);
      applyTheme(v);
    },
    applyDefaultTheme: function (v) {
      if (!validTheme(v)) return;
      defaultTheme = v;
      applyTheme(chosenTheme || defaultTheme);
    },
  };

  applySize(getItem(SIZE_KEY));
  applyTheme(chosenTheme || defaultTheme);
})();
