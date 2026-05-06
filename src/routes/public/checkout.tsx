/**
 * Public deposit checkout flow (DESIGN.md §6 deposit flow + §10 routes).
 *
 *   GET /c/:token/checkout          → create Stripe Checkout Session, redirect
 *   GET /c/:token/checkout/success  → post-redirect landing
 *
 * Token-gated; no auth.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, payments, retreats, stripeCustomers } from '../../db/schema.js';
import { formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';
import {
  createDepositCheckoutSession,
  getCheckoutSession,
  upsertCustomer,
} from '../../lib/stripe.js';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ClientShell,
  Layout,
  LinkButton,
} from '../../lib/ui/index.js';

export const publicCheckoutRoute = new Hono();

publicCheckoutRoute.get('/:token/checkout', async (c) => {
  const token = c.req.param('token');
  const ctx = await loadRetreatContextByToken(token);
  if (!ctx) return c.notFound();
  if (ctx.state !== 'awaiting_deposit') {
    return c.redirect(`/c/${token}`);
  }

  const baseUrl = publicBaseUrl(c);
  const successUrl = `${baseUrl}/c/${token}/checkout/success?cs={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/c/${token}`;

  const { db } = await getDb();
  const [existing] = await db
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, ctx.clientId));

  const upsertArgs: Parameters<typeof upsertCustomer>[0] = {
    clientId: ctx.clientId,
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    email: ctx.email,
  };
  if (existing) upsertArgs.existingStripeCustomerId = existing.stripeCustomerId;

  const customer = await upsertCustomer(upsertArgs);

  if (!existing) {
    await db
      .insert(stripeCustomers)
      .values({
        clientId: ctx.clientId,
        stripeCustomerId: customer.stripeCustomerId,
      })
      .onConflictDoNothing({ target: stripeCustomers.clientId });
  } else if (existing.stripeCustomerId !== customer.stripeCustomerId) {
    await db
      .update(stripeCustomers)
      .set({
        stripeCustomerId: customer.stripeCustomerId,
        updatedAt: new Date(),
      })
      .where(eq(stripeCustomers.clientId, ctx.clientId));
  }

  const session = await createDepositCheckoutSession({
    clientId: ctx.clientId,
    retreatId: ctx.retreatId,
    stripeCustomerId: customer.stripeCustomerId,
    depositCents: ctx.depositCents,
    paymentMethod: 'card',
    successUrl,
    cancelUrl,
  });

  log.info('checkout_session_created', {
    retreatId: ctx.retreatId,
    sessionId: session.sessionId,
    dryRun: session.dryRun,
  });

  return c.redirect(session.url);
});

publicCheckoutRoute.get('/:token/checkout/success', async (c) => {
  const token = c.req.param('token');
  const ctx = await loadRetreatContextByToken(token);
  if (!ctx) return c.notFound();

  const sessionId = c.req.query('cs');
  let paid = false;
  if (sessionId && !sessionId.startsWith('cs_dryrun_')) {
    try {
      const session = await getCheckoutSession(sessionId);
      paid = session?.payment_status === 'paid';
    } catch (err) {
      log.error('checkout_session_lookup_failed', {
        retreatId: ctx.retreatId,
        error: (err as Error).message,
      });
    }
  } else if (sessionId?.startsWith('cs_dryrun_')) {
    paid = true;
  }

  // Pull the latest deposit row (set by the Stripe webhook). May be missing
  // if the success redirect lands before the webhook has been processed —
  // in that case we still show the planned amount + a "processing" status.
  const { db } = await getDb();
  const [depositRow] = await db
    .select({
      amountCents: payments.amountCents,
      status: payments.status,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.retreatId, ctx.retreatId), eq(payments.kind, 'deposit')))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  const depositAmount = depositRow?.amountCents ?? ctx.depositCents;
  const depositStatus = depositRow?.status ?? (paid ? 'pending_webhook' : 'pending');
  const paidAt = depositRow?.createdAt ?? null;

  return c.html(
    <Layout title={`Deposit ${paid ? 'received' : 'pending'} — Intensive Therapy Retreats`}>
      <ClientShell>
        <Card>
          <CardHeader>
            <CardTitle>
              {paid
                ? 'Thanks so much for your deposit! It has been received.'
                : 'Your deposit is processing.'}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 text-sm">
            <p>
              {paid
                ? "Your therapist will confirm your retreat dates next. We'll email you when they do."
                : "We haven't received the payment confirmation yet. Refresh in a moment, or check your email."}
            </p>

            <div class="rounded-md border border-border bg-muted/40 p-4">
              <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                Deposit status
              </div>
              <dl class="grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
                <dt class="text-muted-foreground">Amount</dt>
                <dd class="font-medium">{formatCents(depositAmount)}</dd>
                <dt class="text-muted-foreground">Status</dt>
                <dd>
                  {depositStatus === 'succeeded' ? (
                    <Badge variant="success">received</Badge>
                  ) : depositStatus === 'pending_webhook' ? (
                    <Badge variant="secondary">received · syncing</Badge>
                  ) : depositStatus === 'failed' ? (
                    <Badge variant="destructive">failed</Badge>
                  ) : (
                    <Badge variant="secondary">processing</Badge>
                  )}
                </dd>
                {paidAt ? (
                  <>
                    <dt class="text-muted-foreground">Recorded</dt>
                    <dd>{paidAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</dd>
                  </>
                ) : null}
              </dl>
            </div>

            <LinkButton href={`/c/${token}`} variant="outline">
              Back to retreat status
            </LinkButton>
          </CardContent>
        </Card>
      </ClientShell>
    </Layout>,
  );
});

async function loadRetreatContextByToken(token: string) {
  const { db } = await getDb();
  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      clientId: retreats.clientId,
      depositCents: retreats.depositCents,
      firstName: clients.firstName,
      lastName: clients.lastName,
      email: clients.email,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(eq(retreats.clientToken, token));
  return row ?? null;
}

function publicBaseUrl(c: import('hono').Context): string {
  return process.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin;
}
