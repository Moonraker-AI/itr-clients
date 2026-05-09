// Browser error reporter (v0.28.0). Replaces sentry-browser-entry.js.
// Bundled by scripts/build-assets.mjs via esbuild into
// dist/static/js/browser-error.js.
//
// No external SDK. Vanilla window.onerror + unhandledrejection handlers
// that POST to /api/browser-error. The server runs the payload through
// the PHI redactor and forwards it to Cloud Error Reporting via Cloud
// Logging — all inside GCP's existing BAA boundary.
//
// HIPAA-relevant defaults:
//   * Strip query strings + fragments (PHI risk on /c/<token>/...)
//   * Mask client_token segments in path
//   * Truncate stacks at 4 KB (server enforces too — this just keeps
//     the request small)
//   * No DOM scraping, no breadcrumbs, no fetch/XHR instrumentation
//   * `keepalive: true` so reports survive page unload

const TOKEN_PATH_RE = /\/c\/[A-Za-z0-9_-]{16,}/g;

function scrubUrl(url) {
  if (typeof url !== 'string') return undefined;
  // Drop query + fragment (form fields, returnTo, etc.)
  const noQuery = url.split('?')[0].split('#')[0];
  // Mask the unguessable client token in /c/<token>/... segments
  return noQuery.replace(TOKEN_PATH_RE, '/c/[REDACTED]');
}

function send(payload) {
  try {
    fetch('/api/browser-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Survives navigation away from the page that errored.
      keepalive: true,
      // Endpoint is same-origin + public — no credentials needed.
      credentials: 'omit',
    }).catch(() => {});
  } catch {
    // Fire-and-forget. Never let the reporter itself surface an error.
  }
}

function fromError(err) {
  if (!err) return { msg: 'unknown' };
  if (err instanceof Error) {
    return {
      msg: String(err.message ?? err.name ?? 'Error').slice(0, 500),
      stack: typeof err.stack === 'string' ? err.stack.slice(0, 4_000) : undefined,
    };
  }
  return { msg: String(err).slice(0, 500) };
}

window.addEventListener('error', (ev) => {
  const base = ev.error ? fromError(ev.error) : { msg: String(ev.message ?? 'window.onerror').slice(0, 500) };
  send({
    ...base,
    url: scrubUrl(location.href),
    userAgent: navigator.userAgent.slice(0, 500),
    lineNumber: typeof ev.lineno === 'number' ? ev.lineno : undefined,
    columnNumber: typeof ev.colno === 'number' ? ev.colno : undefined,
  });
});

window.addEventListener('unhandledrejection', (ev) => {
  send({
    ...fromError(ev.reason),
    url: scrubUrl(location.href),
    userAgent: navigator.userAgent.slice(0, 500),
  });
});
