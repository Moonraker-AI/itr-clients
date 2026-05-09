/**
 * Sentry wrapper (P3 — first real client error reporting on prod).
 *
 * Design constraints (HIPAA-relevant):
 *
 *   1. **PHI never leaves the project**. The Cloud Run + Cloud SQL boundary
 *      is the BAA perimeter. Sentry is OUTSIDE it. Every event must run
 *      through `phi-redactor.redact()` before transmission, and we
 *      additionally disable every Sentry default that scrapes process /
 *      request data automatically (URL paths, headers, env, user info).
 *
 *   2. **No-op when DSN unset**. Local dev + Cloud Build have no DSN.
 *      Init silently no-ops so callers don't need to guard.
 *
 *   3. **Errors only**. No tracing, no performance, no profiling, no
 *      session replay. Each of those would surface PHI-bearing URLs or
 *      request bodies.
 *
 *   4. **Capture is opt-in via captureError(err, ctx)**. Don't rely on
 *      Sentry's auto-instrumentation — explicit capture sites mean we
 *      always run the redactor at the call boundary.
 */

import * as Sentry from '@sentry/node';

import { redact } from './phi-redactor.js';

let initialised = false;

export interface InitArgs {
  /** Set on Sentry events for filtering by deploy. e.g. K_REVISION. */
  release?: string;
  /** dev | prod. Drives Sentry's environment tag. */
  environment?: string;
}

/**
 * Idempotent init. No-op if SENTRY_DSN is unset (local + CI default).
 * Safe to call multiple times — second call is a no-op.
 */
export function initSentry(args: InitArgs = {}): void {
  if (initialised) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    release: args.release ?? process.env.K_REVISION ?? undefined,
    environment: args.environment ?? guessEnvironment(),

    // Errors only. Tracing, profiling, session replay all default off.
    tracesSampleRate: 0,
    sampleRate: 1.0,

    // Strip Sentry defaults that auto-collect PII / request data. We
    // explicitly capture errors with a sanitised context object instead.
    sendDefaultPii: false,
    attachStacktrace: true,
    integrations: (defaults) =>
      defaults.filter((i) => {
        // Drop integrations that hook into Node internals to grab request
        // headers, response bodies, console output verbatim, or process
        // env. We want stack + message only.
        const drop = new Set([
          'Http',           // captures HTTP req/resp + headers
          'NodeFetch',      // captures fetch req/resp
          'Console',        // captures console.log calls verbatim
          'OnUncaughtException', // we have our own handler
          'OnUnhandledRejection',
          'ContextLines',   // reads source files; mostly fine but unneeded
          'LocalVariables', // captures stack-frame locals (PHI risk)
        ]);
        return !drop.has(i.name);
      }),

    // Final scrub: walk every event field through the redactor before
    // transmission. This is belt + suspenders to the explicit-capture
    // discipline above.
    beforeSend: (event) => scrubEvent(event) as typeof event,
    // Defensive — tracesSampleRate is 0 so this never fires, but if
    // someone enables tracing later they'd start leaking URL paths.
    beforeSendTransaction: (t) => scrubEvent(t) as typeof t,
  });

  initialised = true;
}

/**
 * Capture an error with a sanitised structured context. Always prefer this
 * over `Sentry.captureException` directly — the redactor runs on `ctx`
 * before it ever reaches Sentry's serialisation pipeline.
 */
export function captureError(err: unknown, ctx: Record<string, unknown> = {}): void {
  if (!initialised) return;
  const scrubbed = redact(ctx) as Record<string, unknown>;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(scrubbed)) {
      scope.setContext(k, { value: v });
    }
    Sentry.captureException(err);
  });
}

/**
 * Wait for queued events to flush before the process exits. Cloud Run can
 * freeze instances aggressively; calling this from a SIGTERM handler is
 * the only reliable way to get the last batch out.
 */
export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  if (!initialised) return true;
  return Sentry.flush(timeoutMs);
}

function guessEnvironment(): string {
  const project = process.env.GCP_PROJECT_ID ?? '';
  if (project.includes('prod')) return 'prod';
  if (project.includes('dev')) return 'dev';
  return process.env.NODE_ENV ?? 'unknown';
}

/**
 * Walks an event's user-controlled fields through the PHI redactor.
 * Sentry events are deeply nested — message + exception values + breadcrumbs
 * + extra + contexts + tags. We touch every leaf string.
 *
 * Note: this is `beforeSend`, so returning `null` would drop the event
 * entirely. We always return the (scrubbed) event so error visibility wins
 * over the (very small) chance the redactor mangles a stack frame.
 */
function scrubEvent(event: unknown): unknown {
  return redact(event);
}
