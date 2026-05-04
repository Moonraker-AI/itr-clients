/**
 * Per-request trace correlation.
 *
 * Cloud Run + Cloud Logging recognize a magic field
 *   "logging.googleapis.com/trace": "projects/<PROJECT>/traces/<TRACE_ID>"
 * which makes the Logs Explorer UI group every log entry from one request
 * under the same trace, regardless of which file emitted it. The TRACE_ID
 * comes from the inbound `X-Cloud-Trace-Context` header (Google's HTTP
 * load balancer + Cloud Run frontends inject it on every request).
 *
 * Header format:  TRACE_ID/SPAN_ID;o=OPTIONS
 *
 * We use AsyncLocalStorage so the logger doesn't need a Hono Context
 * (state-machine.ts and lib/* code logs without one).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface TraceStore {
  traceId: string;
}

const als = new AsyncLocalStorage<TraceStore>();

const TRACE_ID_RE = /^[0-9a-f]{16,}$/i;

export function parseTraceId(header: string | undefined | null): string | null {
  if (!header) return null;
  const slash = header.indexOf('/');
  const id = (slash >= 0 ? header.slice(0, slash) : header).trim();
  if (!id || !TRACE_ID_RE.test(id)) return null;
  return id;
}

export function runWithTrace<T>(traceId: string | null, fn: () => T): T {
  if (!traceId) return fn();
  return als.run({ traceId }, fn);
}

export function currentTraceId(): string | null {
  return als.getStore()?.traceId ?? null;
}
