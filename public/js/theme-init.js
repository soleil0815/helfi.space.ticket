// Colour theme before the first paint (no white flash in dark mode): 'system' | 'light' | 'dark',
// remembered on this device; the account setting is synced by /js/theme.js after signing in.
// Classic script (not a module) so it runs before the style sheets are applied.
(function () {
  var KEY = 'helfi.theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function pref() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
  }
  function apply() {
    var p = pref();
    var dark = p === 'dark' || (p === 'system' && !!mq && mq.matches);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1D2125' : '#ffffff');
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.helfiApplyTheme = apply;
}());
