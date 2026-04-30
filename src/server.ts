import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

// Cloud Run uses TCP probes by default, but a real /healthz is useful
// for uptime monitors and the future load balancer.
app.get('/healthz', (c) =>
  c.json({ ok: true, ts: new Date().toISOString() }),
);

app.get('/', (c) =>
  c.text(`ITR Client HQ — ${process.env.K_REVISION ?? 'local'}\n`),
);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Last-resort error handler. Critical: do NOT log request bodies here.
// The PHI redactor (M1+) will sit upstream and pre-scrub fields we log.
// Until then, we log only structural fields.
app.onError((err, c) => {
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      message: 'unhandled_error',
      error: err.message,
      stack: err.stack,
      path: c.req.path,
      method: c.req.method,
      revision: process.env.K_REVISION ?? 'local',
    }),
  );
  return c.json({ error: 'internal_error' }, 500);
});

const port = Number(process.env.PORT) || 8080;

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    JSON.stringify({
      severity: 'INFO',
      message: 'server_listening',
      port: info.port,
      revision: process.env.K_REVISION ?? 'local',
    }),
  );
});

// Cloud Run sends SIGTERM ~10s before shutting an instance down.
// Drain in-flight requests before exiting.
const shutdown = (signal: string) => {
  console.log(
    JSON.stringify({ severity: 'INFO', message: 'shutdown', signal }),
  );
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 9000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
