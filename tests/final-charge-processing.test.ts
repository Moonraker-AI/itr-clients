/**
 * mapPaymentIntent: Stripe PI status → FinalChargeStatus mapping.
 *
 * Regression suite for the ACH double-charge bug (v0.29.x): a PI in
 * `processing` (delayed bank-debit settlement) was mapped to `failed`,
 * which flipped the retreat to final_charge_failed while Stripe showed
 * Pending, and primed the retry cron to mint a second debit 24h later.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import type Stripe from 'stripe';

import { mapPaymentIntent } from '../src/lib/stripe.ts';

function pi(overrides: Partial<Stripe.PaymentIntent>): Stripe.PaymentIntent {
  return {
    id: 'pi_test_123',
    latest_charge: 'ch_test_123',
    client_secret: 'pi_test_123_secret',
    last_payment_error: null,
    ...overrides,
  } as Stripe.PaymentIntent;
}

describe('stripe: mapPaymentIntent', () => {
  test('succeeded → succeeded with charge id', () => {
    const out = mapPaymentIntent(pi({ status: 'succeeded' }));
    assert.equal(out.status, 'succeeded');
    assert.equal(out.paymentIntentId, 'pi_test_123');
    assert.equal(out.chargeId, 'ch_test_123');
    assert.equal(out.failureCode, null);
  });

  test('processing (ACH in flight) → processing, NOT failed', () => {
    const out = mapPaymentIntent(pi({ status: 'processing' }));
    assert.equal(out.status, 'processing');
    assert.equal(out.chargeId, 'ch_test_123');
    assert.equal(out.failureCode, null);
    assert.equal(out.failureMessage, null);
  });

  test('requires_action → requires_action with client_secret', () => {
    const out = mapPaymentIntent(pi({ status: 'requires_action' }));
    assert.equal(out.status, 'requires_action');
    assert.equal(out.clientSecret, 'pi_test_123_secret');
  });

  test('requires_confirmation → requires_action', () => {
    const out = mapPaymentIntent(pi({ status: 'requires_confirmation' }));
    assert.equal(out.status, 'requires_action');
  });

  test('requires_payment_method (decline) → failed with error surfaced', () => {
    const out = mapPaymentIntent(
      pi({
        status: 'requires_payment_method',
        last_payment_error: {
          code: 'card_declined',
          message: 'Your card was declined.',
        } as Stripe.PaymentIntent.LastPaymentError,
      }),
    );
    assert.equal(out.status, 'failed');
    assert.equal(out.failureCode, 'card_declined');
    assert.equal(out.failureMessage, 'Your card was declined.');
  });

  test('canceled → failed with status as fallback failure code', () => {
    const out = mapPaymentIntent(pi({ status: 'canceled' }));
    assert.equal(out.status, 'failed');
    assert.equal(out.failureCode, 'canceled');
  });

  test('expanded latest_charge object → charge id extracted', () => {
    const out = mapPaymentIntent(
      pi({
        status: 'processing',
        latest_charge: { id: 'ch_expanded_9' } as Stripe.Charge,
      }),
    );
    assert.equal(out.chargeId, 'ch_expanded_9');
  });
});
