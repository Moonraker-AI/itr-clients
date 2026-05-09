import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  buildConnectParams,
  estimateStripeFeeCents,
} from '../src/lib/stripe.ts';

describe('estimateStripeFeeCents', () => {
  test('zero gross → zero fee (skip the +30¢ flat)', () => {
    assert.equal(estimateStripeFeeCents(0), 0);
  });

  test('negative gross → zero (defensive)', () => {
    assert.equal(estimateStripeFeeCents(-100), 0);
  });

  test('$1.00 charge → 30¢ flat + 3¢ pct = 33¢', () => {
    // 100 * 290 / 10000 = 2.9 → round 3
    assert.equal(estimateStripeFeeCents(100), 33);
  });

  test('$10.00 → 30¢ + 29¢ = 59¢', () => {
    assert.equal(estimateStripeFeeCents(1_000), 59);
  });

  test('$1000.00 → 30¢ + $29 = $29.30', () => {
    assert.equal(estimateStripeFeeCents(100_000), 2_930);
  });

  test('$10_000.00 → 30¢ + $290 = $290.30', () => {
    assert.equal(estimateStripeFeeCents(1_000_000), 29_030);
  });

  test('rounds half-cent fee correctly', () => {
    // 1750 * 290 / 10000 = 50.75 → rounds to 51
    assert.equal(estimateStripeFeeCents(1_750), 81);
  });
});

describe('buildConnectParams: legacy + invalid input', () => {
  test('NULL connect id → no destination, no app fee', () => {
    const r = buildConnectParams({
      connectAccountId: null,
      payoutPct: 60,
      amountCents: 100_000,
    });
    assert.equal(r.transferData, null);
    assert.equal(r.applicationFeeAmount, null);
  });

  test('connect set but pct missing → throws', () => {
    assert.throws(
      () =>
        buildConnectParams({
          connectAccountId: 'acct_xxx',
          payoutPct: null,
          amountCents: 100_000,
        }),
      /payoutPct required/,
    );
  });

  test('pct out of range (negative) → throws', () => {
    assert.throws(
      () =>
        buildConnectParams({
          connectAccountId: 'acct_xxx',
          payoutPct: -1,
          amountCents: 100_000,
        }),
      /out of range/,
    );
  });

  test('pct out of range (>100) → throws', () => {
    assert.throws(
      () =>
        buildConnectParams({
          connectAccountId: 'acct_xxx',
          payoutPct: 101,
          amountCents: 100_000,
        }),
      /out of range/,
    );
  });

  test('pct accepts numeric strings (drizzle numeric type)', () => {
    const r = buildConnectParams({
      connectAccountId: 'acct_xxx',
      payoutPct: '60',
      amountCents: 100_000,
    });
    assert.equal(r.transferData?.destination, 'acct_xxx');
    assert.ok((r.applicationFeeAmount ?? 0) > 0);
  });
});

describe('buildConnectParams: 60/40 split with fee deduction', () => {
  // gross 100000 → fee 2930 → net 97070
  // therapist 60% = floor(97070 * 60 / 100) = 58242
  // app_fee = 100000 - 58242 = 41758
  test('$1000 at 60% — therapist gets 58242, app fee 41758', () => {
    const r = buildConnectParams({
      connectAccountId: 'acct_amy',
      payoutPct: 60,
      amountCents: 100_000,
    });
    assert.equal(r.transferData?.destination, 'acct_amy');
    assert.equal(r.applicationFeeAmount, 41_758);
    // implicit transfer = 100000 - 41758 = 58242
    const transfer = 100_000 - (r.applicationFeeAmount ?? 0);
    assert.equal(transfer, 58_242);
  });

  test('platform retains pct of NET cleanly after Stripe fee', () => {
    // app_fee 41758 minus est Stripe fee 2930 = 38828
    // 40% of net 97070 = 38828 ✓
    const r = buildConnectParams({
      connectAccountId: 'acct_amy',
      payoutPct: 60,
      amountCents: 100_000,
    });
    const platformNet = (r.applicationFeeAmount ?? 0) - 2_930;
    const expectedNet40 = Math.floor((100_000 - 2_930) * 0.4);
    assert.equal(platformNet, expectedNet40);
  });
});

describe('buildConnectParams: Bambi 100% special case', () => {
  // gross 100000 → fee 2930 → net 97070
  // therapist 100% = 97070, app_fee = 100000 - 97070 = 2930
  // platform absorbs nothing; Stripe fee comes out of the 2930 app_fee
  test('$1000 at 100% — therapist gets 97070 (NET), app fee == est fee', () => {
    const r = buildConnectParams({
      connectAccountId: 'acct_bambi',
      payoutPct: 100,
      amountCents: 100_000,
    });
    assert.equal(r.applicationFeeAmount, 2_930);
    const transfer = 100_000 - (r.applicationFeeAmount ?? 0);
    assert.equal(transfer, 97_070);
  });

  test('platform nets ~0 after Stripe deducts its fee', () => {
    const r = buildConnectParams({
      connectAccountId: 'acct_bambi',
      payoutPct: 100,
      amountCents: 100_000,
    });
    const platformNet = (r.applicationFeeAmount ?? 0) - 2_930;
    assert.equal(platformNet, 0);
  });
});

describe('buildConnectParams: edge cases', () => {
  test('pct = 0 → therapist gets nothing, app_fee == gross (clamped)', () => {
    const r = buildConnectParams({
      connectAccountId: 'acct_xxx',
      payoutPct: 0,
      amountCents: 100_000,
    });
    // therapist_share = floor(net * 0 / 100) = 0
    // app_fee = 100000 - 0 = 100000 (clamp at gross satisfied trivially)
    assert.equal(r.applicationFeeAmount, 100_000);
  });

  test('tiny charge: $1 at 60% — app fee never exceeds gross', () => {
    // gross 100, fee 33, net 67, therapist 60%=floor(67*0.6)=40
    // app_fee = 100 - 40 = 60
    const r = buildConnectParams({
      connectAccountId: 'acct_xxx',
      payoutPct: 60,
      amountCents: 100,
    });
    assert.equal(r.applicationFeeAmount, 60);
    assert.ok((r.applicationFeeAmount ?? 0) <= 100);
  });

  test('$0.50 at 60% — sub-fee charge: net floors to 0', () => {
    // gross 50, fee 32 (round 1.45→1 + 30), net 18, therapist 60%=10
    // app_fee = 50 - 10 = 40
    const r = buildConnectParams({
      connectAccountId: 'acct_xxx',
      payoutPct: 60,
      amountCents: 50,
    });
    assert.ok((r.applicationFeeAmount ?? 0) <= 50);
    assert.ok((r.applicationFeeAmount ?? 0) >= 0);
  });

  test('floor on therapist share (not round) — never short-pays', () => {
    // 7777 gross, fee = round(7777*290/10000)+30 = 226+30 = 256
    // net = 7521, therapist 60% = floor(7521*0.6) = floor(4512.6) = 4512
    // app_fee = 7777 - 4512 = 3265
    const r = buildConnectParams({
      connectAccountId: 'acct_xxx',
      payoutPct: 60,
      amountCents: 7_777,
    });
    assert.equal(r.applicationFeeAmount, 3_265);
  });

  test('fractional pct (75.5) — floors therapist share', () => {
    // gross 100000, fee 2930, net 97070
    // therapist 75.5% = floor(97070 * 75.5 / 100) = floor(73287.85) = 73287
    // app_fee = 100000 - 73287 = 26713
    const r = buildConnectParams({
      connectAccountId: 'acct_xxx',
      payoutPct: 75.5,
      amountCents: 100_000,
    });
    assert.equal(r.applicationFeeAmount, 26_713);
  });
});
