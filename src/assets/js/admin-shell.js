// AdminShell client behaviour: theme toggle, sign out, row-link delegation.
// Loaded as /static/js/admin-shell.js (immutable cache); content-addressed
// through the file's existence in dist/static/js/.
(function () {
  var t = document.getElementById('theme-toggle');
  if (t) {
    t.addEventListener('click', function () {
      var dark = document.documentElement.classList.toggle('dark');
      var v = dark ? 'dark' : 'light';
      var oneYear = 60 * 60 * 24 * 365;
      document.cookie =
        'theme=' + v + '; path=/; max-age=' + oneYear + '; samesite=lax';
    });
  }
  var s = document.getElementById('sign-out');
  if (s) {
    s.addEventListener('click', async function (e) {
      e.preventDefault();
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch (_) {}
      window.location.href = '/admin/login';
    });
  }
  // Row-link delegation: <tr data-href="..."> becomes fully clickable.
  // Honors cmd/ctrl/middle-click. Ignores clicks on a/button/input.
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a, button, input, label, select, textarea')) return;
    var row = target.closest('tr[data-href]');
    if (!row) return;
    var href = row.getAttribute('data-href');
    if (!href) return;
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      window.open(href, '_blank');
    } else {
      window.location.assign(href);
    }
  });
  document.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    var target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a, button, input, label, select, textarea')) return;
    var row = target.closest('tr[data-href]');
    if (!row) return;
    var href = row.getAttribute('data-href');
    if (href) window.open(href, '_blank');
  });
})();
