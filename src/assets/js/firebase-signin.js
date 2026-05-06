// /admin/login client behaviour: Firebase compat sign-in → POST /api/auth/session.
// Reads config from data-attributes on the #signin button (M9 fix #6 — avoid
// </script> injection in template literals).
(function () {
  var btn = document.getElementById('signin');
  if (!btn) return;
  // eslint-disable-next-line no-undef
  firebase.initializeApp({
    apiKey: btn.dataset.apiKey,
    authDomain: btn.dataset.authDomain,
    projectId: btn.dataset.projectId,
  });
  // eslint-disable-next-line no-undef
  var provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ hd: 'intensivetherapyretreat.com' });
  var returnTo = btn.dataset.returnTo;
  var status = document.getElementById('status');
  btn.addEventListener('click', async function () {
    status.textContent = 'Signing in…';
    try {
      // eslint-disable-next-line no-undef
      var result = await firebase.auth().signInWithPopup(provider);
      var idToken = await result.user.getIdToken();
      var res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        var data = await res.json().catch(function () {
          return {};
        });
        status.textContent = 'Sign-in failed: ' + (data.error || res.status);
        // eslint-disable-next-line no-undef
        await firebase
          .auth()
          .signOut()
          .catch(function () {});
        return;
      }
      // eslint-disable-next-line no-undef
      await firebase
        .auth()
        .signOut()
        .catch(function () {});
      window.location.href = returnTo;
    } catch (err) {
      status.textContent = err && err.message ? err.message : 'Sign-in failed.';
    }
  });
})();
