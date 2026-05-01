import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { stripeWebhookRoute } from './routes/api/webhooks-stripe.js';
import { adminClientsDetailRoute } from './routes/admin/clients-detail.js';
import { adminClientsNewRoute } from './routes/admin/clients-new.js';
import { adminPricingRoute } from './routes/admin/pricing.js';
import { publicCheckoutRoute } from './routes/public/checkout.js';
import { publicConsentsRoute } from './routes/public/consents.js';
import { log } from './lib/phi-redactor.js';

const app = new Hono();

// Cloud Run uses TCP probes by default, but a real health endpoint
// is useful for uptime monitors and the future load balancer.
// Note: Google Frontend reserves `/healthz` on *.run.app domains and
// intercepts it before the container. Use `/health` as the primary.
const health = (c: import('hono').Context) =>
  c.json({ ok: true, ts: new Date().toISOString() });
app.get('/health', health);
app.get('/healthz', health);

app.get('/', (c) =>
  c.text(`ITR Client HQ — ${process.env.K_REVISION ?? 'local'}\n`),
);

app.route('/admin/pricing', adminPricingRoute);
app.route('/admin/clients/new', adminClientsNewRoute);
app.route('/admin/clients', adminClientsDetailRoute);
app.route('/c', publicConsentsRoute);
app.route('/c', publicCheckoutRoute);
app.route('/api/webhooks/stripe', stripeWebhookRoute);

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

const port = Number(process.env.PORT) || 8080;

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info('server_listening', {
    port: info.port,
    revision: process.env.K_REVISION ?? 'local',
  });
});

// Cloud Run sends SIGTERM ~10s before shutting an instance down.
// Drain in-flight requests before exiting.
const shutdown = (signal: string) => {
  log.info('shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 9000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
