/**
 * Client-token generation for the public retreat surface (`/c/[token]/*`).
 *
 * 24 random bytes → base64url → 32 chars. ~192 bits of entropy; an attacker
 * with a 1B-attempt budget has a ~10^-49 chance of hitting a live token.
 *
 * Uniqueness is enforced at the DB layer (`retreats_client_token_idx`), so
 * the insert path retries on the (statistically impossible) collision.
 */

import { randomBytes } from 'node:crypto';

export function generateClientToken(): string {
  return randomBytes(24).toString('base64url');
}
