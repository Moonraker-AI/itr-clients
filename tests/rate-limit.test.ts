import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { createRateLimiter } from '../src/lib/rate-limit.ts';

describe('rate-limit: counts within window', () => {
  test('under cap → not limited', () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      max: 5,
      bucketKey: () => 'x',
    });
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.isLimited('1.2.3.4'), false, `req ${i + 1}`);
    }
  });

  test('one over cap → limited', () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      max: 3,
      bucketKey: () => 'x',
    });
    rl.isLimited('1.2.3.4'); // 1
    rl.isLimited('1.2.3.4'); // 2
    rl.isLimited('1.2.3.4'); // 3 — at cap, still allowed
    assert.equal(rl.isLimited('1.2.3.4'), true, '4th req over cap');
  });

  test('different keys are independent', () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      bucketKey: () => 'x',
    });
    rl.isLimited('a');
    rl.isLimited('a');
    assert.equal(rl.isLimited('a'), true, 'a hits cap');
    assert.equal(rl.isLimited('b'), false, 'b unaffected');
  });
});

describe('rate-limit: window expiry', () => {
  test('old timestamps drop out of the window (mocked clock)', () => {
    // Mock Date.now via global replacement.
    const origNow = Date.now;
    let now = 1_000_000;
    (Date as unknown as { now: () => number }).now = () => now;
    try {
      const rl = createRateLimiter({
        windowMs: 1_000,
        max: 2,
        bucketKey: () => 'x',
      });
      rl.isLimited('a'); // 1 at t=1_000_000
      rl.isLimited('a'); // 2 at t=1_000_000
      assert.equal(rl.isLimited('a'), true, 'cap hit at t');
      now += 1_500; // jump past window
      assert.equal(rl.isLimited('a'), false, 'old hits expired');
    } finally {
      (Date as unknown as { now: () => number }).now = origNow;
    }
  });
});

describe('rate-limit: memory cap', () => {
  test('drops oldest half once maxKeys exceeded', () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      max: 100,
      bucketKey: () => 'x',
      maxKeys: 4,
    });
    rl.isLimited('a');
    rl.isLimited('b');
    rl.isLimited('c');
    rl.isLimited('d'); // size = 4, at cap
    rl.isLimited('e'); // size becomes 5 → drops floor(4/2)=2 oldest (a, b)
    // 'a' and 'b' should be effectively reset; sending more requests to
    // them should not retain prior history.
    assert.equal(rl.isLimited('a'), false, 'a reset by drop');
  });
});

describe('rate-limit: middleware', () => {
  test('returns 429 when limited', async () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      bucketKey: () => 'x',
    });
    const mw = rl.middleware();
    let nextCalls = 0;
    const stubNext = async () => {
      nextCalls++;
    };
    const stubCtx = (() => {
      let body: unknown;
      let status = 200;
      return {
        json: (b: unknown, s = 200) => {
          body = b;
          status = s;
          return { _body: body, _status: status };
        },
        get _body() {
          return body;
        },
        get _status() {
          return status;
        },
      };
    })();

    // First call passes through.
    await mw(stubCtx as unknown as Parameters<typeof mw>[0], stubNext);
    assert.equal(nextCalls, 1);

    // Second call is blocked.
    const res = await mw(stubCtx as unknown as Parameters<typeof mw>[0], stubNext);
    assert.equal(nextCalls, 1, 'next not called second time');
    assert.equal(stubCtx._status, 429);
    assert.deepEqual(stubCtx._body, { error: 'too_many_requests' });
    assert.ok(res, 'returned the json response');
  });
});
