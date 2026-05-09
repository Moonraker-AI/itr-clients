import { strict as assert } from 'node:assert';
import { test, describe, beforeEach } from 'node:test';

import {
  captureError,
  flushErrorReporter,
  initErrorReporter,
} from '../src/lib/error-reporter.ts';

interface CapturedEntry {
  severity: string;
  '@type': string;
  message: string;
  serviceContext: { service: string; version?: string };
  context: Record<string, unknown>;
  eventTime: string;
}

function captureStdout(): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    for (const line of s.split('\n').filter(Boolean)) lines.push(line);
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

function parse(line: string): CapturedEntry {
  return JSON.parse(line) as CapturedEntry;
}

describe('error-reporter: captureError JSON shape', () => {
  beforeEach(() => {
    // Reset internal init state between tests via a fresh service+version.
    // initErrorReporter is idempotent; we re-call to reset version cleanly.
    delete process.env.K_REVISION;
  });

  test('emits ReportedErrorEvent shape with @type', () => {
    const cap = captureStdout();
    try {
      captureError(new Error('boom'), { foo: 'bar' });
    } finally {
      cap.restore();
    }
    assert.equal(cap.lines.length, 1);
    const entry = parse(cap.lines[0]!);
    assert.equal(entry.severity, 'ERROR');
    assert.equal(
      entry['@type'],
      'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    );
    assert.match(entry.message, /^Error: boom/);
    assert.ok(entry.serviceContext.service);
    assert.ok(entry.eventTime);
  });

  test('message contains stack trace text (Error Reporting groups on top frame)', () => {
    const cap = captureStdout();
    try {
      captureError(new Error('grouped'));
    } finally {
      cap.restore();
    }
    const entry = parse(cap.lines[0]!);
    // Stack should contain 'at ' frames
    assert.match(entry.message, /\n\s+at /);
  });

  test('non-Error throwables become string messages', () => {
    const cap = captureStdout();
    try {
      captureError('string error');
    } finally {
      cap.restore();
    }
    const entry = parse(cap.lines[0]!);
    assert.equal(entry.message, 'string error');
  });

  test('object throwable JSON-stringifies into message', () => {
    const cap = captureStdout();
    try {
      captureError({ code: 'X' });
    } finally {
      cap.restore();
    }
    const entry = parse(cap.lines[0]!);
    assert.equal(entry.message, '{"code":"X"}');
  });

  test('ctx is included under context.* alongside environment', () => {
    const cap = captureStdout();
    try {
      captureError(new Error('e'), { request: { path: '/foo' } });
    } finally {
      cap.restore();
    }
    const entry = parse(cap.lines[0]!);
    assert.ok('environment' in entry.context);
    assert.deepEqual(entry.context.request, { path: '/foo' });
  });

  test('opts.service overrides serviceContext.service for that call', () => {
    initErrorReporter({ service: 'itr-client-hq' });
    const cap = captureStdout();
    try {
      captureError(new Error('browser-side'), {}, {
        service: 'itr-client-hq-browser',
      });
    } finally {
      cap.restore();
    }
    const entry = parse(cap.lines[0]!);
    assert.equal(entry.serviceContext.service, 'itr-client-hq-browser');
  });

  test('emits one valid JSON line per call (no buffering, no concat)', () => {
    const cap = captureStdout();
    try {
      captureError(new Error('a'));
      captureError(new Error('b'));
      captureError(new Error('c'));
    } finally {
      cap.restore();
    }
    assert.equal(cap.lines.length, 3);
    for (const line of cap.lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

describe('error-reporter: flushErrorReporter', () => {
  test('returns true (no-op) — does not throw', async () => {
    const ok = await flushErrorReporter();
    assert.equal(ok, true);
  });
});
