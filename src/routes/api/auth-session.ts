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

// In-memory IP rate limiter (M9 fix #25). Cloud Run scales horizontally
// so this is per-instance, not global — a determined attacker on many
// IPs still hits Identity Platform, but a casual bot is bounded. The
// bigger goal: keep one bad actor from chewing through Google's quota
// on the project. 10 verifyIdToken attempts per IP per minute.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const ipHits = new Map<string, number[]>();
function rateLimitedIp(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const bucket = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  bucket.push(now);
  ipHits.set(ip, bucket);
  if (ipHits.size > 5_000) {
    // Cap memory: drop the oldest half when the map grows huge.
    const sorted = [...ipHits.entries()];
    for (let i = 0; i < sorted.length / 2; i++) {
      const entry = sorted[i];
      if (entry) ipHits.delete(entry[0]);
    }
  }
  return bucket.length > RATE_MAX;
}
function clientIp(c: import('hono').Context): string {
  const xff = c.req.header('x-forwarded-for') ?? '';
  return xff.split(',')[0]?.trim() || 'unknown';
}

authSessionRoute.post('/session', async (c) => {
  if (rateLimitedIp(clientIp(c))) {
    log.warn('auth_session_rate_limited', {});
    return c.json({ error: 'too_many_requests' }, 429);
  }
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
