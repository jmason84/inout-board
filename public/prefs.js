'use strict';
// Applies the visitor's saved text size before first paint (loaded in <head> on every page).
(function () {
  var KEY = 'inout_text_size';
  function get() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function apply(v) { if (v) document.documentElement.setAttribute('data-size', v); else document.documentElement.removeAttribute('data-size'); }
  window.IOPrefs = {
    getSize: get,
    setSize: function (v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ } apply(v); },
  };
  apply(get());
})();
