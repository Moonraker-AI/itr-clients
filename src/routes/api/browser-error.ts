/**
 * POST /api/browser-error — vanilla browser error sink (v0.28.0).
 *
 * Receives uncaught errors + unhandled rejections from the small JS
 * bundle in src/assets/js-bundles/browser-error-entry.js. Logs each as
 * a Cloud Error Reporting `ReportedErrorEvent` with
 * `serviceContext.service = 'itr-client-hq-browser'` so server vs.
 * browser issues group into separate streams in the Error Reporting UI.
 *
 * HIPAA: every payload field runs through `redact()` before logging.
 * The browser-side scrubber strips client-token segments from URLs and
 * never sends form/query data, but the server-side redactor is the
 * authoritative gate.
 *
 * Hardening:
 *   - bodyLimit 8 KB (errors are tiny; cap rejects malicious flooding)
 *   - rate limit 10/min/IP (bots can't pump our log volume)
 *   - public + unauthenticated (errors fire before any session exists)
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { captureError } from '../../lib/error-reporter.js';
import { redact } from '../../lib/phi-redactor.js';
import { clientIp, createRateLimiter } from '../../lib/rate-limit.js';

export const browserErrorRoute = new Hono();

const limiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  bucketKey: (c) => clientIp(c),
});

interface BrowserErrorPayload {
  msg?: unknown;
  stack?: unknown;
  url?: unknown;
  userAgent?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
}

browserErrorRoute.post(
  '/',
  bodyLimit({
    maxSize: 8_192,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
  limiter.middleware(),
  async (c) => {
    let raw: BrowserErrorPayload;
    try {
      raw = (await c.req.json()) as BrowserErrorPayload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const msg = typeof raw.msg === 'string' ? raw.msg.slice(0, 500) : 'unknown';
    const stack =
      typeof raw.stack === 'string' ? raw.stack.slice(0, 4_000) : undefined;
    const url = typeof raw.url === 'string' ? raw.url.slice(0, 500) : undefined;
    const userAgent =
      typeof raw.userAgent === 'string'
        ? raw.userAgent.slice(0, 500)
        : undefined;
    const lineNumber =
      typeof raw.lineNumber === 'number' ? raw.lineNumber : undefined;
    const columnNumber =
      typeof raw.columnNumber === 'number' ? raw.columnNumber : undefined;

    // Reconstruct a synthetic Error so captureError emits a real stack.
    // Cloud Error Reporting's grouping signature uses the top stack frame,
    // so preserving the browser-supplied stack matters more than getting
    // the type right.
    const err = new Error(msg);
    if (stack) err.stack = stack;
    err.name = 'BrowserError';

    const ctx = redact({
      url,
      userAgent,
      lineNumber,
      columnNumber,
    }) as Record<string, unknown>;

    captureError(err, ctx, { service: 'itr-client-hq-browser' });

    return c.json({ ok: true });
  },
);
