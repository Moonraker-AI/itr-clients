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
 * never log raw event bodies - only event type + retreat_id + payment_intent
 * id resolved through metadata.
 *
 * Endpoint is publicly reachable (signature is the auth). The Cloud Run
 * service still requires IAM auth at the GFE - Stripe webhook traffic
 * needs the service to also accept unauthenticated calls. We work around
 * this by gating *only* `/api/webhooks/stripe` via a future
 * `--allow-unauthenticated` change, OR by routing webhooks through an
 * intermediate (Cloud Functions / Cloud Run sidecar). For now we register
 * the handler; production-mode public reachability lands when Stripe is
 * pointed at the URL during cutover.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type Stripe from 'stripe';

import { log } from '../../lib/phi-redactor.js';
import { retrievePaymentIntent, verifyWebhookSignature } from '../../lib/stripe.js';
import {
  IllegalTransitionError,
  transitions,
} from '../../lib/state-machine.js';

export const stripeWebhookRoute = new Hono();

// Webhook service is `--allow-unauthenticated`; pre-signature anyone on the
// internet can POST. Cap body at 256 KB (M9 fix #11). Stripe events are
// ~50 KB max; 256 KB is generous and prevents memory exhaustion.
stripeWebhookRoute.post('/', bodyLimit({
  maxSize: 262_144,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
}), async (c) => {
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
    // failures.
    //
    // Stale-event class: an `IllegalTransitionError` means the retreat is
    // no longer in a state that accepts this event (e.g. retreat already
    // cancelled, or the handler-side path already advanced state and the
    // webhook-redundant ack is racing). Retrying for ~3 days won't change
    // that. Log + 200 (M9 fix #4).
    //
    // Everything else is treated as transient and 500'd so Stripe retries.
    if (err instanceof IllegalTransitionError) {
      log.warn('stripe_webhook_stale_event_acked', {
        type: event.type,
        eventId: event.id,
        from: err.from,
        to: err.to,
      });
      return c.json({ ok: true, stale: true });
    }
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
      // Stripe webhook events deliver `payment_intent` as just an id; fetch
      // the full PI to surface payment_method + latest_charge for M5's
      // off-session charge path.
      const pi = await retrievePaymentIntent(piId);
      let stripeChargeId: string | undefined;
      if (pi) {
        if (typeof pi.latest_charge === 'string') stripeChargeId = pi.latest_charge;
        else if (pi.latest_charge) stripeChargeId = pi.latest_charge.id;
      }
      let paymentMethodId: string | undefined;
      let paymentMethodType: string | undefined;
      if (pi) {
        if (typeof pi.payment_method === 'string') {
          paymentMethodId = pi.payment_method;
        } else if (pi.payment_method) {
          paymentMethodId = pi.payment_method.id;
          paymentMethodType = pi.payment_method.type;
        }
      }
      await transitions.markDepositPaid({
        retreatId,
        actor: { kind: 'stripe', eventId: event.id },
        stripePaymentIntentId: piId,
        ...(stripeChargeId ? { stripeChargeId } : {}),
        amountCents: session.amount_total ?? 0,
        ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId } : {}),
        ...(paymentMethodType ? { paymentMethodType } : {}),
      });
      return;
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata ?? {};
      const retreatId = meta['retreat_id'];
      const paymentKind = meta['payment_kind'];
      if (paymentKind !== 'final') {
        // Deposit successes are handled via checkout.session.completed.
        log.info('stripe_webhook_pi_succeeded_skipped', { type: event.type, paymentKind });
        return;
      }
      if (!retreatId) {
        log.warn('stripe_webhook_missing_retreat_id', { type: event.type });
        return;
      }
      const chargeId =
        typeof pi.latest_charge === 'string'
          ? pi.latest_charge
          : pi.latest_charge?.id;
      // Idempotent: handler-side success path may have already flipped
      // state to `completed`; markCompleted is a no-op in that case.
      await transitions.markCompleted({
        retreatId,
        actor: { kind: 'stripe', eventId: event.id },
        stripePaymentIntentId: pi.id,
        ...(chargeId ? { stripeChargeId: chargeId } : {}),
        amountCents: pi.amount_received ?? pi.amount,
      });
      return;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata ?? {};
      const retreatId = meta['retreat_id'];
      const paymentKind = meta['payment_kind'];
      if (paymentKind !== 'final') {
        log.info('stripe_webhook_pi_failed_skipped', { type: event.type, paymentKind });
        return;
      }
      if (!retreatId) {
        log.warn('stripe_webhook_missing_retreat_id', { type: event.type });
        return;
      }
      // Derive `attempt` from prior failed payments rows so the M6
      // exhaustion notify fires when the webhook arrives for the 3rd
      // failure (M9 fix #26). Without this, the webhook path always
      // passed attempt=1 and never escalated.
      const attempt = await derivePaymentAttempt(retreatId);
      await transitions.markFinalChargeFailed({
        retreatId,
        actor: { kind: 'stripe', eventId: event.id },
        failureCode: pi.last_payment_error?.code ?? 'unknown',
        failureMessage: pi.last_payment_error?.message ?? '',
        stripePaymentIntentId: pi.id,
        amountCents: pi.amount,
        attempt,
      });
      return;
    }
    case 'transfer.created':
    case 'transfer.updated': {
      // Phase C (v0.26.0). Destination charges create a Transfer
      // automatically at capture; this is our notification that the
      // therapist's share moved off the platform balance into the
      // connected account. We treat it as `paid` immediately because
      // destination-charge transfers are instant - the
      // pending/in_transit states in the enum are reserved for future
      // separate-transfer flows.
      const transfer = event.data.object as Stripe.Transfer;
      await upsertPayoutFromTransfer(transfer, event.id, 'paid');
      return;
    }
    case 'transfer.reversed': {
      const transfer = event.data.object as Stripe.Transfer;
      await upsertPayoutFromTransfer(transfer, event.id, 'reversed');
      return;
    }
    default:
      log.info('stripe_webhook_event_ignored', { type: event.type });
      return;
  }
}

/**
 * Upsert a payouts row from a Stripe Transfer event (Phase C, v0.26.0).
 *
 * Lookup chain to populate FKs:
 *   transfer.destination       → therapists.stripe_connect_account_id (REQUIRED)
 *   transfer.source_transaction → payments.stripe_charge_id            (best-effort)
 *   payments.retreat_id        → retreats                              (best-effort)
 *
 * Idempotent on stripe_transfer_id (UNIQUE). Reruns of the same event
 * just update status - no double-insert.
 *
 * Therapist lookup is REQUIRED: an unrecognised destination account
 * means either a stale connect_id in our DB or someone else's transfer
 * routed through our platform - both warrant a 500 so Stripe retries
 * (and the on-call human notices).
 */
async function upsertPayoutFromTransfer(
  transfer: Stripe.Transfer,
  eventId: string,
  status: 'paid' | 'reversed',
): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const { payments, payouts, therapists } = await import('../../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { db } = await getDb();

  const [therapist] = await db
    .select({ id: therapists.id })
    .from(therapists)
    .where(eq(therapists.stripeConnectAccountId, transfer.destination as string));
  if (!therapist) {
    throw new Error(
      `transfer.destination ${transfer.destination as string} has no matching therapist row`,
    );
  }

  let retreatId: string | null = null;
  let paymentId: string | null = null;
  if (transfer.source_transaction) {
    const chargeId =
      typeof transfer.source_transaction === 'string'
        ? transfer.source_transaction
        : transfer.source_transaction.id;
    const [pmt] = await db
      .select({ id: payments.id, retreatId: payments.retreatId })
      .from(payments)
      .where(eq(payments.stripeChargeId, chargeId));
    if (pmt) {
      retreatId = pmt.retreatId;
      paymentId = pmt.id;
    } else {
      // Race: payments row not yet written by our deposit/final-charge
      // path. NULL FKs let the row land; a follow-up event (e.g.
      // transfer.reversed) re-resolves them via this same lookup.
      log.warn('stripe_webhook_transfer_no_matching_payment', {
        transferId: transfer.id,
        chargeId,
      });
    }
  }

  await db
    .insert(payouts)
    .values({
      retreatId,
      paymentId,
      therapistId: therapist.id,
      stripeTransferId: transfer.id,
      destinationAccountId: transfer.destination as string,
      amountCents: transfer.amount,
      status,
    })
    .onConflictDoUpdate({
      target: payouts.stripeTransferId,
      set: {
        status,
        ...(retreatId ? { retreatId } : {}),
        ...(paymentId ? { paymentId } : {}),
        updatedAt: new Date(),
      },
    });

  log.info('stripe_webhook_payout_upserted', {
    eventId,
    transferId: transfer.id,
    therapistId: therapist.id,
    status,
    amountCents: transfer.amount,
  });

  if (status === 'reversed') {
    log.warn('stripe_webhook_payout_reversed', {
      eventId,
      transferId: transfer.id,
      therapistId: therapist.id,
      amountCents: transfer.amount,
    });
  }
}

async function derivePaymentAttempt(retreatId: string): Promise<number> {
  const { getDb } = await import('../../db/client.js');
  const { payments } = await import('../../db/schema.js');
  const { and, eq, ne } = await import('drizzle-orm');
  const { db } = await getDb();
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.retreatId, retreatId),
        eq(payments.kind, 'final'),
        ne(payments.status, 'succeeded'),
      ),
    );
  // +1 because this in-flight failure isn't yet recorded.
  return rows.length + 1;
}
