// Sentry browser entry (v0.21.0). Bundled by scripts/build-assets.mjs via
// esbuild into dist/static/js/sentry-browser.js.
//
// Reads its config from three <meta> tags injected by the server-rendered
// Layout when SENTRY_BROWSER_DSN is present in the env. When the DSN tag
// is absent (local dev, no-Sentry envs) initSentry returns early with no
// network or runtime side-effects.
//
// HIPAA-relevant defaults:
//   * sendDefaultPii: false  — no IP, no cookies, no user-agent metadata
//   * tracesSampleRate: 0    — no performance / URL sampling
//   * autoSessionTracking: false
//   * beforeSend scrubs the client_token segment out of any captured
//     request URL (`/c/<token>/...`) and clears request body if Sentry
//     accidentally captures one.
//
// The token in /c/<token>/... is unguessable but treating URL paths as
// PHI is the conservative move: even an opaque id ties the error report
// back to a specific consent-flow session.

import * as Sentry from '@sentry/browser';

const TOKEN_PATH_RE = /\/c\/[A-Za-z0-9_-]{16,}/g;

function getMeta(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.getAttribute('content') || '' : '';
}

function scrubUrl(url) {
  if (typeof url !== 'string') return url;
  // Mask the token segment but keep the trailing path so error grouping
  // still distinguishes /consents from /checkout from /confirm-payment.
  return url.replace(TOKEN_PATH_RE, '/c/[REDACTED]');
}

function scrubEvent(event) {
  if (!event) return event;
  if (event.request) {
    if (typeof event.request.url === 'string') {
      event.request.url = scrubUrl(event.request.url);
    }
    // Form data + query params can carry name/email — drop them entirely.
    delete event.request.data;
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.headers;
  }
  // Breadcrumbs of type "navigation" carry from/to URLs; scrub both.
  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) {
      if (b && b.data) {
        if (typeof b.data.from === 'string') b.data.from = scrubUrl(b.data.from);
        if (typeof b.data.to === 'string') b.data.to = scrubUrl(b.data.to);
        if (typeof b.data.url === 'string') b.data.url = scrubUrl(b.data.url);
      }
    }
  }
  // Drop user object entirely — Sentry would default to ip + id which
  // are PII per our boundary.
  delete event.user;
  return event;
}

function init() {
  const dsn = getMeta('sentry-browser-dsn');
  if (!dsn) return;

  const environment = getMeta('sentry-browser-env') || 'unknown';
  const release = getMeta('sentry-browser-release') || undefined;

  Sentry.init({
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    autoSessionTracking: false,
    tracesSampleRate: 0,
    sampleRate: 1.0,
    integrations: (defaults) =>
      defaults.filter((i) => {
        // Drop integrations that scrape DOM contents, console output,
        // request headers, or breadcrumb network bodies.
        const drop = new Set([
          'BrowserApiErrors',  // patches DOM / XHR — fine but adds breadcrumbs
          'Breadcrumbs',
          'GlobalHandlers',    // we add our own handlers below for clarity
        ]);
        return !drop.has(i.name);
      }),
    beforeSend: scrubEvent,
    beforeBreadcrumb: () => null, // belt + suspenders — drop all breadcrumbs
  });

  // Capture uncaught errors + unhandled promise rejections explicitly so
  // we don't depend on Sentry's GlobalHandlers integration (filtered above).
  window.addEventListener('error', (ev) => {
    if (ev.error) Sentry.captureException(ev.error);
    else Sentry.captureMessage(`window.onerror: ${ev.message}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    Sentry.captureException(ev.reason);
  });
}

init();
