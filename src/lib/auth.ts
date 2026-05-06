/**
 * Auth middleware (DESIGN.md §12 M8).
 *
 * Identity Platform / Firebase Auth, Workspace-domain-restricted.
 * Workflow:
 *   1. Browser hits a protected page → middleware → no `session` cookie
 *      → redirect to /admin/login.
 *   2. /admin/login renders the Firebase JS SDK → user signs in with Google.
 *   3. Browser POSTs the resulting Firebase ID token to /api/auth/session.
 *   4. Server verifies the ID token + email domain + therapists allow-list,
 *      mints a 5-day session cookie via firebase-admin, sets it HttpOnly.
 *   5. Subsequent requests carry the session cookie; this middleware
 *      verifies it and resolves a `therapists` row by email.
 *
 * Env:
 *   AUTH_ENABLED=1          flip from no-op to enforcing
 *   FIREBASE_PROJECT_ID     identity platform project id
 *
 * `firebase-admin` uses Application Default Credentials; on Cloud Run
 * that resolves to the runtime SA, which has implicit Identity Platform
 * read access in the project that owns it.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import admin from 'firebase-admin';

import { getDb } from '../db/client.js';
import { therapists } from '../db/schema.js';
import { log } from './phi-redactor.js';

const ALLOWED_DOMAIN = 'intensivetherapyretreat.com';
// __Host- prefix (M9 fix #8): browser refuses to set/return the cookie
// unless `Secure`, `Path=/`, and the Domain attribute is omitted. Prevents
// a sibling subdomain from shadowing the cookie.
const SESSION_COOKIE = '__Host-session';
const SESSION_TTL_DAYS = 5;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

let adminApp: admin.app.App | null = null;

function ensureAdminApp(): admin.app.App {
  if (adminApp) return adminApp;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  adminApp = admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });
  return adminApp;
}

export interface AuthUser {
  therapistId: string;
  email: string;
  fullName: string;
  role: 'admin' | 'therapist';
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === '1';
}

/**
 * Middleware factory: returns a Hono middleware that requires a valid
 * session cookie + email in the therapists allow-list. When AUTH_ENABLED
 * is unset, falls through to a synthetic admin user keyed on the first
 * therapist with role='admin' so dev work pre-rollout still functions.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  // Login page must be reachable without auth.
  if (c.req.path === '/admin/login') return next();

  if (!authEnabled()) {
    // Dev / pre-rollout no-op. Resolve an admin user so therapist-scoped
    // queries downstream still see "everything". Pick the first active
    // admin therapist; if none exists, just skip setting `user`.
    const { db } = await getDb();
    const [adminTherapist] = await db
      .select()
      .from(therapists)
      .where(eq(therapists.role, 'admin'));
    if (adminTherapist) {
      c.set('user', {
        therapistId: adminTherapist.id,
        email: adminTherapist.email,
        fullName: adminTherapist.fullName,
        role: 'admin',
      });
    }
    return next();
  }

  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return c.redirect(loginUrl(c.req.path));

  let decoded;
  try {
    decoded = await ensureAdminApp().auth().verifySessionCookie(cookie, true);
  } catch {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect(loginUrl(c.req.path));
  }

  const email = decoded.email?.toLowerCase();
  if (!email || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    log.warn('auth_domain_rejected', { email });
    return c.text('Forbidden: not a Workspace user.', 403);
  }

  const { db } = await getDb();
  const [t] = await db
    .select()
    .from(therapists)
    .where(eq(therapists.email, email));
  if (!t || !t.active) {
    log.warn('auth_therapist_not_in_roster', { email });
    return c.text(
      'Forbidden: your account is not on the therapist roster. Contact support@intensivetherapyretreat.com.',
      403,
    );
  }

  c.set('user', {
    therapistId: t.id,
    email,
    fullName: t.fullName,
    role: t.role as 'admin' | 'therapist',
  });
  return next();
};

function loginUrl(returnTo: string): string {
  const params = new URLSearchParams();
  if (returnTo && returnTo !== '/admin/login') params.set('returnTo', returnTo);
  const qs = params.toString();
  return `/admin/login${qs ? `?${qs}` : ''}`;
}

/**
 * Exchange an ID token for a session cookie. Caller is responsible for
 * domain + therapists-roster checks before calling this; we re-verify
 * the email domain here as defense-in-depth.
 */
export async function createSessionCookieFromIdToken(
  idToken: string,
): Promise<{ cookie: string; maxAge: number; email: string } | { error: string }> {
  if (!authEnabled()) return { error: 'auth_disabled' };
  let decoded;
  try {
    decoded = await ensureAdminApp().auth().verifyIdToken(idToken, true);
  } catch (err) {
    log.warn('auth_id_token_invalid', { error: (err as Error).message });
    return { error: 'invalid_id_token' };
  }
  const email = decoded.email?.toLowerCase() ?? '';
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) return { error: 'wrong_domain' };

  const { db } = await getDb();
  const [t] = await db.select().from(therapists).where(eq(therapists.email, email));
  if (!t || !t.active) return { error: 'not_in_roster' };

  const expiresIn = SESSION_TTL_MS;
  const cookie = await ensureAdminApp()
    .auth()
    .createSessionCookie(idToken, { expiresIn });
  return { cookie, maxAge: Math.floor(expiresIn / 1000), email };
}

export const COOKIE_NAME = SESSION_COOKIE;
export { setCookie as setSessionCookie, deleteCookie as deleteSessionCookie };

/**
 * True iff the user is allowed to view/mutate a retreat owned by
 * `retreatTherapistId`. Admins (and the dev no-op synthetic admin user)
 * always pass; therapists must own the retreat.
 */
export function therapistCanAccess(
  user: AuthUser | undefined,
  retreatTherapistId: string,
): boolean {
  if (!user) return true; // pre-rollout dev no-op (auth disabled)
  if (user.role === 'admin') return true;
  const allowed = user.therapistId === retreatTherapistId;
  if (!allowed) {
    // HIPAA forensics: surface cross-tenant attempts. Callers respond
    // with c.notFound() (not 403) to avoid acting as a probing oracle,
    // but we still want a record of who tried what.
    log.warn('therapist_access_denied', {
      attempterTherapistId: user.therapistId,
      attempterEmail: user.email ?? null,
      retreatTherapistId,
    });
  }
  return allowed;
}
