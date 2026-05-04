import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { getDb } from './db/client.js';
import { stripeWebhookRoute } from './routes/api/webhooks-stripe.js';
import { cronStateTransitionsRoute } from './routes/api/cron-state-transitions.js';
import { cronRetryFailedChargesRoute } from './routes/api/cron-retry-failed-charges.js';
import { authSessionRoute } from './routes/api/auth-session.js';
import { adminCancelRoute } from './routes/admin/cancel.js';
import { adminClientsDetailRoute } from './routes/admin/clients-detail.js';
import { adminClientsNewRoute } from './routes/admin/clients-new.js';
import { adminCompleteRoute } from './routes/admin/complete.js';
import { adminConfirmDatesRoute } from './routes/admin/confirm-dates.js';
import { adminDashboardRoute } from './routes/admin/dashboard.js';
import { adminPricingRoute } from './routes/admin/pricing.js';
import { adminRefundRoute } from './routes/admin/refund.js';
import { adminLoginRoute } from './routes/auth/login.js';
import { requireAuth } from './lib/auth.js';
import { publicCheckoutRoute } from './routes/public/checkout.js';
import { publicConsentsRoute } from './routes/public/consents.js';
import { publicPaymentRoute } from './routes/public/payment.js';
import { log } from './lib/phi-redactor.js';
import { parseTraceId, runWithTrace } from './lib/trace-context.js';

const app = new Hono();

// Trace correlation (audit nit): Cloud Run injects X-Cloud-Trace-Context
// on every inbound request. Parse the trace id once at the edge and run
// the rest of the request inside an AsyncLocalStorage scope so any log
// line emitted (Hono handler, lib/state-machine.ts, lib/stripe.ts, etc.)
// can attach the magic `logging.googleapis.com/trace` field without
// threading a context object through every call site. See
// lib/trace-context.ts and lib/phi-redactor.ts emit().
app.use('*', async (c, next) => {
  const traceId = parseTraceId(c.req.header('x-cloud-trace-context'));
  await runWithTrace(traceId, () => next());
});

// Standard hardening headers on every response (M9 fix #42 + #43).
// CSP is intentionally permissive for our two specific external scripts
// (Firebase JS SDK on /admin/login, Stripe.js on /c/:token/confirm-payment);
// no other inline-script tag should be loading from elsewhere.
app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  // CSP only on HTML responses — JSON/redirects don't need it and adding
  // it everywhere can break unexpected client tooling.
  const ct = c.res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://js.stripe.com",
        "connect-src 'self' https://*.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://api.stripe.com",
        "frame-src https://js.stripe.com https://*.stripe.com https://*.firebaseapp.com https://accounts.google.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
  }
});

// Cloud Run uses TCP probes by default, but a real health endpoint
// is useful for uptime monitors and the future load balancer.
// Note: Google Frontend reserves `/healthz` on *.run.app domains and
// intercepts it before the container. Use `/health` as the primary.
//
// /health: always 200, no DB touch — survives transient DB blips.
// /ready: pings the DB; uptime monitors that gate traffic should use this
//   so a DB-broken instance doesn't get marked healthy (M9 fix #22).
const health = (c: import('hono').Context) =>
  c.json({ ok: true, ts: new Date().toISOString() });
app.get('/health', health);
app.get('/healthz', health);
app.get('/ready', async (c) => {
  try {
    const { pool } = await getDb();
    await pool.query('SELECT 1');
    return c.json({ ok: true, db: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    log.error('ready_db_check_failed', { error: (err as Error).message });
    return c.json({ ok: false, db: 'error' }, 503);
  }
});

app.get('/', (c) =>
  c.text(`ITR Client HQ — ${process.env.K_REVISION ?? 'local'}\n`),
);

// WEBHOOK_ONLY=1 deploys this image as the public webhook-only Cloud Run
// service (`itr-stripe-webhook`). It registers ONLY /health + the Stripe
// webhook route; every other path 404s. Lets us split the public webhook
// surface from the IAM-gated main app without running two codebases.
const webhookOnly = process.env.WEBHOOK_ONLY === '1';

app.route('/api/webhooks/stripe', stripeWebhookRoute);

if (!webhookOnly) {
  // Auth wiring (DESIGN.md §12 M8). Login page + session API are
  // unauthenticated by definition; everything else under /admin requires
  // a valid session cookie when AUTH_ENABLED=1, else falls through to a
  // synthetic admin user (dev / pre-rollout no-op).
  // Defense-in-depth body cap on every authenticated POST surface. Forms
  // here are short — the largest is admin/clients-new with ~12 capped
  // text fields (~5 KB worst-case). 64 KB is generous and prevents
  // memory-exhaustion DoS from an authenticated bad actor or a
  // misconfigured client. Public consents / Stripe webhook bring their
  // own bodyLimit (1 MB / 256 KB respectively) since they accept larger
  // payloads.
  const adminBodyLimit = bodyLimit({
    maxSize: 65_536,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  app.use('/admin/*', adminBodyLimit);
  app.use('/api/auth/*', adminBodyLimit);

  app.route('/admin', adminLoginRoute);
  app.route('/api/auth', authSessionRoute);
  app.use('/admin/*', requireAuth);

  app.route('/admin/pricing', adminPricingRoute);
  app.route('/admin/clients/new', adminClientsNewRoute);
  // Confirm-dates + complete + refund routes (`/admin/clients/:id/<action>`)
  // must mount BEFORE the catch-all detail route or the `/:id` matcher
  // swallows them.
  app.route('/admin/clients', adminConfirmDatesRoute);
  app.route('/admin/clients', adminCompleteRoute);
  app.route('/admin/clients', adminRefundRoute);
  app.route('/admin/clients', adminCancelRoute);
  app.route('/admin/clients', adminClientsDetailRoute);
  // Dashboard mounted last so it doesn't shadow the more specific
  // /admin/* routes above.
  app.route('/admin', adminDashboardRoute);
  app.route('/c', publicConsentsRoute);
  app.route('/c', publicCheckoutRoute);
  app.route('/c', publicPaymentRoute);
  app.route('/api/cron', cronStateTransitionsRoute);
  app.route('/api/cron', cronRetryFailedChargesRoute);
}

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Last-resort error handler. All log fields go through the PHI redactor.
app.onError((err, c) => {
  log.error('unhandled_error', {
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    revision: process.env.K_REVISION ?? 'local',
  });
  return c.json({ error: 'internal_error' }, 500);
});

// Defense-in-depth (M9 fix #23): the cron routes are IAM-gated by
// Cloud Run, but a configuration drift would silently expose them;
// require the shared secret as a belt to the IAM suspenders. Skipped
// for the webhook-only service since it doesn't host cron routes.
// Skipped when LOCAL_DB_URL is set (local dev w/ proxy).
if (
  !webhookOnly &&
  !process.env.LOCAL_DB_URL &&
  !process.env.CRON_SHARED_SECRET
) {
  log.error('startup_aborted_missing_cron_shared_secret', {});
  process.exit(1);
}

const port = Number(process.env.PORT) || 8080;

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info('server_listening', {
    port: info.port,
    revision: process.env.K_REVISION ?? 'local',
    webhookOnly,
  });
});

// Cloud Run sends SIGTERM ~10s before shutting an instance down. Drain
// in-flight requests, then close the DB pool so in-flight queries flush
// rather than getting abandoned (M9 fix #48).
const shutdown = (signal: string) => {
  log.info('shutdown', { signal });
  server.close(async () => {
    try {
      const { pool } = await getDb();
      await pool.end();
    } catch (err) {
      log.error('shutdown_pool_drain_failed', {
        error: (err as Error).message,
      });
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 9000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
