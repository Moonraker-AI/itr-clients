/**
 * Stripe webhook handler (DESIGN.md §16 + §6).
 *
 *   POST /api/webhooks/stripe
 *
 * Endpoint MUST be configured in Stripe with the same `stripe-webhook-secret`
 * value bound to STRIPE_WEBHOOK_SECRET on Cloud Run. Without that secret,
 * the wrapper rejects every event and we 400.
 *
 * No PHI on logs. The redactor would scrub it anyway, but we deliberately
 * never log raw event bodies — only event type + retreat_id + payment_intent
 * id resolved through metadata.
 *
 * Endpoint is publicly reachable (signature is the auth). The Cloud Run
 * service still requires IAM auth at the GFE — Stripe webhook traffic
 * needs the service to also accept unauthenticated calls. We work around
 * this by gating *only* `/api/webhooks/stripe` via a future
 * `--allow-unauthenticated` change, OR by routing webhooks through an
 * intermediate (Cloud Functions / Cloud Run sidecar). For now we register
 * the handler; production-mode public reachability lands when Stripe is
 * pointed at the URL during cutover.
 */

import { Hono } from 'hono';
import type Stripe from 'stripe';

import { log } from '../../lib/phi-redactor.js';
import { verifyWebhookSignature } from '../../lib/stripe.js';
import { transitions } from '../../lib/state-machine.js';

export const stripeWebhookRoute = new Hono();

stripeWebhookRoute.post('/', async (c) => {
  const sig = c.req.header('stripe-signature');
  if (!sig) {
    log.error('stripe_webhook_missing_signature_header', {});
    return c.json({ error: 'missing_signature' }, 400);
  }

  // Hono returns the body as text on demand without parsing.
  // verifyWebhookSignature needs the raw bytes Stripe signed.
  const rawBody = await c.req.text();
  const event = verifyWebhookSignature({ rawBody, signatureHeader: sig });
  if (!event) {
    return c.json({ error: 'invalid_signature' }, 400);
  }

  log.info('stripe_webhook_received', {
    type: event.type,
    eventId: event.id,
  });

  try {
    await dispatch(event);
  } catch (err) {
    // Non-2xx tells Stripe to retry. Throw selectively only for transient
    // failures; for malformed events we log + 200 to avoid an infinite
    // retry loop on something we can't process.
    log.error('stripe_webhook_dispatch_failed', {
      type: event.type,
      eventId: event.id,
      error: (err as Error).message,
    });
    return c.json({ error: 'dispatch_failed' }, 500);
  }

  return c.json({ ok: true });
});

async function dispatch(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata ?? {};
      const retreatId = meta['retreat_id'];
      const paymentKind = meta['payment_kind'];
      if (!retreatId) {
        log.warn('stripe_webhook_missing_retreat_id', { type: event.type });
        return;
      }
      if (paymentKind !== 'deposit') {
        log.info('stripe_webhook_skipped_non_deposit', {
          type: event.type,
          paymentKind,
        });
        return;
      }
      if (session.payment_status !== 'paid') {
        log.info('stripe_webhook_session_not_paid', {
          retreatId,
          paymentStatus: session.payment_status,
        });
        return;
      }
      const piId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
      if (!piId) {
        log.warn('stripe_webhook_session_no_payment_intent', { retreatId });
        return;
      }
      await transitions.markDepositPaid({
        retreatId,
        actor: { kind: 'stripe', eventId: event.id },
        stripePaymentIntentId: piId,
        amountCents: session.amount_total ?? 0,
      });
      return;
    }
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
      // Final-charge handling lands in M5 (off-session charge) + M6
      // (recovery). For deposit paths the checkout.session.completed
      // event above is authoritative.
      log.info('stripe_webhook_event_acked_no_op_yet', { type: event.type });
      return;
    default:
      log.info('stripe_webhook_event_ignored', { type: event.type });
      return;
  }
}
