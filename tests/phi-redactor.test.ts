import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { redact } from '../src/lib/phi-redactor.ts';

describe('phi-redactor: scrubs PHI patterns in strings', () => {
  test('redacts email addresses', () => {
    const out = redact('contact alice@example.com today');
    assert.match(String(out), /\[REDACTED:phi]/);
    assert.doesNotMatch(String(out), /alice@example\.com/);
  });

  test('redacts US phone numbers', () => {
    const out = redact('call 555-123-4567 please');
    assert.match(String(out), /\[REDACTED:phi]/);
    assert.doesNotMatch(String(out), /555-123-4567/);
  });

  test('redacts DOB-shaped dates', () => {
    const out = redact('born 1985-03-21');
    assert.match(String(out), /\[REDACTED:phi]/);
  });
});

describe('phi-redactor: preserves safe strings', () => {
  test('URLs unchanged', () => {
    const url = 'https://clients.intensivetherapyretreat.com/c/abc';
    assert.equal(redact(url), url);
  });

  test('UUIDs unchanged', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    assert.equal(redact(uuid), uuid);
  });

  test('ISO datetimes unchanged', () => {
    const iso = '2026-05-05T14:30:00.000Z';
    assert.equal(redact(iso), iso);
  });
});

describe('phi-redactor: deep walks structures', () => {
  test('scrubs nested object values', () => {
    const out = redact({
      level1: { email: 'bob@example.com', safe: 42 },
      arr: ['call 555-987-6543', 'no-pii'],
    }) as {
      level1: { email: string; safe: number };
      arr: string[];
    };
    assert.match(out.level1.email, /\[REDACTED:phi]/);
    assert.equal(out.level1.safe, 42);
    assert.match(out.arr[0]!, /\[REDACTED:phi]/);
    assert.equal(out.arr[1], 'no-pii');
  });

  test('handles Error instances', () => {
    const e = new Error('caller=admin@example.com tried to do X');
    const out = redact(e) as { name: string; message: string };
    assert.equal(out.name, 'Error');
    assert.match(out.message, /\[REDACTED:phi]/);
    assert.doesNotMatch(out.message, /admin@example\.com/);
  });

  test('caps recursion depth (does not stack-overflow on cycles)', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a['b'] = b;
    // Should return without throwing.
    const out = redact(a);
    assert.ok(out !== undefined);
  });
});

describe('phi-redactor: primitives pass through', () => {
  test('numbers, booleans, null, undefined unchanged', () => {
    assert.equal(redact(42), 42);
    assert.equal(redact(true), true);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });
});
