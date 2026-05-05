/**
 * Public deposit checkout flow (DESIGN.md §6 deposit flow + §10 routes).
 *
 *   GET /c/:token/checkout          → create Stripe Checkout Session, redirect
 *   GET /c/:token/checkout/success  → post-redirect landing
 *
 * Token-gated; no auth.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, retreats, stripeCustomers } from '../../db/schema.js';
import { log } from '../../lib/phi-redactor.js';
import {
  createDepositCheckoutSession,
  getCheckoutSession,
  upsertCustomer,
} from '../../lib/stripe.js';
import {
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

  return c.html(
    <Layout title={`Deposit ${paid ? 'received' : 'pending'} — Intensive Therapy Retreats`}>
      <ClientShell>
        <Card>
          <CardHeader>
            <CardTitle>
              {paid ? 'Thanks — your deposit is received.' : 'Your deposit is processing.'}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 text-sm">
            <p>
              {paid
                ? "Your therapist will confirm your retreat dates next. We'll email you when they do."
                : "We haven't received the payment confirmation yet. Refresh in a moment, or check your email."}
            </p>
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
