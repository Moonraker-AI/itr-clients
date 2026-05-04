/**
 * Public payment-recovery flows (DESIGN.md §6 + §10, M6).
 *
 *   GET /c/:token/update-payment      → Stripe Customer Portal redirect
 *                                       so the client can swap cards.
 *   GET /c/:token/payment-updated     → static landing page after portal.
 *   GET /c/:token/confirm-payment     → 3DS hosted-confirmation flow for
 *                                       a `requires_action` final-charge
 *                                       outcome.
 *
 * Token-gated; no auth.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
  retreats,
  stripeCustomers,
} from '../../db/schema.js';
import { createPortalSession } from '../../lib/stripe.js';
import { log } from '../../lib/phi-redactor.js';

export const publicPaymentRoute = new Hono();

publicPaymentRoute.get('/:token/update-payment', async (c) => {
  const token = c.req.param('token');
  const { db } = await getDb();
  const [r] = await db
    .select({
      retreatId: retreats.id,
      clientId: retreats.clientId,
      state: retreats.state,
    })
    .from(retreats)
    .where(eq(retreats.clientToken, token));
  if (!r) return c.notFound();

  const [sc] = await db
    .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, r.clientId));
  if (!sc) {
    return c.text(
      'No Stripe customer on file yet. Please complete the deposit first.',
      400,
    );
  }

  const base =
    process.env.PUBLIC_BASE_URL ?? `${c.req.url.split('/c/')[0]}`;
  const session = await createPortalSession({
    stripeCustomerId: sc.stripeCustomerId,
    returnUrl: `${base}/c/${token}/payment-updated`,
  });

  log.info('portal_session_created', {
    retreatId: r.retreatId,
    dryRun: session.dryRun,
  });
  return c.redirect(session.url);
});

publicPaymentRoute.get('/:token/payment-updated', async (c) => {
  const token = c.req.param('token');
  const { db } = await getDb();
  const [r] = await db
    .select({ id: retreats.id })
    .from(retreats)
    .where(eq(retreats.clientToken, token));
  if (!r) return c.notFound();

  return c.html(`<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Payment method updated — Intensive Therapy Retreats</title>
  <style>
    body { font: 16px system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-weight: 600; }
  </style>
</head>
<body>
  <h1>Payment method updated</h1>
  <p>Thank you. Your saved payment method has been updated. Our team will retry the outstanding charge automatically within 24 hours.</p>
  <p>If you have questions, reply to the email you received from us and our team will be in touch.</p>
</body>
</html>`);
});

publicPaymentRoute.get('/:token/confirm-payment', async (c) => {
  const token = c.req.param('token');
  const { db } = await getDb();
  const [r] = await db
    .select({ id: retreats.id, state: retreats.state })
    .from(retreats)
    .where(eq(retreats.clientToken, token));
  if (!r) return c.notFound();

  if (r.state !== 'final_charge_failed') {
    // Nothing to confirm. Show a benign page rather than leaking state.
    return c.html(renderNothingToConfirm());
  }

  // Look up the most recent final_charge_failed audit row to recover the
  // captured client_secret. Older rows from prior retries may not have it.
  const failedRows = await db
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.retreatId, r.id),
        eq(auditEvents.eventType, 'final_charge_failed'),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(5);

  let clientSecret: string | null = null;
  for (const row of failedRows) {
    const payload = row.payload as Record<string, unknown> | null;
    const secret = payload?.['requires_action_client_secret'];
    if (typeof secret === 'string' && secret.length > 0) {
      clientSecret = secret;
      break;
    }
  }
  if (!clientSecret) return c.html(renderNothingToConfirm());

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    log.warn('confirm_payment_publishable_key_unset', { retreatId: r.id });
    return c.html(renderConfigPending());
  }

  return c.html(renderConfirmPaymentPage({
    publishableKey,
    clientSecret,
    returnUrl: `${process.env.PUBLIC_BASE_URL ?? c.req.url.split('/c/')[0]}/c/${token}/payment-updated`,
  }));
});

function renderNothingToConfirm(): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Nothing to confirm — Intensive Therapy Retreats</title>
  <style>body { font: 16px system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }</style>
</head>
<body>
  <h1>No pending payment confirmation</h1>
  <p>There's nothing to confirm right now. If you received an email asking you to confirm a payment, please reply to that email so our team can help.</p>
</body>
</html>`;
}

function renderConfigPending(): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Setup pending — Intensive Therapy Retreats</title>
  <style>body { font: 16px system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }</style>
</head>
<body>
  <h1>Setup pending</h1>
  <p>The hosted payment confirmation page is not fully configured yet. Please reply to the email you received and our team will complete this manually.</p>
</body>
</html>`;
}

function renderConfirmPaymentPage(args: {
  publishableKey: string;
  clientSecret: string;
  returnUrl: string;
}): string {
  // The publishable key is safe to ship to the browser by Stripe design.
  // The client_secret is also designed to be safe in the browser context
  // — it's scoped to a single PaymentIntent.
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Confirm your payment — Intensive Therapy Retreats</title>
  <style>
    body { font: 16px system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    button { padding: 0.6rem 1.2rem; cursor: pointer; font: inherit; }
    .err { color: #a00; margin-top: 1rem; }
  </style>
  <script src="https://js.stripe.com/v3/"></script>
</head>
<body>
  <h1>Confirm your payment</h1>
  <p>Your bank requires an extra verification step before we can complete the charge. Click the button below to confirm — you may be asked to authenticate with your bank.</p>
  <button id="confirm"
    data-publishable-key="${escAttr(args.publishableKey)}"
    data-client-secret="${escAttr(args.clientSecret)}"
    data-return-url="${escAttr(args.returnUrl)}">Confirm payment</button>
  <p id="status" class="err"></p>
  <script>
    // Read config from data-attributes (M9 fix #6) — avoids </script>
    // injection in inline JS literals.
    const btn = document.getElementById('confirm');
    const stripe = Stripe(btn.dataset.publishableKey);
    const clientSecret = btn.dataset.clientSecret;
    const returnUrl = btn.dataset.returnUrl;
    const status = document.getElementById('status');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.textContent = 'Confirming…';
      const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret);
      if (error) {
        status.textContent = error.message ?? 'Confirmation failed.';
        btn.disabled = false;
        return;
      }
      if (paymentIntent && paymentIntent.status === 'succeeded') {
        window.location.href = returnUrl;
        return;
      }
      status.textContent = 'Confirmation pending. We will email you when it completes.';
    });
  </script>
</body>
</html>`;
}

function escAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
