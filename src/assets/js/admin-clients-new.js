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

  function bindSubmitGuard() {
    var form = document.querySelector('form[method="post"]');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      if (form.dataset.submitting === '1') {
        event.preventDefault();
        return;
      }
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;
      form.dataset.submitting = '1';

      var submit = form.querySelector('button[type="submit"]');
      if (!submit) return;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      submit.textContent = 'Creating';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('pricing_basis');
    if (sel) sel.addEventListener('change', sync);
    sync();
    bindSubmitGuard();
  });
})();
