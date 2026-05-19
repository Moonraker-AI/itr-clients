import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { browserErrorRoute } from '../src/routes/api/browser-error.ts';

interface CapturedEntry {
  severity: string;
  '@type': string;
  message: string;
  serviceContext: { service: string };
  context: Record<string, unknown>;
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

function findReportedEvent(lines: string[]): CapturedEntry | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as CapturedEntry;
      if (obj['@type']?.includes('ReportedErrorEvent')) return obj;
    } catch {
      // skip non-JSON log lines
    }
  }
  return null;
}

async function post(
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
  return browserErrorRoute.fetch(req);
}

describe('POST /api/browser-error: happy path', () => {
  test('valid payload → 200 + ReportedErrorEvent emitted', async () => {
    const cap = captureStdout();
    let res: Response;
    try {
      res = await post({
        msg: 'TypeError: oops',
        stack: 'TypeError: oops\n    at foo (https://example.com/x.js:1:2)',
        url: 'https://example.com/c/abc',
        userAgent: 'Mozilla/5.0',
        lineNumber: 42,
        columnNumber: 7,
      });
    } finally {
      cap.restore();
    }
    assert.equal(res.status, 200);
    const entry = findReportedEvent(cap.lines);
    assert.ok(entry, 'expected a ReportedErrorEvent on stdout');
    assert.equal(entry.serviceContext.service, 'itr-client-hq-browser');
    assert.match(entry.message, /TypeError: oops/);
  });

  test('preserves browser-supplied stack (Error Reporting groups on it)', async () => {
    const cap = captureStdout();
    try {
      await post({
        msg: 'X',
        stack: 'X\n    at handler (foo.js:5:5)',
      });
    } finally {
      cap.restore();
    }
    const entry = findReportedEvent(cap.lines);
    assert.ok(entry);
    assert.match(entry.message, /at handler \(foo\.js:5:5\)/);
  });

  test('redacts PHI in browser-supplied message and stack', async () => {
    const cap = captureStdout();
    try {
      await post({
        msg: 'client alice@example.com failed',
        stack:
          'client alice@example.com failed\n' +
          '    at handler (https://example.com/app.js:5:5)',
      });
    } finally {
      cap.restore();
    }
    const entry = findReportedEvent(cap.lines);
    assert.ok(entry);
    assert.doesNotMatch(entry.message, /alice@example\.com/);
    assert.match(entry.message, /\[REDACTED:phi]/);
    assert.match(entry.message, /at handler/);
  });
});

describe('POST /api/browser-error: hardening', () => {
  test('invalid JSON body → 400', async () => {
    const res = await post('not json{');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'invalid_json');
  });

  test('oversized body → 413', async () => {
    const big = { msg: 'x'.repeat(10_000) };
    const res = await post(big);
    assert.equal(res.status, 413);
  });

  test('missing fields tolerated — defaults applied', async () => {
    const cap = captureStdout();
    let res: Response;
    try {
      res = await post({});
    } finally {
      cap.restore();
    }
    assert.equal(res.status, 200);
    const entry = findReportedEvent(cap.lines);
    assert.ok(entry);
    assert.match(entry.message, /^BrowserError: unknown/);
  });

  test('truncates oversized msg field (500 char cap on server)', async () => {
    const cap = captureStdout();
    try {
      await post({ msg: 'a'.repeat(2_000) });
    } finally {
      cap.restore();
    }
    const entry = findReportedEvent(cap.lines);
    assert.ok(entry);
    // Server slices `msg` to 500 chars before constructing the synthetic
    // Error. Message starts with "BrowserError: " + the 500-char msg;
    // any trailing stack frames are Node-generated, not from the payload.
    const expectedPrefix = `BrowserError: ${'a'.repeat(500)}`;
    assert.ok(entry.message.startsWith(expectedPrefix));
    assert.ok(!entry.message.includes('a'.repeat(501)));
  });

  test('non-string fields silently dropped', async () => {
    const cap = captureStdout();
    try {
      await post({
        msg: { evil: 'object' },
        stack: 12345,
        url: ['array'],
      });
    } finally {
      cap.restore();
    }
    const entry = findReportedEvent(cap.lines);
    assert.ok(entry);
    // msg falls back to 'unknown' when not a string
    assert.match(entry.message, /^BrowserError: unknown/);
  });
});
