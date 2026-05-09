# Sentry — error reporting

Shipped in v0.14.0 as the first real client error reporting on prod.

## Status

- `@sentry/node` v10 wired in `src/lib/sentry.ts`.
- `initSentry()` runs at server.ts boot; no-op when `SENTRY_DSN` unset.
- `app.onError` calls `captureError(err, { request, runtime })` after
  the structured log.
- SIGTERM handler flushes Sentry queue (1.5s budget) before draining
  the DB pool.
- Cloud Build: `_SENTRY_SECRETS_PART` substitution defaults to empty;
  set on each env's trigger to bind the secret.

## HIPAA-relevant design

PHI never leaves the project. Sentry is OUTSIDE the BAA perimeter. The
wrapper enforces this in three places:

1. **No auto-instrumentation.** Default Sentry integrations that scrape
   request headers, response bodies, console.log calls, source-file
   lines, or stack-frame locals are filtered out at init time. We rely
   on explicit `captureError()` calls instead.
2. **`captureError(err, ctx)` runs the PHI redactor on `ctx`** before
   passing it to Sentry. Same redactor as `lib/phi-redactor.ts`.
3. **`beforeSend` runs the redactor on the entire event** (message,
   exception, stack, contexts, breadcrumbs) as a final scrub. Belt +
   suspenders.

Disabled features:
- `tracesSampleRate: 0` — no performance / tracing (URL paths could
  contain client tokens).
- `sendDefaultPii: false` — no IP address, no user agent, no cookies.
- No session replay (browser-only anyway, but worth noting).

## Activation

Two scripts, one per project:

```bash
# 1. Create the SENTRY_DSN secret + bind runtime SA + grant accessor.
SENTRY_DSN='https://...@oXXX.ingest.sentry.io/YYYY' \
  scripts/bootstrap-sentry.sh dev
SENTRY_DSN='https://...@oXXX.ingest.sentry.io/YYYY' \
  scripts/bootstrap-sentry.sh prod

# 2. (Manual) Edit each Cloud Build trigger and add the substitution
#    the script prints at the end:
#      _SENTRY_SECRETS_PART = ,SENTRY_DSN=sentry-dsn:latest

# 3. Push a commit (or re-run the most recent build) to bind the env
#    var into the running Cloud Run service.
```

To verify:
- `gcloud run services describe itr-client-hq --project=<PID>
  --format='value(spec.template.spec.containers[0].env)'` includes
  `SENTRY_DSN`.
- Trigger a test exception by hitting an admin route while logged-out
  with a malformed cookie; the resulting `unhandled_error` should show
  in Sentry within ~5s.

## What gets captured

Every uncaught error inside an HTTP handler that reaches `app.onError`
in `src/server.ts`. That includes:

- Hono validator throws
- DB connection failures (pg pool exhausted, etc.)
- Drizzle query errors that the route forgot to catch
- JSX render errors inside route handlers
- Any `throw` inside a state-machine or notification call that
  propagates up

What does NOT get captured (intentionally):

- **Cron handler errors** — already structured-logged + alerted on via
  Cloud Monitoring (`cron_scan_bounces_failed` etc.). Adding Sentry too
  would just add cost and noise.
- **Stripe webhook signature mismatches** — these are normal probe
  traffic, not bugs. Logged at `warn`, not `error`.
- **Auth failures** — `cron_shared_secret_mismatch`, `unauthorized`
  responses are operational signals, not Sentry-worthy bugs.

If you want to manually capture a non-throwing error path (e.g. inside
a try/catch where you log + recover), call:

```ts
import { captureError } from '../lib/sentry.js';

try {
  await thing();
} catch (err) {
  log.error('thing_failed', { error: (err as Error).message });
  captureError(err, { phase: 'thing', retreatId });
}
```

Always pass the structured context object — the redactor scrubs it
before sending. Plain `Sentry.captureException(err)` works but bypasses
the structured-context discipline; prefer `captureError`.

## Sample rate + cost

Sample rate is 100% errors, 0% performance. With the prod traffic
profile (low-volume B2B), this is well under the Sentry developer-tier
free quota (5k errors / month). Revisit if we ever exceed it.

## Browser-side Sentry (v0.21.0)

A second Sentry project covers the browser surface: signature-pad, the
firebase-signin flow, and the Stripe confirmation page. The Node and
browser DSNs are kept in separate Sentry projects so we can set
per-project rate limits + alerting + retention.

### Wiring

- `src/assets/js-bundles/sentry-browser-entry.js` — bundled by
  `scripts/build-assets.mjs` via esbuild (already present) into
  `dist/static/js/sentry-browser.js` (~80KB minified). Same-origin so
  CSP `script-src 'self'` covers it.
- `src/lib/ui/layout.tsx` injects three `<meta>` tags + the script tag
  into `<head>` ONLY when `SENTRY_BROWSER_DSN` is set. No env var → no
  script tag → no network → no client overhead.
- CSP `connect-src` allows `https://*.ingest.sentry.io` and
  `https://*.sentry.io`. No `script-src` change needed.

### HIPAA-relevant defaults (browser)

- `sendDefaultPii: false` — no IP, cookies, or user-agent.
- `tracesSampleRate: 0` — no performance / URL sampling.
- `autoSessionTracking: false`.
- Default integrations `BrowserApiErrors`, `Breadcrumbs`,
  `GlobalHandlers` are filtered out at init. Custom `error` and
  `unhandledrejection` listeners hand exceptions to Sentry directly.
- `beforeSend` scrubs the client-token segment out of any captured
  request URL (`/c/<token>/...` → `/c/[REDACTED]`) and clears
  `request.data`, `query_string`, `cookies`, `headers`, `user`.
- `beforeBreadcrumb` returns null — drop all breadcrumbs.

### Activation

```bash
SENTRY_BROWSER_DSN='https://...@oXXX.ingest.sentry.io/YYYY' \
  scripts/bootstrap-sentry-browser.sh dev
SENTRY_BROWSER_DSN='...' scripts/bootstrap-sentry-browser.sh prod
```

Then on each env's Cloud Build trigger, set:

```
_SENTRY_BROWSER_SECRETS_PART = ,SENTRY_BROWSER_DSN=sentry-browser-dsn:latest
```

Push a commit (or re-run the most recent build) so the next Cloud Run
deploy mounts the env var. Test by triggering a `throw new Error(...)`
in DevTools console on a logged-in admin page; the event should show
in the browser project within 5s.

## Disabling

Either:
- Unset `_SENTRY_SECRETS_PART` on the Cloud Build trigger and re-deploy
  → next instance comes up without `SENTRY_DSN`, `initSentry` no-ops.
- Or disable the secret version with `gcloud secrets versions disable
  latest --secret=sentry-dsn` → fail-closed is also a no-op since the
  Cloud Run mount fails and the env var is unset.
