# Error reporting

**Status:** Active since v0.28.0. Replaces the prior Sentry integration.

## What it is

Server + browser errors flow into **GCP Cloud Error Reporting** via Cloud
Logging. No external SDK, no DSN, no vendor BAA. The existing GCP BAA
covers Cloud Logging + Cloud Error Reporting end-to-end.

## How it works

`src/lib/error-reporter.ts` exports `captureError(err, ctx, opts?)`.
Each call writes a single JSON line to `process.stdout` in the
`ReportedErrorEvent` shape:

```json
{
  "severity": "ERROR",
  "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
  "message": "<stack trace text>",
  "serviceContext": { "service": "itr-client-hq", "version": "<K_REVISION>" },
  "context": { "environment": "prod", "...redacted ctx fields..." },
  "eventTime": "2026-05-09T15:32:11.123Z"
}
```

Cloud Run pipes stdout into Cloud Logging. Cloud Logging recognises the
`@type` discriminator and routes the entry into Error Reporting, which
groups by the top stack frame in `message`.

PHI redactor still runs over `ctx` before the entry is composed —
defense-in-depth even though everything stays inside the BAA perimeter.

## Browser errors

Vanilla bundle at `src/assets/js-bundles/browser-error-entry.js`:

- `window.onerror` + `window.onunhandledrejection` listeners
- POSTs to `/api/browser-error` with `{msg, stack, url, userAgent, lineNumber, columnNumber}`
- Strips query + fragment from URLs; masks `/c/<token>/` segments
- `keepalive: true` so reports survive page unload
- No external SDK; loaded from `dist/static/js/browser-error.js`

`src/routes/api/browser-error.ts` validates + scrubs + calls
`captureError(...)` with `service: 'itr-client-hq-browser'` so server
vs. browser issues group into separate streams in the Error Reporting
UI.

Endpoint hardening:

- `bodyLimit` 8 KB
- Rate limit 10/min/IP
- Public + unauthenticated (errors fire pre-session)
- Same-origin (CSP `connect-src 'self'`)

## Where to look in GCP

- **Console:** GCP project → Operations → Error Reporting
- Filter by `serviceContext.service`:
  - `itr-client-hq` — main service errors
  - `itr-stripe-webhook` — webhook-only sibling service
  - `itr-client-hq-browser` — browser-side errors
- Filter by environment via the `context.environment` field (`dev` vs `prod`).

## Adding alerts

Cloud Error Reporting → click a group → "Notifications" → choose channel
(use the `Support inbox` channel created by `apply-monitoring.sh`).

## Removing the prior Sentry integration

Done in v0.28.0. Removed: `@sentry/node`, `@sentry/browser`, both
bootstrap scripts, all SENTRY_* env vars + Cloud Build substitutions,
CSP entries for `*.ingest.sentry.io` + `*.sentry.io`.

If you ever need to verify Sentry is fully extricated:

```bash
grep -rni 'sentry' src/ scripts/ infra/ docs/ package.json
```

Should return zero hits (this doc itself avoids the brand name in any
load-bearing position).
