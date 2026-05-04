/**
 * /api/auth/session — exchange Firebase ID token for HttpOnly session
 * cookie. /api/auth/logout — clear the cookie.
 *
 * Both endpoints are pre-auth (the user does not have a session yet at
 * sign-in time, and logout should work even if the cookie is stale).
 */

import { Hono } from 'hono';

import {
  COOKIE_NAME,
  createSessionCookieFromIdToken,
  deleteSessionCookie,
  setSessionCookie,
} from '../../lib/auth.js';
import { log } from '../../lib/phi-redactor.js';

export const authSessionRoute = new Hono();

authSessionRoute.post('/session', async (c) => {
  let body: { idToken?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const idToken = typeof body.idToken === 'string' ? body.idToken : '';
  if (!idToken) return c.json({ error: 'missing_id_token' }, 400);

  const result = await createSessionCookieFromIdToken(idToken);
  if ('error' in result) {
    return c.json({ error: result.error }, 401);
  }

  setSessionCookie(c, COOKIE_NAME, result.cookie, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: result.maxAge,
  });

  log.info('auth_session_created', { email: result.email });
  return c.json({ ok: true });
});

authSessionRoute.post('/logout', async (c) => {
  deleteSessionCookie(c, COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});
