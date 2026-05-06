// /c/:token/confirm-payment — Stripe.js 3DS confirm flow.
// Reads publishable key + client_secret + return URL from data-attributes
// on the #confirm button.
(function () {
  var btn = document.getElementById('confirm');
  if (!btn) return;
  // eslint-disable-next-line no-undef
  var stripe = Stripe(btn.dataset.publishableKey);
  var clientSecret = btn.dataset.clientSecret;
  var returnUrl = btn.dataset.returnUrl;
  var status = document.getElementById('status');
  btn.addEventListener('click', async function () {
    btn.disabled = true;
    status.textContent = 'Confirming…';
    var res = await stripe.confirmCardPayment(clientSecret);
    if (res.error) {
      status.textContent = res.error.message || 'Confirmation failed.';
      btn.disabled = false;
      return;
    }
    if (res.paymentIntent && res.paymentIntent.status === 'succeeded') {
      window.location.href = returnUrl;
      return;
    }
    status.textContent =
      'Confirmation pending. We will email you when it completes.';
  });
})();
