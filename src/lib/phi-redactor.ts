/**
 * PHI redactor for application logs.
 *
 * Defense-in-depth, NOT the primary HIPAA control:
 *   - Cloud Run/Cloud Logging are inside the GCP BAA scope already.
 *   - This redactor's purpose is to limit the blast radius if a developer
 *     accidentally logs a request body or DB row containing PHI, and to keep
 *     PHI out of any export (BigQuery sink, error-tracking provider, etc.)
 *     that may sit downstream of stdout.
 *
 * Strategy: deep-clone any object passed to log(), then walk it and replace
 * values that match PHI-shaped patterns. Keys are NOT used as a hint —
 * pattern-matching the value is more robust to renamed fields.
 *
 * Patterns scrubbed:
 *   - email addresses
 *   - phone numbers (US-style + E.164)
 *   - dates that look like a DOB (YYYY-MM-DD or MM/DD/YYYY)
 *   - SSN (xxx-xx-xxxx)
 *   - long free-text fields (>120 chars) that aren't a stack trace or URL
 *
 * Allowed through:
 *   - Stack traces (kept; vital for debugging)
 *   - URLs (kept; useful for tracing)
 *   - opaque IDs (UUID, short slugs, numeric IDs)
 *   - ISO 8601 timestamps with a time component (operational, not DOB-shaped)
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,}\d)/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const DOB_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const URL_RE = /^https?:\/\//;
const STACK_RE = /\n\s+at\s/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REDACTED = '[REDACTED:phi]';
const MAX_FREE_TEXT = 120;

function scrubString(s: string): string {
  if (s.length === 0) return s;
  if (URL_RE.test(s) || STACK_RE.test(s) || UUID_RE.test(s)) return s;
  if (ISO_DATETIME_RE.test(s)) return s;

  let out = s
    .replace(EMAIL_RE, REDACTED)
    .replace(SSN_RE, REDACTED)
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 10 ? REDACTED : m))
    .replace(DOB_RE, REDACTED);

  // Very long strings that aren't already-known structural data are likely
  // free-text notes. Truncate hard rather than trying to parse them.
  if (out.length > MAX_FREE_TEXT) {
    out = `${out.slice(0, MAX_FREE_TEXT)}…[truncated]`;
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack,
    };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

/**
 * Structured log entry. Goes to stdout as a single JSON line — Cloud Logging
 * picks up `severity`, `message`, and any other fields automatically.
 */
type LogFields = Record<string, unknown>;

function emit(severity: string, fields: LogFields): void {
  const safe = redact(fields) as LogFields;
  const line = JSON.stringify({ severity, ...safe });
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const log = {
  info: (message: string, fields: LogFields = {}) =>
    emit('INFO', { message, ...fields }),
  warn: (message: string, fields: LogFields = {}) =>
    emit('WARNING', { message, ...fields }),
  error: (message: string, fields: LogFields = {}) =>
    emit('ERROR', { message, ...fields }),
};
