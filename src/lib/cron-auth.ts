/**
 * Shared cron-secret verification (audit nit, tier-15).
 *
 * The cron routes are IAM-gated by Cloud Run + additionally require an
 * `x-cron-secret` header that matches `CRON_SHARED_SECRET` (M9 fix #23).
 * Server.ts refuses to start in prod-like environments without the env
 * var bound, so by the time these routes run, `expected` is always set.
 *
 * Use timingSafeEqual rather than `===` so that a probing attacker can't
 * use response-time differences to recover prefix bytes of the secret.
 * In practice the secret is high-entropy + Cloud Run frontend variance
 * masks side-channels, but this is the textbook hardening.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

export function verifyCronSecret(c: Context): boolean {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    // No secret bound. Caller decides whether to allow (local dev path).
    return true;
  }
  const got = c.req.header('x-cron-secret') ?? '';
  // timingSafeEqual requires equal-length buffers — pad to the longer of
  // the two so we leak only "wrong length" vs "wrong content", not the
  // common-prefix length.
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
