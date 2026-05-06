/**
 * Public payment-recovery flows (DESIGN.md §6 + §10, M6).
 *
 *   GET /c/:token/update-payment      → Stripe Customer Portal redirect
 *   GET /c/:token/payment-updated     → static landing page after portal
 *   GET /c/:token/confirm-payment     → 3DS hosted-confirmation flow
 *
 * Token-gated; no auth.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, retreats, stripeCustomers } from '../../db/schema.js';
import { createPortalSession } from '../../lib/stripe.js';
import { log } from '../../lib/phi-redactor.js';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ClientShell,
  Layout,
} from '../../lib/ui/index.js';

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
    return c.text('No Stripe customer on file yet. Please complete the deposit first.', 400);
  }

  const base = process.env.PUBLIC_BASE_URL ?? `${c.req.url.split('/c/')[0]}`;
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

  return c.html(
    <Layout title="Payment method updated — Intensive Therapy Retreats">
      <ClientShell>
        <Card>
          <CardHeader>
            <CardTitle>Payment method updated</CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <p>
              Thank you. Your saved payment method has been updated. Our team will retry the outstanding
              charge automatically within 24 hours.
            </p>
            <p>
              If you have questions, reply to the email you received from us and our team will be in
              touch.
            </p>
          </CardContent>
        </Card>
      </ClientShell>
    </Layout>,
  );
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
    return c.html(renderNothingToConfirm());
  }

  // Look up the most recent final_charge_failed audit row to recover the
  // captured client_secret. Older retries may not have it.
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

  return c.html(
    renderConfirmPaymentPage({
      publishableKey,
      clientSecret,
      returnUrl: `${process.env.PUBLIC_BASE_URL ?? c.req.url.split('/c/')[0]}/c/${token}/payment-updated`,
    }),
  );
});

function renderNothingToConfirm() {
  return (
    <Layout title="Nothing to confirm — Intensive Therapy Retreats">
      <ClientShell>
        <Card>
          <CardHeader>
            <CardTitle>No pending payment confirmation</CardTitle>
          </CardHeader>
          <CardContent class="text-sm">
            <p>
              There's nothing to confirm right now. If you received an email asking you to confirm a
              payment, please reply to that email so our team can help.
            </p>
          </CardContent>
        </Card>
      </ClientShell>
    </Layout>
  );
}

function renderConfigPending() {
  return (
    <Layout title="Setup pending — Intensive Therapy Retreats">
      <ClientShell>
        <Alert variant="destructive">
          <AlertTitle>Setup pending</AlertTitle>
          <AlertDescription>
            The hosted payment confirmation page is not fully configured yet. Please reply to the email
            you received and our team will complete this manually.
          </AlertDescription>
        </Alert>
      </ClientShell>
    </Layout>
  );
}

function renderConfirmPaymentPage(args: {
  publishableKey: string;
  clientSecret: string;
  returnUrl: string;
}) {
  return (
    <Layout
      title="Confirm your payment — Intensive Therapy Retreats"
      head={<script src="https://js.stripe.com/v3/" />}
    >
      <ClientShell>
        <Card>
          <CardHeader>
            <CardTitle>Confirm your payment</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 text-sm">
            <p>
              Your bank requires an extra verification step before we can complete the charge. Click the
              button below to confirm — you may be asked to authenticate with your bank.
            </p>
            <Button
              id="confirm"
              size="lg"
              data={{
                'publishable-key': args.publishableKey,
                'client-secret': args.clientSecret,
                'return-url': args.returnUrl,
              }}
            >
              Confirm payment
            </Button>
            <p id="status" class="text-sm text-destructive min-h-[1.25rem]"></p>
          </CardContent>
        </Card>
      </ClientShell>
      <script src="/static/js/stripe-confirm.js" defer></script>
    </Layout>
  );
}
