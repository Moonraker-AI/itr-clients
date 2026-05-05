/**
 * In-memory per-key rate limiter (M10 P1 #8).
 *
 * NOT distributed: state is per-Cloud-Run-instance. Cloud Run autoscales
 * horizontally so a determined attacker spread across instances can exceed
 * the configured cap. Acceptable as defense-in-depth for surfaces gated
 * by a high-entropy token (the public /c/:token/* family) — the bucket
 * cap protects against bursty bots and a misconfigured retry loop, not
 * against a coordinated cracker. Step up to Cloud Memorystore (Redis) if
 * we ever need a global counter.
 *
 * Memory cap: every limiter instance owns its own Map. We hard-cap each
 * Map at 5_000 keys; once exceeded, the oldest half is dropped. A 5 KB
 * footprint per limiter is fine even with many limiters in flight.
 *
 * The bucket array stores millisecond timestamps. Per request, we filter
 * out timestamps older than `windowMs`, push the new one, and check size
 * vs `max`. Filter+push is O(bucket size); bucket size is bounded by `max`
 * per IP per window so this stays cheap.
 */

import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitConfig {
  /** Sliding window length in ms. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /** Extracts the bucket key (typically client IP) from the request context. */
  bucketKey: (c: Context) => string;
  /** Hard cap on stored keys per limiter instance. Defaults to 5_000. */
  maxKeys?: number;
}

export interface RateLimiter {
  /** Returns true if the key has exceeded the cap inside the current window. */
  isLimited(key: string): boolean;
  /** Hono middleware that 429s when limited. */
  middleware(opts?: { onBlock?: (c: Context) => void }): MiddlewareHandler;
  /** Test hook: drop all stored buckets. */
  reset(): void;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const { windowMs, max, bucketKey } = config;
  const maxKeys = config.maxKeys ?? 5_000;
  const hits = new Map<string, number[]>();

  function isLimited(key: string): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = (hits.get(key) ?? []).filter((t) => t > cutoff);
    bucket.push(now);
    hits.set(key, bucket);
    if (hits.size > maxKeys) {
      // Drop the oldest half by insertion order. Map preserves insertion
      // order so the first N keys are the oldest ones we observed.
      const toDrop = Math.floor(maxKeys / 2);
      let i = 0;
      for (const k of hits.keys()) {
        if (i++ >= toDrop) break;
        hits.delete(k);
      }
    }
    return bucket.length > max;
  }

  return {
    isLimited,
    middleware(opts) {
      return async (c, next) => {
        const key = bucketKey(c);
        if (isLimited(key)) {
          opts?.onBlock?.(c);
          return c.json({ error: 'too_many_requests' }, 429);
        }
        await next();
      };
    },
    reset() {
      hits.clear();
    },
  };
}

/**
 * Best-effort client IP for rate-limit bucketing. Mirrors the comment in
 * routes/api/auth-session.ts: leftmost X-Forwarded-For is client-supplied
 * and spoofable, but acceptable as defense-in-depth on top of token entropy.
 *
 * Revisit if a Cloud LB is added in front of Cloud Run (then prefer the
 * rightmost-trusted hop or Hono's getConnInfo adapter).
 */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for') ?? '';
  return xff.split(',')[0]?.trim() || 'unknown';
}
