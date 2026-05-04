/**
 * /admin/login — Firebase JS SDK Google sign-in (M8).
 *
 * Browser flow:
 *   1. Page loads Firebase compat SDK from gstatic CDN.
 *   2. Click "Sign in with Google" → signInWithPopup with `hd` hint.
 *   3. user.getIdToken() → POST to /api/auth/session.
 *   4. Server verifies + sets HttpOnly session cookie.
 *   5. JS redirects to ?returnTo= or /admin.
 *
 * Server-side: pure HTML render. No auth required.
 */

import { Hono } from 'hono';

export const adminLoginRoute = new Hono();

adminLoginRoute.get('/login', (c) => {
  const returnTo = c.req.query('returnTo') ?? '/admin';
  const error = c.req.query('error');
  const apiKey = process.env.FIREBASE_API_KEY ?? '';
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN ?? '';
  const projectId = process.env.FIREBASE_PROJECT_ID ?? '';
  const authEnabled = process.env.AUTH_ENABLED === '1';

  if (!authEnabled) {
    return c.html(`<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Login (disabled) — ITR Client HQ</title>
  <style>body { font: 14px system-ui; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }</style>
</head>
<body>
  <h1>Login disabled</h1>
  <p>AUTH_ENABLED is not set on this Cloud Run service. Admin pages currently rely on Cloud Run IAM auth and a synthetic admin context. Set <code>AUTH_ENABLED=1</code> + bind <code>FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID</code> to enable Identity Platform sign-in.</p>
  <p><a href="${escAttr(returnTo)}">Continue to ${escHtml(returnTo)}</a></p>
</body>
</html>`);
  }

  if (!apiKey || !authDomain || !projectId) {
    return c.html(`<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Login — config pending</title>
  <style>body { font: 14px system-ui; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }</style>
</head>
<body>
  <h1>Setup pending</h1>
  <p>Firebase web config is incomplete on this revision. Bind <code>FIREBASE_API_KEY</code>, <code>FIREBASE_AUTH_DOMAIN</code>, and <code>FIREBASE_PROJECT_ID</code> via the deploy workflow.</p>
</body>
</html>`);
  }

  const errBlock = error
    ? `<p style="color:#a00"><strong>Error:</strong> ${escHtml(decodeURIComponent(error))}</p>`
    : '';

  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sign in — ITR Client HQ</title>
  <style>
    body { font: 16px system-ui, sans-serif; max-width: 480px; margin: 6rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-weight: 600; }
    button { padding: 0.7rem 1.4rem; cursor: pointer; font: inherit; background: #1c4f7c; color: white; border: 0; border-radius: 4px; }
    .err { color: #a00; margin-top: 1rem; }
    .meta { color: #666; font-size: 13px; margin-top: 2rem; }
  </style>
  <script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js"></script>
</head>
<body>
  <h1>ITR Client HQ</h1>
  <p>Sign in with your <strong>@intensivetherapyretreat.com</strong> Google account.</p>
  <button id="signin">Sign in with Google</button>
  <p id="status" class="err"></p>
  ${errBlock}
  <p class="meta">Sessions last 5 days. After that you'll be asked to sign in again.</p>
  <script>
    const config = {
      apiKey: ${JSON.stringify(apiKey)},
      authDomain: ${JSON.stringify(authDomain)},
      projectId: ${JSON.stringify(projectId)},
    };
    firebase.initializeApp(config);
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ hd: 'intensivetherapyretreat.com' });
    const returnTo = ${JSON.stringify(returnTo)};
    const status = document.getElementById('status');
    document.getElementById('signin').addEventListener('click', async () => {
      status.textContent = 'Signing in…';
      try {
        const result = await firebase.auth().signInWithPopup(provider);
        const idToken = await result.user.getIdToken();
        const res = await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          status.textContent = 'Sign-in failed: ' + (data.error ?? res.status);
          await firebase.auth().signOut().catch(() => {});
          return;
        }
        await firebase.auth().signOut().catch(() => {});
        window.location.href = returnTo;
      } catch (err) {
        status.textContent = err && err.message ? err.message : 'Sign-in failed.';
      }
    });
  </script>
</body>
</html>`);
});

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
