// v0.28.18 - toggle visibility of Custom-only pricing fields on
// /admin/clients/new based on the Basis select. CSP-clean (external
// file, hashed by the same /static/js/*?v=<rev> pattern as everything
// else). No deps.

(function () {
  'use strict';
  function sync() {
    var sel = document.getElementById('pricing_basis');
    var box = document.getElementById('pricing-custom-fields');
    if (!sel || !box) return;
    box.hidden = sel.value !== 'custom';
  }
  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('pricing_basis');
    if (sel) sel.addEventListener('change', sync);
    sync();
  });
})();
