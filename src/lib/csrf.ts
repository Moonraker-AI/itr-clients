/**
 * CSRF protection for admin form POSTs (M9 fix #7).
 *
 * Pattern: double-submit cookie + hidden form input.
 *   - GET handler calls `ensureCsrfToken(c)`: returns the existing
 *     `csrf` cookie value, or sets a new random one and returns it.
 *   - The form template embeds the token as a hidden input.
 *   - POST handler calls `verifyCsrfToken(c, formValue)`: requires the
 *     cookie value to equal the form value, both non-empty.
 *
 * Why this works alongside `SameSite=Lax` cookies on the session:
 *   - Lax allows top-level POSTs from external sites in some browser
 *     versions, which would still attach the session cookie.
 *   - The CSRF cookie is fetched only on same-origin requests because
 *     a cross-origin POST cannot read the form HTML to copy its token.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';

const COOKIE = 'csrf';
const TTL_SECONDS = 60 * 60 * 24; // 1 day

export function ensureCsrfToken(c: Context): string {
  const existing = getCookie(c, COOKIE);
  if (existing && existing.length >= 16) return existing;
  const token = randomUUID();
  setCookie(c, COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: TTL_SECONDS,
  });
  return token;
}

/** True iff the form value matches the cookie. Both must be non-empty. */
export function verifyCsrfToken(c: Context, formValue: string | null | undefined): boolean {
  const cookie = getCookie(c, COOKIE) ?? '';
  if (!cookie || !formValue) return false;
  // Constant-time compare via crypto.timingSafeEqual over equal-length
  // buffers. The hand-rolled XOR loop the previous revision used was
  // also constant-time but harder to audit at a glance; swap for the
  // canonical primitive for consistency with lib/cron-auth.ts (M9 t-15).
  const a = Buffer.from(cookie);
  const b = Buffer.from(formValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Hidden-input HTML for embedding in a form. */
export function csrfInputHtml(token: string): string {
  return `<input type="hidden" name="_csrf" value="${escAttr(token)}">`;
}

function escAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
