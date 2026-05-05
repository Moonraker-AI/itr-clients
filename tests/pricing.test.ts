import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  cancellationRefundCents,
  computePrice,
  formatCents,
} from '../src/lib/pricing.ts';

describe('pricing: computePrice — happy paths', () => {
  // Pricing model (DESIGN §6): the rate sheet is the ACH price. Card pays an
  // uplift to absorb Stripe's processor fee. Affirm uplift is informational
  // only on the public-facing breakdown.

  test('2 full-day ACH retreat — pays the rate sheet', () => {
    const result = computePrice({
      fullDayRateCents: 100_000, // $1000 ACH
      halfDayRateCents: null,
      plannedFullDays: 2,
      plannedHalfDays: 0,
      achDiscountPct: 0.03,
      affirmUpliftPct: 0.1,
      paymentMethod: 'ach',
    });
    assert.equal(result.achTotalCents, 200_000);
    assert.equal(result.totalCents, 200_000);
  });

  test('card payment uplifts to cover the discount gap', () => {
    const result = computePrice({
      fullDayRateCents: 100_000,
      halfDayRateCents: null,
      plannedFullDays: 2,
      plannedHalfDays: 0,
      achDiscountPct: 0.03,
      affirmUpliftPct: 0.1,
      paymentMethod: 'card',
    });
    // ach = 200_000; cc = round(200_000 / 0.97) = 206_186
    assert.equal(result.ccTotalCents, 206_186);
    assert.equal(result.totalCents, 206_186);
  });

  test('mixed full + half day, ACH', () => {
    const result = computePrice({
      fullDayRateCents: 100_000,
      halfDayRateCents: 60_000,
      plannedFullDays: 1,
      plannedHalfDays: 1,
      achDiscountPct: 0.03,
      affirmUpliftPct: 0.1,
      paymentMethod: 'ach',
    });
    // 1×$1000 + 1×$600 = $1600 ACH
    assert.equal(result.achTotalCents, 160_000);
    assert.equal(result.totalCents, 160_000);
  });

  test('affirm uplift is informational and not used as totalCents', () => {
    const result = computePrice({
      fullDayRateCents: 100_000,
      halfDayRateCents: null,
      plannedFullDays: 2,
      plannedHalfDays: 0,
      achDiscountPct: 0.03,
      affirmUpliftPct: 0.1,
      paymentMethod: 'ach',
    });
    // affirmTotalCents = round(200_000 × 1.10) = 220_000, but totalCents
    // for ach payment is still the ACH base.
    assert.equal(result.affirmTotalCents, 220_000);
    assert.equal(result.totalCents, 200_000);
  });
});

describe('pricing: computePrice — guard rails', () => {
  test('rejects negative day counts', () => {
    assert.throws(() =>
      computePrice({
        fullDayRateCents: 100_000,
        halfDayRateCents: null,
        plannedFullDays: -1,
        plannedHalfDays: 0,
        achDiscountPct: 0.03,
        affirmUpliftPct: 0.1,
        paymentMethod: 'ach',
      }),
      /non-negative/,
    );
  });

  test('half-day requested without therapist half-day rate throws', () => {
    assert.throws(() =>
      computePrice({
        fullDayRateCents: 100_000,
        halfDayRateCents: null,
        plannedFullDays: 0,
        plannedHalfDays: 1,
        achDiscountPct: 0.03,
        affirmUpliftPct: 0.1,
        paymentMethod: 'ach',
      }),
      /half-day rate/,
    );
  });

  test('rejects out-of-range ACH discount', () => {
    assert.throws(() =>
      computePrice({
        fullDayRateCents: 100_000,
        halfDayRateCents: null,
        plannedFullDays: 1,
        plannedHalfDays: 0,
        achDiscountPct: 1.5,
        affirmUpliftPct: 0.1,
        paymentMethod: 'ach',
      }),
      /ach_discount_pct/,
    );
    assert.throws(() =>
      computePrice({
        fullDayRateCents: 100_000,
        halfDayRateCents: null,
        plannedFullDays: 1,
        plannedHalfDays: 0,
        achDiscountPct: -0.01,
        affirmUpliftPct: 0.1,
        paymentMethod: 'ach',
      }),
      /ach_discount_pct/,
    );
  });
});

describe('pricing: formatCents', () => {
  test('whole dollars', () => {
    assert.equal(formatCents(100_000), '$1,000.00');
  });
  test('cents present', () => {
    assert.equal(formatCents(123_456), '$1,234.56');
  });
  test('zero', () => {
    assert.equal(formatCents(0), '$0.00');
  });
});

describe('pricing: cancellationRefundCents', () => {
  test('outside 3-week window: deposit minus admin fee', () => {
    const refund = cancellationRefundCents({
      depositCents: 100_000,
      cancellationAdminFeeCents: 10_000,
      weeksUntilStart: 4,
    });
    assert.equal(refund, 90_000);
  });

  test('inside 3-week window: deposit forfeit (zero refund)', () => {
    const refund = cancellationRefundCents({
      depositCents: 100_000,
      cancellationAdminFeeCents: 10_000,
      weeksUntilStart: 2,
    });
    assert.equal(refund, 0);
  });

  test('admin fee > deposit clamps to zero (never negative)', () => {
    const refund = cancellationRefundCents({
      depositCents: 5_000,
      cancellationAdminFeeCents: 10_000,
      weeksUntilStart: 4,
    });
    assert.equal(refund, 0);
  });

  test('boundary: exactly 3 weeks gets the refund', () => {
    const refund = cancellationRefundCents({
      depositCents: 100_000,
      cancellationAdminFeeCents: 10_000,
      weeksUntilStart: 3,
    });
    assert.equal(refund, 90_000);
  });
});
