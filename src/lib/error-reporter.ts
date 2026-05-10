/**
 * Error reporter (v0.28.0). Replaces the prior Sentry wrapper.
 *
 * GCP Cloud Error Reporting auto-derives errors from any Cloud Logging
 * entry whose `jsonPayload` matches the `ReportedErrorEvent` shape (or
 * whose textPayload contains a stack-trace pattern). Cloud Run already
 * pipes stdout/stderr into Cloud Logging, so a single `console.log` of
 * a JSON line is enough - no SDK, no DSN, no external vendor, no BAA.
 *
 * GCP's BAA already covers Cloud Logging + Cloud Error Reporting, so
 * everything that flows through here stays inside the existing HIPAA
 * perimeter. PHI redactor still runs as defense-in-depth - the BAA
 * removes the legal exposure but doesn't make leaking PHI ok.
 *
 * Surface:
 *   - initErrorReporter(args)  - idempotent; sets serviceContext defaults.
 *   - captureError(err, ctx)   - log a ReportedErrorEvent. Sync.
 *   - flushErrorReporter()     - no-op (stdout is unbuffered on Cloud Run).
 */

import { redact } from './phi-redactor.js';

export interface InitArgs {
  /** Cloud Run revision id; goes into serviceContext.version. */
  release?: string;
  /** dev | prod. Recorded as `environment` in the event context. */
  environment?: string;
  /** serviceContext.service. Defaults to 'itr-client-hq'. */
  service?: string;
}

interface ServiceContext {
  service: string;
  version?: string;
}

let serviceContext: ServiceContext = { service: 'itr-client-hq' };
let environment = 'unknown';
let initialised = false;

/**
 * Idempotent. Captures the service + revision metadata that gets attached
 * to every reported event. Safe to call multiple times - second call is a
 * no-op.
 */
export function initErrorReporter(args: InitArgs = {}): void {
  if (initialised) return;
  const version = args.release ?? process.env.K_REVISION;
  serviceContext = {
    service: args.service ?? 'itr-client-hq',
    ...(version ? { version } : {}),
  };
  environment = args.environment ?? guessEnvironment();
  initialised = true;
}

/**
 * Report an error with sanitised structured context. The `@type` field is
 * what tells Cloud Error Reporting to pick this up; without it Cloud
 * Logging accepts the entry but Error Reporting won't group/alert on it.
 *
 * `message` MUST contain the stack trace as text - Error Reporting
 * derives the grouping signature from the top stack frame.
 */
export function captureError(
  err: unknown,
  ctx: Record<string, unknown> = {},
  opts: { service?: string } = {},
): void {
  const scrubbedCtx = redact(ctx) as Record<string, unknown>;
  const message = formatErrorMessage(err);
  const sc: ServiceContext = opts.service
    ? { ...serviceContext, service: opts.service }
    : serviceContext;
  const entry = {
    severity: 'ERROR',
    '@type':
      'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    message,
    serviceContext: sc,
    context: {
      environment,
      ...scrubbedCtx,
    },
    eventTime: new Date().toISOString(),
  };
  // Cloud Run + Cloud Logging: stdout is parsed as structured JSON when
  // the line is valid JSON. stderr would also work but stdout matches
  // the rest of `phi-redactor.log.error` for ordering inside a request.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/**
 * No-op. Cloud Run flushes stdout on shutdown automatically - no buffer
 * to drain. Kept as an export for symmetry with the old Sentry surface
 * + so server.ts SIGTERM handler doesn't need a conditional.
 */
export async function flushErrorReporter(_timeoutMs = 2000): Promise<boolean> {
  return true;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // `err.stack` contains "Name: message\n    at ..." which is exactly
    // what Cloud Error Reporting wants. The redactor still runs on the
    // ctx fields, but stack text is left as-is - frame paths + function
    // names are not PHI by our boundary definition.
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function guessEnvironment(): string {
  const project = process.env.GCP_PROJECT_ID ?? '';
  if (project.includes('prod')) return 'prod';
  if (project.includes('dev')) return 'dev';
  return process.env.NODE_ENV ?? 'unknown';
}
