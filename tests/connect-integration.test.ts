/**
 * Stripe Connect destination-charge integration test (opt-in).
 *
 * This test ACTUALLY hits Stripe's test API to confirm that the
 * destination-charge params we generate in `buildConnectParams` are
 * accepted by the live PaymentIntents.create endpoint, and that the
 * resulting PI carries the expected transfer_data + application_fee
 * fields. It's the only test in the suite that proves end-to-end
 * wiring works against the real Stripe API surface.
 *
 * Skipped unless BOTH env vars are set:
 *   STRIPE_TEST_SECRET_KEY=sk_test_...
 *   STRIPE_TEST_CONNECT_ACCOUNT=acct_...
 *
 * The connect account must be a Stripe test-mode connected account on
 * the same platform as the test secret key. Use Stripe's "Create test
 * account" button under Connect → Accounts in test mode.
 *
 * Cleanup: each test cancels the PaymentIntent it creates so charges
 * don't accumulate in the test dashboard.
 */

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  buildConnectParams,
  estimateStripeFeeCents,
} from '../src/lib/stripe.ts';

const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const CONNECT_ACCT = process.env.STRIPE_TEST_CONNECT_ACCOUNT;
const skip = !STRIPE_KEY || !CONNECT_ACCT;
const skipReason = skip
  ? 'Set STRIPE_TEST_SECRET_KEY + STRIPE_TEST_CONNECT_ACCOUNT to run'
  : '';

describe('Stripe Connect integration (opt-in)', { skip: skip ? skipReason : false }, () => {
  test('60/40 — destination charge accepted; PI carries expected fields', async () => {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(STRIPE_KEY!, { apiVersion: '2026-04-22.dahlia' });
    const params = buildConnectParams({
      connectAccountId: CONNECT_ACCT!,
      payoutPct: 60,
      amountCents: 100_000,
    });
    const pi = await stripe.paymentIntents.create({
      amount: 100_000,
      currency: 'usd',
      payment_method_types: ['card'],
      transfer_data: params.transferData ?? undefined,
      application_fee_amount: params.applicationFeeAmount ?? undefined,
    });
    try {
      assert.equal(pi.application_fee_amount, 41_758);
      assert.equal(
        typeof pi.transfer_data?.destination === 'string'
          ? pi.transfer_data.destination
          : pi.transfer_data?.destination?.id,
        CONNECT_ACCT,
      );
      // Sanity: implicit transfer = gross - app_fee
      const expectedTransfer = 100_000 - (pi.application_fee_amount ?? 0);
      assert.equal(expectedTransfer, 58_242);
    } finally {
      await stripe.paymentIntents.cancel(pi.id).catch(() => {});
    }
  });

  test('100% (Bambi) — app_fee == est Stripe fee; full NET to therapist', async () => {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(STRIPE_KEY!, { apiVersion: '2026-04-22.dahlia' });
    const params = buildConnectParams({
      connectAccountId: CONNECT_ACCT!,
      payoutPct: 100,
      amountCents: 100_000,
    });
    const pi = await stripe.paymentIntents.create({
      amount: 100_000,
      currency: 'usd',
      payment_method_types: ['card'],
      transfer_data: params.transferData ?? undefined,
      application_fee_amount: params.applicationFeeAmount ?? undefined,
    });
    try {
      assert.equal(pi.application_fee_amount, estimateStripeFeeCents(100_000));
      const transfer = 100_000 - (pi.application_fee_amount ?? 0);
      assert.equal(transfer, 97_070);
    } finally {
      await stripe.paymentIntents.cancel(pi.id).catch(() => {});
    }
  });

  test('Stripe rejects app_fee > amount (regression: clamp must work)', async () => {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(STRIPE_KEY!, { apiVersion: '2026-04-22.dahlia' });
    // pct = 0 makes app_fee = gross, which Stripe must accept.
    // (If we ever silently overshoot, Stripe returns invalid_request_error.)
    const params = buildConnectParams({
      connectAccountId: CONNECT_ACCT!,
      payoutPct: 0,
      amountCents: 100_000,
    });
    assert.equal(params.applicationFeeAmount, 100_000);
    const pi = await stripe.paymentIntents.create({
      amount: 100_000,
      currency: 'usd',
      payment_method_types: ['card'],
      transfer_data: params.transferData ?? undefined,
      application_fee_amount: params.applicationFeeAmount ?? undefined,
    });
    try {
      assert.equal(pi.application_fee_amount, 100_000);
    } finally {
      await stripe.paymentIntents.cancel(pi.id).catch(() => {});
    }
  });

  test('NULL connect — no transfer_data sent; standard PI', async () => {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(STRIPE_KEY!, { apiVersion: '2026-04-22.dahlia' });
    const params = buildConnectParams({
      connectAccountId: null,
      payoutPct: 60,
      amountCents: 100_000,
    });
    assert.equal(params.transferData, null);
    assert.equal(params.applicationFeeAmount, null);
    const pi = await stripe.paymentIntents.create({
      amount: 100_000,
      currency: 'usd',
      payment_method_types: ['card'],
      // Intentionally do NOT pass transfer_data or application_fee_amount.
    });
    try {
      assert.equal(pi.transfer_data, null);
      assert.equal(pi.application_fee_amount, null);
    } finally {
      await stripe.paymentIntents.cancel(pi.id).catch(() => {});
    }
  });
});
